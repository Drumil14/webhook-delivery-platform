import { randomUUID } from "node:crypto";

import { enqueueDeliveryJob, prisma } from "@webhook/db";
import { computePayloadFingerprint, type JobPayload } from "@webhook/shared";

export type EventSummary = {
  id: string;
  accountId: string;
  endpointId: string;
  eventType: string;
  payloadFingerprint: string;
  receivedAt: Date;
};

export type IngestResult =
  | { outcome: "created"; event: EventSummary }
  | { outcome: "duplicate"; event: EventSummary }
  | { outcome: "conflict" };

type IngestInput = {
  accountId: string;
  endpointId: string;
  eventType: string;
  payloadRaw: string;
  idempotencyKey: string;
};

// Injectable enqueue seam. Production uses the real transactional enqueue; tests
// can substitute a failing one to prove transaction atomicity without any
// production hacks.
export type EnqueueFn = (
  tx: Parameters<typeof enqueueDeliveryJob>[0],
  payload: JobPayload
) => Promise<void>;

/**
 * Idempotent event ingestion (Phase 2).
 *
 * The database UNIQUE(accountId, idempotencyKey) constraint remains the
 * authority via `INSERT ... ON CONFLICT DO NOTHING RETURNING`. Everything runs
 * in ONE interactive transaction:
 *
 *  - new key      -> insert Event, insert Delivery, enqueue job  -> COMMIT -> "created"
 *  - existing key + same fingerprint  -> no writes                -> "duplicate"
 *  - existing key + different fingerprint -> no writes            -> "conflict"
 *
 * The pg-boss job is enqueued through the Prisma transaction adapter, so the
 * Event, the Delivery, and the queue job commit together or not at all.
 */
export async function ingestEvent(
  input: IngestInput,
  enqueue: EnqueueFn = enqueueDeliveryJob
): Promise<IngestResult> {
  const { accountId, endpointId, eventType, payloadRaw, idempotencyKey } = input;

  const fingerprint = computePayloadFingerprint(endpointId, payloadRaw);
  const eventId = randomUUID();

  return prisma.$transaction(async (tx) => {
    // `payload` (jsonb) is derived from the exact same raw bytes stored in
    // `payloadRaw` (text), by casting the raw string to jsonb.
    const inserted = await tx.$queryRaw<EventSummary[]>`
      INSERT INTO "Event" (
        "id", "accountId", "endpointId", "eventType",
        "payload", "payloadRaw", "idempotencyKey", "payloadFingerprint", "receivedAt"
      )
      VALUES (
        ${eventId}, ${accountId}, ${endpointId}, ${eventType},
        ${payloadRaw}::jsonb, ${payloadRaw}, ${idempotencyKey}, ${fingerprint}, NOW()
      )
      ON CONFLICT ("accountId", "idempotencyKey") DO NOTHING
      RETURNING
        "id", "accountId", "endpointId", "eventType", "payloadFingerprint", "receivedAt"
    `;

    if (inserted.length === 1) {
      const event = inserted[0]!;

      // Exactly one automatic Delivery per Event (enforced by the partial unique
      // index). status/attemptCount/maxAttempts/triggeredBy come from defaults;
      // updatedAt is set here because @updatedAt is client-managed, not a DB
      // default.
      const deliveryId = randomUUID();
      await tx.$executeRaw`
        INSERT INTO "Delivery" ("id", "eventId", "status", "attemptCount", "triggeredBy", "updatedAt")
        VALUES (${deliveryId}, ${event.id}, 'pending', 0, 'automatic', NOW())
      `;

      const payload: JobPayload = { deliveryId, expectedAttemptNumber: 1 };
      await enqueue(tx, payload);

      return { outcome: "created", event };
    }

    // The key already existed (previously, or a concurrent insert just won).
    // Read the authoritative existing row and compare fingerprints. No Delivery
    // or job is created on this path.
    const existing = await tx.event.findUnique({
      where: { accountId_idempotencyKey: { accountId, idempotencyKey } },
      select: {
        id: true,
        accountId: true,
        endpointId: true,
        eventType: true,
        payloadFingerprint: true,
        receivedAt: true,
      },
    });

    if (!existing) {
      return { outcome: "conflict" };
    }

    if (existing.payloadFingerprint === fingerprint) {
      return { outcome: "duplicate", event: existing };
    }

    return { outcome: "conflict" };
  });
}
