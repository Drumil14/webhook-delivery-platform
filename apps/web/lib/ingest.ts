import { randomUUID } from "node:crypto";

import { prisma } from "@webhook/db";
import { computePayloadFingerprint } from "@webhook/shared";

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

/**
 * Idempotent event insert.
 *
 * The database UNIQUE(accountId, idempotencyKey) constraint is the authority.
 * We attempt a single atomic `INSERT ... ON CONFLICT DO NOTHING RETURNING`:
 *
 *  - if a row comes back  -> we won the insert          -> "created"
 *  - if no row comes back  -> the key already existed:
 *      - same fingerprint  -> safe retry of same request -> "duplicate"
 *      - different fingerprint                            -> "conflict"
 *
 * This is race-free: two concurrent inserts with the same key can't both
 * succeed, and the loser deterministically re-reads the winner's row.
 */
export async function ingestEvent(input: IngestInput): Promise<IngestResult> {
  const { accountId, endpointId, eventType, payloadRaw, idempotencyKey } = input;

  const fingerprint = computePayloadFingerprint(endpointId, payloadRaw);
  const id = randomUUID();

  // `payload` (jsonb) is derived from the exact same raw bytes we store in
  // `payloadRaw` (text), by casting the raw string to jsonb — so they can never
  // drift apart.
  const inserted = await prisma.$queryRaw<EventSummary[]>`
    INSERT INTO "Event" (
      "id", "accountId", "endpointId", "eventType",
      "payload", "payloadRaw", "idempotencyKey", "payloadFingerprint", "receivedAt"
    )
    VALUES (
      ${id}, ${accountId}, ${endpointId}, ${eventType},
      ${payloadRaw}::jsonb, ${payloadRaw}, ${idempotencyKey}, ${fingerprint}, NOW()
    )
    ON CONFLICT ("accountId", "idempotencyKey") DO NOTHING
    RETURNING
      "id", "accountId", "endpointId", "eventType", "payloadFingerprint", "receivedAt"
  `;

  if (inserted.length === 1) {
    return { outcome: "created", event: inserted[0]! };
  }

  // The key already existed (either previously, or a concurrent insert just
  // won). Read the authoritative existing row and compare fingerprints.
  const existing = await prisma.event.findUnique({
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

  // Should always exist here (unique conflict implies a row), but guard anyway.
  if (!existing) {
    return { outcome: "conflict" };
  }

  if (existing.payloadFingerprint === fingerprint) {
    return { outcome: "duplicate", event: existing };
  }

  return { outcome: "conflict" };
}
