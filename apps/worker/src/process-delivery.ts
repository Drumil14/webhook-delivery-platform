import { performance } from "node:perf_hooks";

import {
  completeDeliveryJob,
  finalizeDelivery,
  prisma,
  type DeliveryAttemptOutcome,
  type DeliveryStatus,
  type FinalizeAttempt,
} from "@webhook/db";
import { type JobPayload } from "@webhook/shared";

// Phase 3: perform a real HTTP webhook delivery, record the attempt, and finalize
// the Delivery through the guarded transaction. NO retries/backoff/HMAC/SSRF yet.

const USER_AGENT = "webhook-delivery-platform/0.0.0";
const MAX_RESPONSE_SNIPPET_BYTES = 10 * 1024; // ~10 KB cap to avoid DB bloat

// Frozen permanent-failure statuses -> Delivery becomes `dead` (no retry).
const PERMANENT_FAILURE_STATUSES = new Set([400, 401, 403, 404, 410]);

type DeliveryJob = { id: string; data: JobPayload };

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
    // The frozen note: complete() may fail if pg-boss already expired/reassigned
    // the job. Don't turn that into another delivery — just log and move on.
    console.warn(
      `[worker] Best-effort completion failed for job ${jobId} (may be expired/reassigned):`,
      error
    );
  }
}

/**
 * Process exactly one delivery job: load Delivery -> Event -> Endpoint, POST the
 * event's raw body to the endpoint, then finalize via the guarded transaction.
 */
export async function processDeliveryJob(job: DeliveryJob): Promise<void> {
  if (!isValidPayload(job.data)) {
    console.error(`[worker] Malformed job ${job.id}; discarding.`, job.data);
    await safeComplete(job.id);
    return;
  }

  const { deliveryId, expectedAttemptNumber } = job.data;

  // Postgres is the source of truth: load everything by deliveryId.
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

  // Build request headers (NO HMAC signature yet — Phase 6). These get stored on
  // the DeliveryAttempt. No secrets included.
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
  let outcome: DeliveryAttemptOutcome;
  let newStatus: DeliveryStatus;

  // The HTTP call happens OUTSIDE any transaction (network I/O must not hold a DB
  // transaction open).
  const startedAt = performance.now();
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: requestHeaders,
      // CRITICAL: send the stored raw bytes verbatim — never re-serialize.
      body: event.payloadRaw,
    });

    responseStatus = response.status;
    responseHeaders = Object.fromEntries(response.headers);
    responseBodySnippet = await readCappedText(response, MAX_RESPONSE_SNIPPET_BYTES);

    if (response.status >= 200 && response.status < 300) {
      outcome = "success";
      newStatus = "succeeded";
    } else if (PERMANENT_FAILURE_STATUSES.has(response.status)) {
      outcome = "failure";
      newStatus = "dead";
      errorMessage = `Permanent failure: HTTP ${response.status}`;
    } else {
      // Retryable in Phase 5. For now: record honestly, keep non-terminal.
      outcome = "failure";
      newStatus = "pending";
      errorMessage = `Retryable failure: HTTP ${response.status}`;
    }
  } catch (error) {
    // Network error / connection refused etc. Recorded honestly; kept
    // non-terminal. (timeout/network_error behavior is a later phase.)
    errorMessage = error instanceof Error ? error.message : String(error);
    outcome = "network_error";
    newStatus = "pending";
  }
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));

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
    attempt,
  });

  if (result === "stale") {
    console.warn(
      `[worker] Discarded stale completion: deliveryId=${deliveryId} expectedAttemptNumber=${expectedAttemptNumber}`
    );
    await safeComplete(job.id);
    return;
  }

  // Winner: finalizeDelivery already recorded the attempt and completed the job.
  console.log(
    `[worker] delivery deliveryId=${deliveryId} attemptNumber=${expectedAttemptNumber} httpStatus=${responseStatus ?? "n/a"} durationMs=${durationMs} outcome=${outcome} deliveryStatus=${newStatus}`
  );

  if (newStatus === "pending") {
    console.warn(
      `[worker] Retry scheduling is NOT implemented until Phase 5; leaving deliveryId=${deliveryId} pending and creating NO new job.`
    );
  }
}
