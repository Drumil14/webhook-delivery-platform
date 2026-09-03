import { performance } from "node:perf_hooks";

import {
  completeDeliveryJob,
  deferDeliveryJob,
  finalizeDelivery,
  nextWindowStart,
  prisma,
  tryAcquireEndpointRateLimit,
  type DeliveryAttemptOutcome,
  type DeliveryStatus,
  type FinalizeAttempt,
} from "@webhook/db";
import {
  DEMO_RETRY_POLICY,
  PRODUCTION_RETRY_POLICY,
  MasterKeyError,
  buildSignatureHeader,
  calculateRetryDelay,
  decryptSecret,
  loadMasterKey,
  type JobPayload,
  type RetryPolicy,
} from "@webhook/shared";

import {
  secureWebhookRequest,
  type TransportRequest,
  type TransportResult,
} from "./secure-transport";

// Phase 5: real HTTP delivery + reliability engine (timeout, backoff, jitter,
// Retry-After, retry scheduling, application dead-letter).
// Phase 6: adds the security boundary — HMAC-SHA256 signing of the exact body,
// and an SSRF-safe, DNS-pinned HTTPS transport (redirects still never followed).

const USER_AGENT = "webhook-delivery-platform/0.0.0";

// The real webhook request timeout. The demo /timeout receiver waits 12s, so
// this produces a genuine timeout. Overridable via options for fast tests.
export const WEBHOOK_TIMEOUT_MS = 10_000;

// Phase 7: how long a paused-endpoint job waits before being re-checked. A small
// fixed delay (no backoff/jitter) so we don't hammer Postgres every second.
export const PAUSED_RECHECK_DELAY_MS = 30_000;

// Frozen permanent-failure statuses -> Delivery becomes `dead` immediately.
const PERMANENT_FAILURE_STATUSES = new Set([400, 401, 403, 404, 410]);

// Active policy: demo by default; production only if explicitly selected.
const ACTIVE_POLICY: RetryPolicy =
  process.env.WEBHOOK_RETRY_POLICY === "production"
    ? PRODUCTION_RETRY_POLICY
    : DEMO_RETRY_POLICY;

type DeliveryJob = { id: string; data: JobPayload };

// The outbound transport seam. Production uses the SSRF-safe pinned transport;
// tests inject a deterministic one (plain-HTTP loopback, or a pinned HTTPS server).
export type WebhookTransport = (req: TransportRequest) => Promise<TransportResult>;

export type ProcessDeliveryOptions = {
  policy?: RetryPolicy; // inject a fast policy in tests
  timeoutMs?: number; // inject a short timeout in tests
  now?: () => number; // deterministic nextRetryAt / signature timestamp / rate window in tests
  random?: () => number; // deterministic jitter in tests
  transport?: WebhookTransport; // inject a deterministic transport in tests
  pauseRecheckMs?: number; // inject a short paused-recheck delay in tests
};

function isValidPayload(data: unknown): data is JobPayload {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.deliveryId === "string" &&
    d.deliveryId.length > 0 &&
    typeof d.expectedAttemptNumber === "number" &&
    Number.isInteger(d.expectedAttemptNumber) &&
    d.expectedAttemptNumber >= 1
  );
}

/** Retryable HTTP statuses: 429 and all 5xx. Everything else non-2xx = permanent. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Parse a simple integer-seconds Retry-After header into ms (null if absent/invalid). */
function parseRetryAfterMs(headerValue: string | undefined): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!/^\d+$/.test(trimmed)) return null; // integer seconds only (no HTTP-date)
  return parseInt(trimmed, 10) * 1000;
}

/** Best-effort queue completion outside a transaction (stale / malformed jobs). */
async function safeComplete(jobId: string): Promise<void> {
  try {
    await completeDeliveryJob(jobId);
  } catch (error) {
    console.warn(
      `[worker] Best-effort completion failed for job ${jobId} (may be expired/reassigned):`,
      error
    );
  }
}

/**
 * Process exactly one delivery job: load Delivery -> Event -> Endpoint, decrypt
 * the endpoint signing secret, HMAC-sign the event's EXACT raw body, POST it via
 * the SSRF-safe pinned transport (with a timeout), classify the outcome, then
 * finalize via the guarded transaction — scheduling a retry when appropriate.
 */
