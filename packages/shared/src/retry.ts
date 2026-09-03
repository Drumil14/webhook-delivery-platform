// Pure, dependency-free retry policy + backoff/jitter math. NO Prisma/pg-boss/
// worker imports here — this module is safe to unit-test in isolation.

export type RetryPolicy = {
  baseDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  maxAttempts: number;
  jitterPercent: number; // e.g. 0.20 => +/-20%
};

// Active policy for local dev and the public demo.
export const DEMO_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 2_000,
  multiplier: 3,
  maxDelayMs: 30_000,
  maxAttempts: 6,
  jitterPercent: 0.2,
};

// Exists + unit-tested, but never waited on end-to-end (spans ~1 day).
export const PRODUCTION_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 60_000,
  multiplier: 4,
  maxDelayMs: 86_400_000, // 24h
  maxAttempts: 7,
  jitterPercent: 0.2,
};

/**
 * Nominal delay (NO jitter) before attempt `nextAttemptNumber` (>= 2):
 *
 *   min( baseDelay * multiplier^(n - 2), maxDelay )
 *
 * n=2 -> baseDelay, n=3 -> baseDelay*multiplier, ... capped at maxDelay.
 */
export function baseRetryDelayMs(
  nextAttemptNumber: number,
  policy: RetryPolicy
): number {
  const raw = policy.baseDelayMs * policy.multiplier ** (nextAttemptNumber - 2);
  return Math.min(raw, policy.maxDelayMs);
}

/**
 * Backoff delay with +/- jitterPercent jitter applied.
 *
 * `random` must return a value in [0, 1); it maps linearly to the jitter range:
 *   random=0   -> factor (1 - jitter)  (minimum)
 *   random=0.5 -> factor 1             (center)
 *   random=1   -> factor (1 + jitter)  (maximum)
 *
 * The `random` seam exists purely for deterministic tests; do not build a
 * random-service abstraction around it.
 */
export function calculateRetryDelay(args: {
  nextAttemptNumber: number;
  policy: RetryPolicy;
  random?: () => number;
}): number {
  const { nextAttemptNumber, policy, random = Math.random } = args;
  const base = baseRetryDelayMs(nextAttemptNumber, policy);
  const factor = 1 - policy.jitterPercent + random() * (2 * policy.jitterPercent);
  return Math.round(base * factor);
}
