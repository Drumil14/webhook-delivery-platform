import { completeDeliveryJob, enqueueDeliveryJob } from "./boss";
import { prisma } from "./client";
import { notifyDeliveryUpdate } from "./notify";
import type { Prisma } from "./generated/prisma/client";

// Phase 7 — non-attempt deferral of a delivery job.
//
// Used when the worker decides NOT to attempt HTTP right now (endpoint paused, or
// our per-endpoint rate limit is exhausted). Unlike finalizeDelivery, NO
// DeliveryAttempt is recorded and attemptCount is NOT incremented — no HTTP
// happened. We simply reschedule the SAME attempt for later.

export type DeferResult = "won" | "stale";

export type DeferHooks = {
  // Test seam ONLY: runs inside the transaction, after the update + replacement
  // enqueue + current-job completion but BEFORE commit. Throwing proves all three
  // roll back together.
  beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
};

// Internal sentinel: thrown to roll the transaction back when a concurrent worker
// already completed this job (so this deferral must not create scheduling state).
// Translated to a "stale" result by the caller-facing catch below.
class StaleDeferral extends Error {}

/**
 * Atomically defer a delivery job in ONE transaction:
 *
 *   UPDATE Delivery SET nextRetryAt = <deferUntil>
 *     WHERE id = <deliveryId>
 *       AND status = 'pending'
 *       AND attemptCount = <expectedAttemptNumber - 1>   -- attempt-version guard
 *   enqueue replacement job { deliveryId, expectedAttemptNumber }  startAfter=deferUntil
 *   complete the CURRENT job
 *
 * The replacement keeps the SAME expectedAttemptNumber (no attempt was consumed).
 *
 * The guard is the SAME attempt-version principle as guarded finalization: the
 * update only wins when the Delivery is still pending AND its attemptCount matches
 * this job's expected attempt (i.e. no newer attempt/deferral has advanced it).
 * If zero rows match (terminal, or a concurrent worker already deferred/advanced
 * this same attempt), returns "stale" and changes NOTHING — no nextRetryAt write,
 * no replacement enqueue. The caller does best-effort completion of the current
 * job only. A stale deferral must never become another delivery attempt.
 */
export async function deferDeliveryJob(
  input: {
    deliveryId: string;
    expectedAttemptNumber: number; // SAME number — no attempt consumed
    jobId: string; // current job to complete
    deferUntil: Date; // nextRetryAt + replacement startAfter
    accountId: string; // for the realtime notification
    eventId: string; // for the realtime notification
  },
  hooks: DeferHooks = {}
): Promise<DeferResult> {
  const { deliveryId, expectedAttemptNumber, jobId, deferUntil, accountId, eventId } = input;

  try {
    return await prisma.$transaction(async (tx) => {
      // Attempt-version guard (same principle as guarded finalization): only win
      // when the Delivery is still pending AND its attemptCount matches this job's
      // expected attempt. This takes an exclusive lock on the Delivery row, which
      // also SERIALIZES two concurrent deferrals of the same delivery.
      const won = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "Delivery"
        SET "nextRetryAt" = ${deferUntil},
            "updatedAt" = NOW()
        WHERE "id" = ${deliveryId}
          AND "status" = 'pending'
          AND "attemptCount" = ${expectedAttemptNumber - 1}
        RETURNING "id"
      `;
      if (won.length === 0) {
        // Terminal, or a newer attempt/deferral already advanced this Delivery.
        return "stale";
      }

      // Replacement job for the SAME attempt, scheduled at the recheck/next-window time.
      await enqueueDeliveryJob(
        tx,
        { deliveryId, expectedAttemptNumber },
        { startAfter: deferUntil }
      );

      // Complete the CURRENT job inside the SAME transaction. This is also the
      // tie-breaker for a same-job race: pg-boss completes only an 'active' job,
      // so `affected === 0` means a concurrent worker already completed it. In
      // that case THIS deferral is a duplicate — roll everything back (no
      // nextRetryAt write, no replacement) so two workers can never both create
      // valid replacement scheduling state.
      const affected = await completeDeliveryJob(jobId, tx);
      if (affected === 0) {
        throw new StaleDeferral();
      }

      // Realtime signal for the committed deferral (won path only; the stale
      // paths above emit nothing). Inside the tx: rollback suppresses it.
      await notifyDeliveryUpdate(tx, { accountId, deliveryId, eventId, kind: "deferred" });

      if (hooks.beforeCommit) {
        await hooks.beforeCommit(tx);
      }

      return "won";
    });
  } catch (error) {
    if (error instanceof StaleDeferral) {
      return "stale";
    }
    throw error;
  }
}
