import { enqueueDeliveryJob, notifyDeliveryUpdate, prisma } from "@webhook/db";
import { DEMO_RETRY_POLICY, type JobPayload } from "@webhook/shared";

// Phase 7 — manual replay of a DEAD delivery as a brand-new Delivery.
//
// Replay is a fresh delivery lifecycle: it creates a NEW Delivery row for the
// SAME Event (no new Event), with a fresh retry budget and attemptCount=0. It
// never mutates the original dead Delivery or its immutable attempt history.

export type ReplayResult =
  | {
      status: 201;
      body: {
        id: string;
        replayOfDeliveryId: string;
        eventId: string;
        status: string;
        triggeredBy: string;
        attemptCount: number;
        maxAttempts: number;
      };
    }
  | { status: 404 | 409; body: { error: string } };

// Injectable enqueue seam (mirrors ingest) so the atomicity test can fail the
// transaction AFTER the job is enqueued but BEFORE commit.
export type ReplayEnqueueFn = (
  tx: Parameters<typeof enqueueDeliveryJob>[0],
  payload: JobPayload
) => Promise<void>;

/**
 * Replay a dead Delivery. Enforces ownership (404 if not found/owned) and the
 * dead-only rule (409 DELIVERY_NOT_REPLAYABLE otherwise). On success, inside ONE
 * transaction: insert the new manual_replay Delivery and enqueue its initial job.
 */
export async function replayDelivery(
  deliveryId: string,
  accountId: string,
  enqueue: ReplayEnqueueFn = enqueueDeliveryJob
): Promise<ReplayResult> {
  const original = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    include: { event: { select: { id: true, accountId: true } } },
  });

  // Do not leak existence across accounts: unknown OR not-owned -> 404.
  if (!original || original.event.accountId !== accountId) {
    return { status: 404, body: { error: "DELIVERY_NOT_FOUND" } };
  }

  // Core V1: only dead deliveries may be replayed (avoids accidental duplicates).
  if (original.status !== "dead") {
    return { status: 409, body: { error: "DELIVERY_NOT_REPLAYABLE" } };
  }

  // Fresh retry budget — explicit, so it is obvious replay does NOT inherit the
  // original's attemptCount or remaining budget.
  const maxAttempts = DEMO_RETRY_POLICY.maxAttempts;

  const created = await prisma.$transaction(async (tx) => {
    const newDelivery = await tx.delivery.create({
      data: {
        eventId: original.event.id, // SAME event — no new Event is created
        status: "pending",
        attemptCount: 0,
        maxAttempts,
        nextRetryAt: null,
        triggeredBy: "manual_replay",
        replayOfDeliveryId: original.id,
      },
      select: { id: true },
    });

    // Initial job for the new delivery, enqueued in the SAME transaction so the
    // Delivery row and the job commit atomically.
    const payload: JobPayload = { deliveryId: newDelivery.id, expectedAttemptNumber: 1 };
    await enqueue(tx, payload);

    // Realtime signal referencing the NEW replay Delivery, inside this tx (fires
    // only on commit; a rollback emits nothing).
    await notifyDeliveryUpdate(tx, {
      accountId: original.event.accountId,
      deliveryId: newDelivery.id,
      eventId: original.event.id,
      kind: "replayed",
    });

    return newDelivery;
  });

  console.log(
    `[replay] originalDeliveryId=${original.id} newDeliveryId=${created.id} eventId=${original.event.id}`
  );

  return {
    status: 201,
    body: {
      id: created.id,
      replayOfDeliveryId: original.id,
      eventId: original.event.id,
      status: "pending",
      triggeredBy: "manual_replay",
      attemptCount: 0,
      maxAttempts,
    },
  };
}
