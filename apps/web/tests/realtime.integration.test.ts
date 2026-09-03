import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DEMO_ACCOUNT_ID,
  completeDeliveryJob,
  enqueueDeliveryJob,
  ensureDemoAccount,
  fetchDeliveryJob,
  finalizeDelivery,
  notifyDeliveryUpdate,
  prisma,
  purgeDeliveryQueue,
  stopDeliveryQueue,
  type FinalizeAttempt,
} from "@webhook/db";
import type {
  DeliveryUpdateBrowserPayload,
  DeliveryUpdateNotification,
} from "@webhook/shared";

import { processDeliveryJob } from "@webhook/worker/process-delivery";

import { replayDelivery, type ReplayEnqueueFn } from "@/lib/replay-delivery";
import {
  __simulateListenerFailure,
  closeDeliveryUpdateListener,
  getDeliveryListenerState,
  subscribeToDeliveryUpdates,
  type DeliverySubscription,
} from "@/lib/delivery-update-listener";
import {
  deleteEndpointsAndWindows,
  ingestForEndpoint,
  insertEndpointRow,
  spyTransport,
} from "./helpers/phase6";

// Real PostgreSQL LISTEN/NOTIFY through the process listener hub. Nothing about
// the NOTIFY path is mocked.

async function waitFor<T>(get: () => T | undefined, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = get();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 40));
  }
}

const OK_200 = {
  kind: "response" as const,
  status: 200,
  headers: {},
  bodyText: null,
  resolvedIp: "127.0.0.1",
};

// Track open subscriptions so afterEach can reset the subscriber Set to a clean
// baseline (subscriberCount assertions depend on this).
const openUnsubs: Array<() => void> = [];

type Sink = {
  received: DeliveryUpdateBrowserPayload[];
  closed: boolean;
  sub: DeliverySubscription;
};

async function openSink(accountId: string): Promise<Sink> {
  const sink: Sink = {
    received: [],
    closed: false,
    sub: {
      accountId,
      onNotify: (p) => sink.received.push(p),
      onClose: () => {
        sink.closed = true;
      },
    },
  };
  const unsub = await subscribeToDeliveryUpdates(sink.sub);
  openUnsubs.push(unsub);
  return sink;
}

/** Publish a notification directly, inside a committed transaction (real NOTIFY). */
async function publish(n: DeliveryUpdateNotification): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await notifyDeliveryUpdate(tx, n);
  });
}

let accountId: string;
const usedKeys: string[] = [];
const endpointIds: string[] = [];

function uniqueKey(): string {
  const k = `p8-${randomUUID()}`;
  usedKeys.push(k);
  return k;
}

async function makeEndpoint(status: "active" | "paused" = "active"): Promise<string> {
  const ep = await insertEndpointRow(accountId, `https://webhook.test/rt-${randomUUID()}`, { status });
  endpointIds.push(ep.id);
  return ep.id;
}

function fixtureAttempt(status: number, outcome: "success" | "failure"): FinalizeAttempt {
  return {
    requestHeaders: {},
    responseStatus: status,
    responseHeaders: {},
    responseBodySnippet: null,
    errorMessage: null,
    durationMs: 1,
    resolvedIp: "127.0.0.1",
    outcome,
  };
}

beforeAll(async () => {
  accountId = (await ensureDemoAccount()).id;
});

beforeEach(async () => {
  await purgeDeliveryQueue();
});

afterEach(() => {
  // Reset subscribers to a clean baseline between tests.
  for (const unsub of openUnsubs.splice(0)) unsub();
});

afterAll(async () => {
  await closeDeliveryUpdateListener();
  if (usedKeys.length > 0) {
    const events = await prisma.event.findMany({
      where: { accountId, idempotencyKey: { in: usedKeys } },
      select: { id: true },
    });
    const eventIds = events.map((e) => e.id);
    if (eventIds.length > 0) {
      const deliveries = await prisma.delivery.findMany({
        where: { eventId: { in: eventIds } },
        select: { id: true },
      });
      const deliveryIds = deliveries.map((d) => d.id);
      if (deliveryIds.length > 0) {
        await prisma.deliveryAttempt.deleteMany({ where: { deliveryId: { in: deliveryIds } } });
      }
      await prisma.delivery.deleteMany({ where: { eventId: { in: eventIds } } });
      await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    }
  }
  await deleteEndpointsAndWindows(endpointIds);
  await purgeDeliveryQueue();
  await stopDeliveryQueue();
  await prisma.$disconnect();
});

