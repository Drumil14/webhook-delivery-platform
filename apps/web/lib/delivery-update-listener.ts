import { Client, type Notification } from "pg";

import {
  DELIVERY_UPDATE_CHANNEL,
  parseDeliveryUpdate,
  toBrowserPayload,
  type DeliveryUpdateBrowserPayload,
} from "@webhook/shared";

// Phase 8 — one process-level PostgreSQL LISTEN hub that fans notifications out
// to in-process SSE subscribers.
//
// - ONE dedicated pg Client per web process holds the persistent LISTEN session
//   (Prisma's pooled adapter can't hold a session open for LISTEN, and one
//   connection per browser tab would waste DB connections).
// - Subscribers are just callbacks in a Set. Notifications are filtered by
//   accountId so Account B's changes never reach Account A's stream.
// - On listener failure we close all subscribers (their browsers reconnect and
//   refetch canonical REST state) and reset so the next subscribe reconnects.
//
// The LISTEN connection must be a DIRECT PostgreSQL connection — Neon's pooler
// (PgBouncer) does not support LISTEN/NOTIFY. See DATABASE_URL_UNPOOLED.

export type DeliverySubscription = {
  accountId: string;
  onNotify: (payload: DeliveryUpdateBrowserPayload) => void;
  onClose: () => void;
};

const subscribers = new Set<DeliverySubscription>();
let client: Client | null = null;
let connectPromise: Promise<void> | null = null;
// Monotonic count of LISTEN connections actually established (never reset). Lets
// tests prove that N concurrent cold subscriptions create exactly ONE connection.
let connectionsEstablished = 0;

/** Prefer a direct (non-pooler) URL for LISTEN; fall back to DATABASE_URL. */
function listenerConnectionString(): string | undefined {
  return process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
}

function handleNotification(msg: Notification): void {
  if (msg.channel !== DELIVERY_UPDATE_CHANNEL || !msg.payload) return;
  const notification = parseDeliveryUpdate(msg.payload);
  if (!notification) return; // ignore malformed payloads
  const browserPayload = toBrowserPayload(notification);

  // Fan out with per-subscriber isolation: one throwing subscriber must not stop
  // the others from receiving the SAME notification. Broken subscribers are
  // collected and removed AFTER the loop (mutating the Set mid-iteration is
  // avoided), then closed so their stream is torn down.
  let broken: DeliverySubscription[] | null = null;
  for (const sub of subscribers) {
    if (sub.accountId !== notification.accountId) continue; // account isolation
    try {
      sub.onNotify(browserPayload);
    } catch {
      (broken ??= []).push(sub);
    }
  }
  if (broken) {
    for (const sub of broken) {
      subscribers.delete(sub);
      try {
        sub.onClose();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Tear down the current LISTEN client and close every SSE subscriber. */
function handleListenerFailure(): void {
  const dead = client;
  client = null;
  connectPromise = null;
  const current = [...subscribers];
  subscribers.clear();
  for (const sub of current) {
    try {
      sub.onClose();
    } catch {
      /* ignore */
    }
  }
  if (dead) {
    dead.removeAllListeners();
    dead.end().catch(() => {});
  }
}

/** Lazily establish the single dedicated LISTEN connection for this process. */
async function ensureListening(): Promise<void> {
  if (client) return;
  if (!connectPromise) {
    connectPromise = (async () => {
      const connectionString = listenerConnectionString();
      if (!connectionString) {
        throw new Error("DATABASE_URL(_UNPOOLED) is not set; cannot LISTEN for delivery updates.");
      }
      const c = new Client({ connectionString });
      c.on("notification", handleNotification);
      c.on("error", () => handleListenerFailure());
      c.on("end", () => handleListenerFailure());
      await c.connect();
      // Channel is a fixed constant identifier, not user input.
      await c.query(`LISTEN ${DELIVERY_UPDATE_CHANNEL}`);
      client = c;
      connectionsEstablished += 1;
    })().catch((err) => {
      // Allow a fresh attempt on the next subscribe.
      connectPromise = null;
      client = null;
      throw err;
    });
  }
  return connectPromise;
}

/**
 * Subscribe to delivery updates for one account. Establishes the shared LISTEN
 * connection if needed. Returns an unsubscribe function (call it on disconnect).
 */
export async function subscribeToDeliveryUpdates(
  sub: DeliverySubscription
): Promise<() => void> {
  await ensureListening();
  subscribers.add(sub);
  return () => {
    subscribers.delete(sub);
  };
}

/** Close the LISTEN connection and drop all subscribers (used in test cleanup). */
export async function closeDeliveryUpdateListener(): Promise<void> {
  const dead = client;
  client = null;
  connectPromise = null;
  subscribers.clear();
  if (dead) {
    dead.removeAllListeners();
    await dead.end().catch(() => {});
  }
}

/** Minimal observable state (tests: prove ONE connection fans out to N subscribers). */
export function getDeliveryListenerState(): {
  connected: boolean;
  subscriberCount: number;
  connectionsEstablished: number;
} {
  return {
    connected: client !== null,
    subscriberCount: subscribers.size,
    // Total LISTEN connections ever established this process (monotonic).
    connectionsEstablished,
  };
}

/** Narrow test seam: simulate the LISTEN connection failing (same path as a real drop). */
export function __simulateListenerFailure(): void {
  handleListenerFailure();
}
