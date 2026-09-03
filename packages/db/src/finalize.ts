import { randomUUID } from "node:crypto";

import { completeDeliveryJob } from "./boss";
import { prisma } from "./client";
import type {
  DeliveryAttemptOutcome,
  DeliveryStatus,
  Prisma,
} from "./generated/prisma/client";

export type FinalizeAttempt = {
  requestHeaders: unknown;
  responseStatus: number | null;
  responseHeaders: unknown | null;
  responseBodySnippet: string | null;
  errorMessage: string | null;
  durationMs: number;
  resolvedIp: string | null;
  outcome: DeliveryAttemptOutcome;
};

export type FinalizeInput = {
  deliveryId: string;
  expectedAttemptNumber: number;
  jobId: string;
  // New Delivery status: 'succeeded' | 'dead' | 'pending' (pending = non-terminal
  // failure that Phase 5 will make retryable).
  newStatus: DeliveryStatus;
  attempt: FinalizeAttempt;
};

export type FinalizeResult = "won" | "stale";

export type FinalizeHooks = {
  // Test seam ONLY: runs inside the transaction after the guarded update, the
  // DeliveryAttempt insert, and the queue completion, but BEFORE commit.
  // Throwing here proves all three roll back together.
  beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
};

/**
 * Guarded finalize transaction (the heart of Phase 3).
 *
 * The HTTP call has already happened OUTSIDE any transaction. Here, in ONE
 * transaction, we conditionally advance the Delivery:
 *
 *   UPDATE Delivery
 *   SET attemptCount = attemptCount + 1, status = <newStatus>
 *   WHERE id = <deliveryId>
 *     AND attemptCount = <expectedAttemptNumber - 1>   -- this is the guard
 *     AND status = 'pending'
 *
 * - 1 row updated  -> we WON: insert DeliveryAttempt (attemptNumber =
 *   expectedAttemptNumber) and complete the pg-boss job THROUGH the same tx
 *   (fromPrisma(tx)), then commit. Delivery state + attempt history + queue
 *   completion move together atomically.
 * - 0 rows updated -> STALE (a newer attempt already advanced this Delivery, or
 *   it is already terminal): write nothing, change nothing. The caller does
 *   best-effort queue cleanup.
 */
export async function finalizeDelivery(
  input: FinalizeInput,
  hooks: FinalizeHooks = {}
): Promise<FinalizeResult> {
  const { deliveryId, expectedAttemptNumber, jobId, newStatus, attempt } = input;

  return prisma.$transaction(async (tx) => {
    const won = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "Delivery"
      SET "attemptCount" = "attemptCount" + 1,
          "status" = ${newStatus}::"DeliveryStatus",
          "updatedAt" = NOW()
      WHERE "id" = ${deliveryId}
        AND "attemptCount" = ${expectedAttemptNumber - 1}
        AND "status" = 'pending'
      RETURNING "id"
    `;

    if (won.length === 0) {
      return "stale";
    }

    const attemptId = randomUUID();
    await tx.$executeRaw`
      INSERT INTO "DeliveryAttempt" (
        "id", "deliveryId", "attemptNumber", "requestHeaders", "responseStatus",
        "responseHeaders", "responseBodySnippet", "errorMessage", "durationMs",
        "resolvedIp", "outcome", "attemptedAt"
      ) VALUES (
        ${attemptId}, ${deliveryId}, ${expectedAttemptNumber},
        ${JSON.stringify(attempt.requestHeaders)}::jsonb,
        ${attempt.responseStatus},
        ${attempt.responseHeaders === null ? null : JSON.stringify(attempt.responseHeaders)}::jsonb,
        ${attempt.responseBodySnippet},
        ${attempt.errorMessage},
        ${attempt.durationMs},
        ${attempt.resolvedIp},
        ${attempt.outcome}::"DeliveryAttemptOutcome",
        NOW()
      )
    `;

    // Complete the queue job inside the SAME transaction.
    await completeDeliveryJob(jobId, tx);

    if (hooks.beforeCommit) {
      await hooks.beforeCommit(tx);
    }

    return "won";
  });
}