describe("Phase 8 — realtime NOTIFY/LISTEN", () => {
  it("P8-2: a successful finalize emits one 'attempted' notification", async () => {
    const endpointId = await makeEndpoint();
    const { deliveryId, eventId } = await ingestForEndpoint(accountId, endpointId, uniqueKey());
    const sink = await openSink(accountId);
    const job = await fetchDeliveryJob({ ignoreStartAfter: true });

    await processDeliveryJob(job!, { transport: spyTransport(OK_200).transport });

    const hit = await waitFor(() =>
      sink.received.find((p) => p.deliveryId === deliveryId && p.kind === "attempted")
    );
    expect(hit).toEqual({ deliveryId, eventId, kind: "attempted" });
  });

  it("P8-3: a rolled-back finalize emits NO notification (transactional)", async () => {
    const endpointId = await makeEndpoint();
    const { deliveryId } = await ingestForEndpoint(accountId, endpointId, uniqueKey());
    const { eventId } = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
      select: { eventId: true },
    });
    const sink = await openSink(accountId);
    const job = await fetchDeliveryJob({ ignoreStartAfter: true });

    await expect(
      finalizeDelivery(
        {
          deliveryId,
          expectedAttemptNumber: 1,
          jobId: job!.id,
          accountId,
          eventId,
          newStatus: "succeeded",
          nextRetryAt: null,
          attempt: fixtureAttempt(200, "success"),
        },
        { beforeCommit: async () => { throw new Error("boom"); } }
      )
    ).rejects.toThrow("boom");

    // Give any escaped notification time to arrive, then assert none did.
    await new Promise((r) => setTimeout(r, 2000));
    expect(sink.received.some((p) => p.deliveryId === deliveryId)).toBe(false);
  });

  it("P8-4: initial creation notifies once; idempotent duplicate does not", async () => {
    const endpointId = await makeEndpoint();
    const sink = await openSink(accountId);
    const key = uniqueKey();
    const body = JSON.stringify({ type: "order.created", data: { k: key } });

    const { deliveryId } = await ingestForEndpoint(accountId, endpointId, key, body);
    await waitFor(() => sink.received.find((p) => p.deliveryId === deliveryId && p.kind === "created"));

    // Idempotent duplicate (same key + body) creates nothing -> no new signal.
    await ingestForEndpoint(accountId, endpointId, key, body).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const created = sink.received.filter((p) => p.deliveryId === deliveryId && p.kind === "created");
    expect(created).toHaveLength(1);
  });

  it("P8-5: a successful deferral notifies; a stale deferral does not", async () => {
    const endpointId = await makeEndpoint("paused");
    const { deliveryId, eventId } = await ingestForEndpoint(accountId, endpointId, uniqueKey());
    const sink = await openSink(accountId);
    const job = await fetchDeliveryJob({ ignoreStartAfter: true });

    // Paused -> deferral commits -> 'deferred' notification.
    await processDeliveryJob(job!, { transport: spyTransport().transport, pauseRecheckMs: 5_000 });
    const hit = await waitFor(() =>
      sink.received.find((p) => p.deliveryId === deliveryId && p.kind === "deferred")
    );
    expect(hit).toEqual({ deliveryId, eventId, kind: "deferred" });

    // A stale deferral (already-terminal delivery) commits nothing -> no signal.
    await prisma.delivery.update({ where: { id: deliveryId }, data: { status: "dead" } });
    const before = sink.received.length;
    const next = await fetchDeliveryJob({ ignoreStartAfter: true });
    await processDeliveryJob(next!, { transport: spyTransport().transport, pauseRecheckMs: 5_000 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(sink.received.slice(before).some((p) => p.kind === "deferred")).toBe(false);
  });

  it("P8-6: replay notifies for the NEW delivery; rolled-back replay does not", async () => {
    const endpointId = await makeEndpoint();
    const { deliveryId: origId, eventId } = await ingestForEndpoint(accountId, endpointId, uniqueKey());
    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    await completeDeliveryJob(job!.id);
    await prisma.delivery.update({ where: { id: origId }, data: { status: "dead" } });

    const sink = await openSink(accountId);

    // Rolled-back replay -> no notification.
    const failing: ReplayEnqueueFn = async (tx, payload) => {
      await enqueueDeliveryJob(tx, payload);
      throw new Error("boom");
    };
    await expect(replayDelivery(origId, accountId, failing)).rejects.toThrow("boom");
    await new Promise((r) => setTimeout(r, 1200));
    expect(sink.received.some((p) => p.kind === "replayed")).toBe(false);

    // Successful replay -> one 'replayed' notification for the NEW delivery id.
    const res = await replayDelivery(origId, accountId);
    expect(res.status).toBe(201);
    const newId = res.status === 201 ? res.body.id : "";
    const hit = await waitFor(() =>
      sink.received.find((p) => p.kind === "replayed" && p.deliveryId === newId)
    );
    expect(hit).toEqual({ deliveryId: newId, eventId, kind: "replayed" });
  });

  it("P8-9: notifications are account-isolated", async () => {
    const sink = await openSink(accountId); // demo account
    const foreignId = randomUUID();

    // A different account's notification must NOT reach this subscriber.
    await publish({ accountId: "other-account", deliveryId: foreignId, eventId: "e", kind: "attempted" });
    await new Promise((r) => setTimeout(r, 1500));
    expect(sink.received.some((p) => p.deliveryId === foreignId)).toBe(false);

    // A matching-account notification IS forwarded.
    const mineId = randomUUID();
    await publish({ accountId: DEMO_ACCOUNT_ID, deliveryId: mineId, eventId: "e", kind: "attempted" });
    const hit = await waitFor(() => sink.received.find((p) => p.deliveryId === mineId));
    expect(hit.kind).toBe("attempted");
  });

  it("P8-10: two subscribers share ONE LISTEN connection and both receive", async () => {
    const a = await openSink(accountId);
    const b = await openSink(accountId);
    expect(getDeliveryListenerState().subscriberCount).toBe(2);
    expect(getDeliveryListenerState().connected).toBe(true); // single shared connection

    const id = randomUUID();
    await publish({ accountId: DEMO_ACCOUNT_ID, deliveryId: id, eventId: "e", kind: "created" });
    await waitFor(() => a.received.find((p) => p.deliveryId === id));
    await waitFor(() => b.received.find((p) => p.deliveryId === id));
  });

  it("P8-11: unsubscribing removes the subscriber; no writes after close", async () => {
    const sink = await openSink(accountId);
    expect(getDeliveryListenerState().subscriberCount).toBe(1);

    // Unsubscribe (simulates the SSE connection closing).
    openUnsubs.splice(0).forEach((u) => u());
    expect(getDeliveryListenerState().subscriberCount).toBe(0);

    // A later notification must not reach the removed subscriber.
    const id = randomUUID();
    await publish({ accountId: DEMO_ACCOUNT_ID, deliveryId: id, eventId: "e", kind: "created" });
    await new Promise((r) => setTimeout(r, 1500));
    expect(sink.received.some((p) => p.deliveryId === id)).toBe(false);
  });

  it("P8-12: listener failure closes subscribers; next subscribe re-establishes", async () => {
    const sink = await openSink(accountId);
    expect(getDeliveryListenerState().connected).toBe(true);

    // Simulate the LISTEN connection dropping.
    __simulateListenerFailure();
    expect(sink.closed).toBe(true);
    expect(getDeliveryListenerState().subscriberCount).toBe(0);
    expect(getDeliveryListenerState().connected).toBe(false);
    openUnsubs.length = 0; // the failure already cleared the Set

    // A fresh subscription establishes a new LISTEN connection and works.
    const sink2 = await openSink(accountId);
    expect(getDeliveryListenerState().connected).toBe(true);
    const id = randomUUID();
    await publish({ accountId: DEMO_ACCOUNT_ID, deliveryId: id, eventId: "e", kind: "attempted" });
    await waitFor(() => sink2.received.find((p) => p.deliveryId === id));
  });

  it("P8-13: concurrent cold subscriptions establish exactly ONE LISTEN connection", async () => {
    // Start from a cold listener (no connection, no subscribers).
    await closeDeliveryUpdateListener();
    const before = getDeliveryListenerState().connectionsEstablished;

    // Many subscribers arrive simultaneously while no connection exists.
    const sinks = await Promise.all(Array.from({ length: 8 }, () => openSink(accountId)));

    const state = getDeliveryListenerState();
    expect(state.connectionsEstablished - before).toBe(1); // exactly ONE pg client/LISTEN
    expect(state.connected).toBe(true);
    expect(state.subscriberCount).toBe(8);

    // The single shared connection actually delivers to all of them.
    const id = randomUUID();
    await publish({ accountId: DEMO_ACCOUNT_ID, deliveryId: id, eventId: "e", kind: "created" });
    for (const s of sinks) {
      await waitFor(() => s.received.find((p) => p.deliveryId === id));
    }
  });

  it("P8-14: a throwing subscriber is isolated + removed; others still receive", async () => {
    let aClosed = false;
    const bReceived: DeliveryUpdateBrowserPayload[] = [];

    const subA: DeliverySubscription = {
      accountId,
      onNotify: () => {
        throw new Error("subscriber A boom");
      },
      onClose: () => {
        aClosed = true;
      },
    };
    const subB: DeliverySubscription = {
      accountId,
      onNotify: (p) => bReceived.push(p),
      onClose: () => {},
    };
    openUnsubs.push(await subscribeToDeliveryUpdates(subA));
    openUnsubs.push(await subscribeToDeliveryUpdates(subB));
    expect(getDeliveryListenerState().subscriberCount).toBe(2);

    const id = randomUUID();
    await publish({ accountId: DEMO_ACCOUNT_ID, deliveryId: id, eventId: "e", kind: "attempted" });

    // B receives despite A throwing on the same notification...
    await waitFor(() => bReceived.find((p) => p.deliveryId === id));
    // ...and A was removed + closed (not retried on future notifications).
    expect(aClosed).toBe(true);
    expect(getDeliveryListenerState().subscriberCount).toBe(1);
  });
});
