// Phase 8 — realtime notification contract (shared by the DB publisher and the
// web SSE listener). This is an INVALIDATION signal, not a data transport: it
// carries only IDs + a change kind. The browser refetches canonical REST state.
// No payloadRaw, no Event/Delivery/Attempt bodies, no secrets — ever.

/** The single static PostgreSQL LISTEN/NOTIFY channel. One channel is enough. */
export const DELIVERY_UPDATE_CHANNEL = "delivery_updates";

/** The meaningful Delivery state changes that emit a realtime signal. */
export type DeliveryUpdateKind = "created" | "attempted" | "deferred" | "replayed";

const KINDS: ReadonlySet<string> = new Set([
  "created",
  "attempted",
  "deferred",
  "replayed",
] satisfies DeliveryUpdateKind[]);

/** Internal notification (carried over pg_notify). `accountId` is for routing only. */
export type DeliveryUpdateNotification = {
  accountId: string;
  deliveryId: string;
  eventId: string;
  kind: DeliveryUpdateKind;
};

/** The browser-facing SSE payload — accountId is dropped (the stream is already
 * filtered per account, so the browser never needs it). */
export type DeliveryUpdateBrowserPayload = {
  deliveryId: string;
  eventId: string;
  kind: DeliveryUpdateKind;
};

/** Serialize a notification for the NOTIFY payload (tiny; far below PG's limit). */
export function serializeDeliveryUpdate(n: DeliveryUpdateNotification): string {
  return JSON.stringify({
    accountId: n.accountId,
    deliveryId: n.deliveryId,
    eventId: n.eventId,
    kind: n.kind,
  });
}

/**
 * Safely parse + validate a NOTIFY payload. Returns null for anything malformed
 * (bad JSON, missing/empty ids, unknown kind) so a bad payload is ignored rather
 * than crashing the listener.
 */
export function parseDeliveryUpdate(raw: string): DeliveryUpdateNotification | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (
    typeof o.accountId !== "string" || o.accountId === "" ||
    typeof o.deliveryId !== "string" || o.deliveryId === "" ||
    typeof o.eventId !== "string" || o.eventId === "" ||
    typeof o.kind !== "string" || !KINDS.has(o.kind)
  ) {
    return null;
  }
  return {
    accountId: o.accountId,
    deliveryId: o.deliveryId,
    eventId: o.eventId,
    kind: o.kind as DeliveryUpdateKind,
  };
}

/** Strip the internal routing field, leaving only what the browser receives. */
export function toBrowserPayload(n: DeliveryUpdateNotification): DeliveryUpdateBrowserPayload {
  return { deliveryId: n.deliveryId, eventId: n.eventId, kind: n.kind };
}
