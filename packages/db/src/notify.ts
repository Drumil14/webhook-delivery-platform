import {
  DELIVERY_UPDATE_CHANNEL,
  serializeDeliveryUpdate,
  type DeliveryUpdateNotification,
} from "@webhook/shared";

import type { Prisma } from "./generated/prisma/client";

// Phase 8 — publish a realtime Delivery-update notification.
//
// This MUST be called with the SAME transaction client (`tx`) as the domain
// state change it announces. PostgreSQL delivers NOTIFY only on COMMIT, so:
//   - commit  -> listeners receive the notification
//   - rollback -> the notification never escapes
// And if this pg_notify statement itself fails, it throws and fails the enclosing
// transaction (we never commit domain state while pretending realtime was emitted).

/**
 * Emit `pg_notify(delivery_updates, <tiny JSON>)` inside the caller's transaction.
 * The payload is IDs + kind only (see @webhook/shared) — never domain data.
 */
export async function notifyDeliveryUpdate(
  tx: Prisma.TransactionClient,
  notification: DeliveryUpdateNotification
): Promise<void> {
  const payload = serializeDeliveryUpdate(notification);
  // Parameterized: Prisma sends `SELECT pg_notify($1, $2)`.
  await tx.$executeRaw`SELECT pg_notify(${DELIVERY_UPDATE_CHANNEL}, ${payload})`;
}