export async function processDeliveryJob(
  job: DeliveryJob,
  options: ProcessDeliveryOptions = {}
): Promise<void> {
  const policy = options.policy ?? ACTIVE_POLICY;
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const nowFn = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const transport = options.transport ?? ((req) => secureWebhookRequest(req));
  const pauseRecheckMs = options.pauseRecheckMs ?? PAUSED_RECHECK_DELAY_MS;

  if (!isValidPayload(job.data)) {
    console.error(`[worker] Malformed job ${job.id}; discarding.`, job.data);
    await safeComplete(job.id);
    return;
  }

  const { deliveryId, expectedAttemptNumber } = job.data;

  const delivery = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    include: { event: { include: { endpoint: true } } },
  });
  if (!delivery) {
    console.error(`[worker] Delivery ${deliveryId} not found; discarding job.`);
    await safeComplete(job.id);
    return;
  }
  const event = delivery.event;
  const endpoint = event.endpoint;

  // STALENESS gate (before any pause/rate/security/HTTP work): the guarded
  // finalize protects the commit, but a job whose Delivery is already terminal or
  // has been advanced by a newer attempt should never trigger an HTTP request.
  if (
    delivery.status !== "pending" ||
    delivery.attemptCount !== expectedAttemptNumber - 1
  ) {
    console.warn(
      `[worker] Obsolete job deliveryId=${deliveryId} status=${delivery.status} ` +
        `attemptCount=${delivery.attemptCount} expected=${expectedAttemptNumber}; discarding.`
    );
    await safeComplete(job.id);
    return;
  }

  // Defer this job (no attempt, no attemptCount change) to `deferUntil`, keeping
  // the SAME expectedAttemptNumber. Shared by pause and rate-limit deferral.
  const deferJob = async (reason: "paused" | "rate_limited", deferUntil: Date) => {
    const result = await deferDeliveryJob({
      deliveryId,
      expectedAttemptNumber,
      jobId: job.id,
      deferUntil,
      accountId: event.accountId,
      eventId: event.id,
    });
    if (result === "stale") {
      await safeComplete(job.id);
    }
    console.log(
      `[worker] deferred deliveryId=${deliveryId} expectedAttemptNumber=${expectedAttemptNumber} ` +
        `reason=${reason} deferredUntil=${deferUntil.toISOString()} result=${result}`
    );
  };

  // PAUSE — checked BEFORE consuming rate-limit capacity so a paused endpoint
  // never eats a rate-limit slot. No HTTP, no DeliveryAttempt, no attemptCount change.
  if (endpoint.status === "paused") {
    await deferJob("paused", new Date(nowFn() + pauseRecheckMs));
    return;
  }

  // OUR per-endpoint rate limit (fixed UTC-minute window). Only a request that is
  // actually allowed to proceed consumes a slot. Over budget -> defer to the next
  // window with the SAME expectedAttemptNumber (no attempt consumed).
  const acquisition = await tryAcquireEndpointRateLimit(
    endpoint.id,
    endpoint.rateLimitPerMinute,
    nowFn()
  );
  if (!acquisition.allowed) {
    await deferJob("rate_limited", nextWindowStart(nowFn()));
    return;
  }

  // Base headers (no signature yet). Never include the plaintext signing secret.
  const requestHeaders: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    "x-webhook-event-id": event.id,
    "x-webhook-delivery-id": delivery.id,
  };

  // Decrypt the endpoint signing secret. Fail CLOSED:
  //  - MasterKeyError (missing/malformed server master key) is an OPERATIONAL
  //    problem -> rethrow so the whole job fails and ops can fix the env
  //    (pg-boss infra-retries it). We do NOT mark the delivery dead for an ops error.
  //  - Any other decrypt failure means THIS endpoint's stored value is not a
  //    valid encrypted secret (e.g. a legacy Phase 1 placeholder). That is a
  //    data problem that will never self-heal -> permanent failure, no HTTP.
  let signingSecret: string;
  try {
    const masterKey = loadMasterKey();
    signingSecret = decryptSecret(endpoint.secretEncrypted, masterKey);
  } catch (error) {
    if (error instanceof MasterKeyError) throw error;
    console.error(
      `[worker] Endpoint ${endpoint.id} signing secret could not be decrypted; ` +
        `failing delivery ${deliveryId} permanently.`
    );
    await finalizeTerminal({
      deliveryId,
      expectedAttemptNumber,
      jobId: job.id,
      accountId: event.accountId,
      eventId: event.id,
      requestHeaders,
      errorMessage: "endpoint signing secret unavailable",
      resolvedIp: null,
    });
    return;
  }

  // Fresh timestamp per ATTEMPT (retries re-sign with a new t -> new signature).
  const timestamp = Math.floor(nowFn() / 1000);
  requestHeaders["x-webhook-signature"] = buildSignatureHeader(
    signingSecret,
    timestamp,
    event.payloadRaw // EXACT stored bytes; never parse+re-serialize
  );

  let responseStatus: number | null = null;
  let responseHeaders: Record<string, string> | null = null;
  let responseBodySnippet: string | null = null;
  let errorMessage: string | null = null;
  let outcome: DeliveryAttemptOutcome = "failure";
  let retryable = false;
  let retryAfterMs: number | null = null;
  let resolvedIp: string | null = null;

  const startedAt = performance.now();
  const result = await transport({
    url: endpoint.url,
    headers: requestHeaders,
    body: event.payloadRaw, // exact stored bytes; never re-serialize
    timeoutMs,
  });
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));

  if (result.kind === "response") {
    resolvedIp = result.resolvedIp;
    responseStatus = result.status;
    responseHeaders = result.headers;
    responseBodySnippet = result.bodyText;

    if (result.status >= 200 && result.status < 300) {
      outcome = "success";
      retryable = false;
    } else if (isRetryableStatus(result.status)) {
      outcome = "failure";
      retryable = true;
      if (result.status === 429) {
        retryAfterMs = parseRetryAfterMs(result.headers["retry-after"]);
      }
    } else {
      // Non-2xx, non-retryable: the permanent set {400,401,403,404,410} plus any
      // other 4xx AND 3xx redirects (we never follow redirects, so a 302 lands
      // here). Default: permanent failure -> dead.
      outcome = "failure";
      retryable = false;
      errorMessage = `Permanent failure: HTTP ${result.status}`;
    }
  } else if (result.kind === "ssrf") {
    // Security preflight blocked the socket. This IS an attempt by our delivery
    // system, but no HTTP request was made. Classify as a PERMANENT failure
    // (never network_error) so it does not retry. Keep the message safe/opaque.
    outcome = "failure";
    retryable = false;
    responseStatus = null;
    responseHeaders = null;
    errorMessage = "unsafe endpoint destination";
    resolvedIp = null; // no connection occurred; do not fake a resolvedIp
  } else if (result.kind === "timeout") {
    resolvedIp = result.resolvedIp;
    outcome = "timeout";
    retryable = true;
    errorMessage = `request timed out after ${timeoutMs}ms`;
  } else {
    resolvedIp = result.resolvedIp;
    outcome = "network_error";
    retryable = true;
    errorMessage = result.message;
  }

  // Decide terminal status vs retry.
  let newStatus: DeliveryStatus;
  let nextRetryAt: Date | null = null;
  let retry: { nextExpectedAttemptNumber: number; startAfter: Date } | undefined;

  if (outcome === "success") {
    newStatus = "succeeded";
  } else if (!retryable) {
    newStatus = "dead"; // permanent HTTP / security failure
  } else if (expectedAttemptNumber < delivery.maxAttempts) {
    // Retryable with budget remaining -> schedule next attempt.
    const nextN = expectedAttemptNumber + 1;
    const backoff = calculateRetryDelay({ nextAttemptNumber: nextN, policy, random });
    const delayMs = Math.max(backoff, retryAfterMs ?? 0);
    nextRetryAt = new Date(nowFn() + delayMs);
    newStatus = "pending";
    retry = { nextExpectedAttemptNumber: nextN, startAfter: nextRetryAt };
  } else {
    // Retryable but budget exhausted -> application dead-letter.
    newStatus = "dead";
  }

  const attempt: FinalizeAttempt = {
    requestHeaders,
    responseStatus,
    responseHeaders,
    responseBodySnippet,
    errorMessage,
    durationMs,
    resolvedIp,
    outcome,
  };

  const finalizeResult = await finalizeDelivery({
    deliveryId,
    expectedAttemptNumber,
    jobId: job.id,
    accountId: event.accountId,
    eventId: event.id,
    newStatus,
    nextRetryAt,
    attempt,
    retry,
  });

  if (finalizeResult === "stale") {
    console.warn(
      `[worker] Discarded stale completion: deliveryId=${deliveryId} expectedAttemptNumber=${expectedAttemptNumber}`
    );
    await safeComplete(job.id);
    return;
  }

  console.log(
    `[worker] delivery deliveryId=${deliveryId} attemptNumber=${expectedAttemptNumber} ` +
      `resolvedIp=${resolvedIp ?? "n/a"} httpStatus=${responseStatus ?? "n/a"} durationMs=${durationMs} ` +
      `outcome=${outcome} deliveryStatus=${newStatus} retryScheduled=${retry ? "true" : "false"} ` +
      `nextRetryAt=${nextRetryAt ? nextRetryAt.toISOString() : "null"}`
  );
}

/**
 * Record a permanent (non-HTTP) failure attempt and mark the Delivery dead via
 * the guarded finalize transaction. Used when we cannot even attempt the socket
 * (e.g. the endpoint's signing secret is undecryptable). No retry.
 */
async function finalizeTerminal(args: {
  deliveryId: string;
  expectedAttemptNumber: number;
  jobId: string;
  accountId: string;
  eventId: string;
  requestHeaders: Record<string, string>;
  errorMessage: string;
  resolvedIp: string | null;
}): Promise<void> {
  const attempt: FinalizeAttempt = {
    requestHeaders: args.requestHeaders,
    responseStatus: null,
    responseHeaders: null,
    responseBodySnippet: null,
    errorMessage: args.errorMessage,
    durationMs: 0,
    resolvedIp: args.resolvedIp,
    outcome: "failure",
  };
  const finalizeResult = await finalizeDelivery({
    deliveryId: args.deliveryId,
    expectedAttemptNumber: args.expectedAttemptNumber,
    jobId: args.jobId,
    accountId: args.accountId,
    eventId: args.eventId,
    newStatus: "dead",
    nextRetryAt: null,
    attempt,
  });
  if (finalizeResult === "stale") {
    await safeComplete(args.jobId);
  }
}
