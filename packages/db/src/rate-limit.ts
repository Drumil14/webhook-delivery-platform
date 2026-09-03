import { prisma } from "./client";

// Phase 7 — per-endpoint fixed-window rate limiter (PostgreSQL-backed).
//
// One row per (endpoint, UTC minute). Acquisition is a single atomic
// INSERT ... ON CONFLICT DO UPDATE ... WHERE, so concurrent workers cannot both
// believe they grabbed the last slot, and denied requests never inflate the
// counter past the limit. No sliding window / token bucket / Redis in V1.

const MINUTE_MS = 60_000;

/** The UTC-minute window start for a given instant (e.g. 10:24:37 -> 10:24:00). */
export function windowStartFor(nowMs: number): Date {
  return new Date(Math.floor(nowMs / MINUTE_MS) * MINUTE_MS);
}

/** The start of the NEXT UTC minute — used as the rate-limit deferral time. */
export function nextWindowStart(nowMs: number): Date {
  return new Date(Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
}

export type RateLimitAcquisition = {
  allowed: boolean;
  // The window this acquisition was evaluated against, and (when allowed) the
  // resulting count. When denied, `count` is null (the row is already at limit).
  windowStart: Date;
  count: number | null;
};

/**
 * Atomically try to consume one rate-limit slot for `endpointId` in the current
 * UTC-minute window.
 *
 *   INSERT (endpointId, windowStart, 1)
 *   ON CONFLICT (endpointId, windowStart)
 *   DO UPDATE SET requestCount = requestCount + 1
 *     WHERE requestCount < limit          -- only increment if there is room
 *   RETURNING requestCount;
 *
 * - No row yet            -> INSERT count=1 -> returned -> ALLOWED (limit >= 1).
 * - Row exists, count<lim -> DO UPDATE increments        -> returned -> ALLOWED.
 * - Row exists, count>=lim-> WHERE is false, no update   -> NO row  -> DENIED,
 *                            and the counter stays AT the limit (does not grow).
 *
 * Concurrency safety: the ON CONFLICT DO UPDATE takes a row-level lock on the
 * conflicting row, so racing increments are serialized and exact. With limit=2,
 * three concurrent callers see counts {1,2} allowed and the third denied — never
 * three allowed.
 */
export async function tryAcquireEndpointRateLimit(
  endpointId: string,
  limit: number,
  nowMs: number
): Promise<RateLimitAcquisition> {
  const windowStart = windowStartFor(nowMs);
  const rows = await prisma.$queryRaw<{ requestCount: number }[]>`
    INSERT INTO "EndpointRateWindow" ("endpointId", "windowStart", "requestCount", "updatedAt")
    VALUES (${endpointId}, ${windowStart}, 1, NOW())
    ON CONFLICT ("endpointId", "windowStart")
    DO UPDATE SET "requestCount" = "EndpointRateWindow"."requestCount" + 1,
                  "updatedAt" = NOW()
    WHERE "EndpointRateWindow"."requestCount" < ${limit}
    RETURNING "requestCount"
  `;
  if (rows.length === 0) {
    return { allowed: false, windowStart, count: null };
  }
  return { allowed: true, windowStart, count: rows[0]!.requestCount };
}
