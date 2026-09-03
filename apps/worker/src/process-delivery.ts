import { performance } from "node:perf_hooks";

import {
  completeDeliveryJob,
  finalizeDelivery,
  prisma,
  type DeliveryAttemptOutcome,
  type DeliveryStatus,
  type FinalizeAttempt,
} from "@webhook/db";
import {
  DEMO_RETRY_POLICY,
  PRODUCTION_RETRY_POLICY,
  calculateRetryDelay,
  type JobPayload,
  type RetryPolicy,
} from "@webhook/shared";

// Phase 5: real HTTP delivery + reliability engine (timeout, backoff, jitter,
// Retry-After, retry scheduling, application dead-letter). NO HMAC/SSRF yet.

const USER_AGENT = "webhook-delivery-platform/0.0.0";
const MAX_RESPONSE_SNIPPET_BYTES = 10 * 1024; // ~10 KB cap to avoid DB bloat

// The real webhook request timeout. The demo /timeout receiver waits 12s, so
// this produces a genuine timeout. Overridable via options for fast tests.
export const WEBHOOK_TIMEOUT_MS = 10_000;

// Frozen permanent-failure statuses -> Delivery becomes `dead` immediately.
const PERMANENT_FAILURE_STATUSES = new Set([400, 401, 403, 404, 410]);

// Active policy: demo by default; production only if explicitly selected.
const ACTIVE_POLICY: RetryPolicy =
  process.env.WEBHOOK_RETRY_POLICY === "production"
    ? PRODUCTION_RETRY_POLICY
    : DEMO_RETRY_POLICY;

type DeliveryJob = { id: string; data: JobPayload };

export type ProcessDeliveryOptions = {
  policy?: RetryPolicy; // inject a fast policy in tests
  timeoutMs?: number; // inject a short timeout in tests
  now?: () => number; // deterministic nextRetryAt in tests
  random?: () => number; // deterministic jitter in tests
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
function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!/^\d+$/.test(trimmed)) return null; // integer seconds only (no HTTP-date)
  return parseInt(trimmed, 10) * 1000;
}

/** Read a response body, capped at ~maxBytes, so a huge body can't bloat the DB. */
async function readCappedText(
  response: Response,
  maxBytes: number
): Promise<string | null> {
  if (!response.body) {
    const text = await response.text();
    return text.length > 0 ? text.slice(0, maxBytes) : null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  await reader.cancel().catch(() => {});
  if (total === 0) return null;
  const buffer = Buffer.concat(chunks).subarray(0, maxBytes);
  return new TextDecoder().decode(buffer);
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
 * Process exactly one delivery job: load Delivery -> Event -> Endpoint, POST the
 * event's raw body (with a timeout), classify the outcome, then finalize via the
 * guarded transaction — scheduling a retry when appropriate.
 */
export async function processDeliveryJob(
  job: DeliveryJob,
  options: ProcessDeliveryOptions = {}
): Promise<void> {
  const policy = options.policy ?? ACTIVE_POLICY;
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const nowFn = options.now ?? Date.now;
  const random = options.random ?? Math.random;

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

  // NO HMAC signature yet (Phase 6). No secrets in headers.
  const requestHeaders: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    "x-webhook-event-id": event.id,
    "x-webhook-delivery-id": delivery.id,
  };

  let responseStatus: number | null = null;
  let responseHeaders: Record<string, string> | null = null;
  let responseBodySnippet: string | null = null;
  let errorMessage: string | null = null;
  let outcome: DeliveryAttemptOutcome = "failure";
  let retryable = false;
  let retryAfterMs: number | null = null;

  // HTTP happens OUTSIDE any transaction, with a hard timeout via AbortController.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: requestHeaders,
      body: event.payloadRaw, // exact stored bytes; never re-serialize
      signal: controller.signal,
      // Do NOT follow redirects: we must see the actual 3xx (classified as a
      // permanent failure below), and following a Location would be an SSRF
      // vector that Phase 6 hardens. So the worker never chases redirects.
      redirect: "manual",
    });

    responseStatus = response.status;
    responseHeaders = Object.fromEntries(response.headers);
    responseBodySnippet = await readCappedText(response, MAX_RESPONSE_SNIPPET_BYTES);

    if (response.status >= 200 && response.status < 300) {
      outcome = "success";
      retryable = false;
    } else if (isRetryableStatus(response.status)) {
      outcome = "failure";
      retryable = true;
      if (response.status === 429) {
        retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      }
    } else {
      // Non-2xx, non-retryable: the permanent set {400,401,403,404,410} plus any
      // other 4xx AND 3xx redirects (we use redirect:"manual", so a 302 lands
      // here). Default: permanent failure -> dead. Keeps HTTP semantics simple.
      outcome = "failure";
      retryable = false;
      errorMessage = `Permanent failure: HTTP ${response.status}`;
    }
  } catch (error) {
    if (timedOut) {
      outcome = "timeout";
      errorMessage = `request timed out after ${timeoutMs}ms`;
    } else {
      outcome = "network_error";
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    retryable = true;
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));

  // Decide terminal status vs retry.
  let newStatus: DeliveryStatus;
  let nextRetryAt: Date | null = null;
  let retry: { nextExpectedAttemptNumber: number; startAfter: Date } | undefined;

  if (outcome === "success") {
    newStatus = "succeeded";
  } else if (!retryable) {
    newStatus = "dead"; // permanent HTTP failure
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
    resolvedIp: null, // Phase 6 owns hardened DNS resolve/pin.
    outcome,
  };

  const result = await finalizeDelivery({
    deliveryId,
    expectedAttemptNumber,
    jobId: job.id,
    newStatus,
    nextRetryAt,
    attempt,
    retry,
  });

  if (result === "stale") {
    console.warn(
      `[worker] Discarded stale completion: deliveryId=${deliveryId} expectedAttemptNumber=${expectedAttemptNumber}`
    );
    await safeComplete(job.id);
    return;
  }

  console.log(
    `[worker] delivery deliveryId=${deliveryId} attemptNumber=${expectedAttemptNumber} ` +
      `httpStatus=${responseStatus ?? "n/a"} durationMs=${durationMs} outcome=${outcome} ` +
      `deliveryStatus=${newStatus} retryScheduled=${retry ? "true" : "false"} ` +
      `nextRetryAt=${nextRetryAt ? nextRetryAt.toISOString() : "null"}`
  );
}
