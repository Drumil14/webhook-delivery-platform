import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  completeDeliveryJob,
  enqueueDeliveryJob,
  ensureDemoAccount,
  fetchDeliveryJob,
  prisma,
  purgeDeliveryQueue,
  stopDeliveryQueue,
} from "@webhook/db";

import { ingestEvent } from "@/lib/ingest";
import { POST as postEvent } from "@/app/api/v1/endpoints/[endpointId]/events/route";
import { insertEndpointRow } from "./helpers/phase6";

// REAL integration tests against PostgreSQL + pg-boss. Nothing is mocked except
// the injectable enqueue seam in the atomicity test.

let accountId: string;
const createdEndpointIds: string[] = [];
const usedKeys: string[] = [];

function uniqueKey(): string {
  const key = `p2-${randomUUID()}`;
  usedKeys.push(key);
  return key;
}

// Insert the Endpoint row directly (with a real encrypted secret). Phase 6 SSRF
// now rejects arbitrary URLs at the creation API, and these Phase 2 tests only
// need an Endpoint to exist — the URL is never actually delivered to here.
async function makeEndpoint(url = "https://example.com/webhook"): Promise<string> {
  const ep = await insertEndpointRow(accountId, url);
  createdEndpointIds.push(ep.id);
  return ep.id;
}

function sendEvent(endpointId: string, key: string, body: unknown) {
  const req = new Request(
    `http://test/api/v1/endpoints/${endpointId}/events`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }
  );
  return postEvent(req as never, { params: Promise.resolve({ endpointId }) });
}

function eventIdForKey(key: string) {
  return prisma.event.findUnique({
    where: { accountId_idempotencyKey: { accountId, idempotencyKey: key } },
    select: { id: true },
  });
}

beforeAll(async () => {
  const account = await ensureDemoAccount();
  accountId = account.id;
});

beforeEach(async () => {
  // Deterministic queue assertions: start each test with an empty queue.
  await purgeDeliveryQueue();
});

afterAll(async () => {
  // Deliveries reference Events (FK RESTRICT) -> delete Deliveries first.
  if (usedKeys.length > 0) {
    const events = await prisma.event.findMany({
      where: { accountId, idempotencyKey: { in: usedKeys } },
      select: { id: true },
    });
    const eventIds = events.map((e) => e.id);
    if (eventIds.length > 0) {
      await prisma.delivery.deleteMany({ where: { eventId: { in: eventIds } } });
    }
    await prisma.event.deleteMany({
      where: { accountId, idempotencyKey: { in: usedKeys } },
    });
  }
  if (createdEndpointIds.length > 0) {
    await prisma.endpoint.deleteMany({ where: { id: { in: createdEndpointIds } } });
  }
  await purgeDeliveryQueue();
  await stopDeliveryQueue();
  await prisma.$disconnect();
});

describe("Phase 2 — Delivery + queue", () => {
  it("Test 1: new event creates exactly one automatic pending Delivery", async () => {
    const endpointId = await makeEndpoint();
    const key = uniqueKey();

    const res = await sendEvent(endpointId, key, {
      type: "order.created",
      data: { a: 1 },
    });
    expect(res.status).toBe(201);

    const event = await eventIdForKey(key);
    const deliveries = await prisma.delivery.findMany({
      where: { eventId: event!.id },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe("pending");
    expect(deliveries[0]!.attemptCount).toBe(0);
    expect(deliveries[0]!.triggeredBy).toBe("automatic");
  });

  it("Test 2: new event creates a queue job with deliveryId + expectedAttemptNumber=1", async () => {
    const endpointId = await makeEndpoint();
    const key = uniqueKey();

    const res = await sendEvent(endpointId, key, { type: "order.created", data: {} });
    expect(res.status).toBe(201);

    const event = await eventIdForKey(key);
    const delivery = await prisma.delivery.findFirstOrThrow({
      where: { eventId: event!.id },
    });

    const job = await fetchDeliveryJob();
    expect(job).not.toBeNull();
    expect(job!.data.deliveryId).toBe(delivery.id);
    expect(job!.data.expectedAttemptNumber).toBe(1);

    // Exactly one job.
    await completeDeliveryJob(job!.id);
    expect(await fetchDeliveryJob()).toBeNull();
  });

  it("Test 3: duplicate request creates NO extra Delivery/job", async () => {
    const endpointId = await makeEndpoint();
    const key = uniqueKey();
    const body = { type: "order.created", data: { n: 1 } };

    const res1 = await sendEvent(endpointId, key, body);
    const res2 = await sendEvent(endpointId, key, body);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(200);
    const j1 = (await res1.json()) as { id: string };
    const j2 = (await res2.json()) as { id: string };
    expect(j2.id).toBe(j1.id);

    const event = await eventIdForKey(key);
    expect(await prisma.delivery.count({ where: { eventId: event!.id } })).toBe(1);

    // Exactly one logical queue job.
    const job = await fetchDeliveryJob();
    expect(job).not.toBeNull();
    await completeDeliveryJob(job!.id);
    expect(await fetchDeliveryJob()).toBeNull();
  });

  it("Test 4: conflicting duplicate (same key, different body) creates nothing new", async () => {
    const endpointId = await makeEndpoint();
    const key = uniqueKey();

    const res1 = await sendEvent(endpointId, key, { type: "order.created", data: { v: "A" } });
    const res2 = await sendEvent(endpointId, key, { type: "order.created", data: { v: "B" } });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(409);

    expect(await prisma.event.count({ where: { accountId, idempotencyKey: key } })).toBe(1);
    const event = await eventIdForKey(key);
    expect(await prisma.delivery.count({ where: { eventId: event!.id } })).toBe(1);

    // Only the first request's job exists.
    const job = await fetchDeliveryJob();
    expect(job).not.toBeNull();
    await completeDeliveryJob(job!.id);
    expect(await fetchDeliveryJob()).toBeNull();
  });

  it("Test 5: transaction atomicity — failure after enqueue rolls back Event, Delivery, and job", async () => {
    const endpointId = await makeEndpoint();
    const key = uniqueKey();

    const deliveriesBefore = await prisma.delivery.count();

    // Inject a failure AFTER the job has been enqueued inside the transaction,
    // to prove the job send participates in the same transaction and rolls back.
    const failingEnqueue = async (
      tx: Parameters<typeof enqueueDeliveryJob>[0],
      payload: Parameters<typeof enqueueDeliveryJob>[1]
    ) => {
      await enqueueDeliveryJob(tx, payload);
      throw new Error("boom after enqueue");
    };

    await expect(
      ingestEvent(
        {
          accountId,
          endpointId,
          eventType: "order.created",
          payloadRaw: JSON.stringify({ type: "order.created", data: { x: 1 } }),
          idempotencyKey: key,
        },
        failingEnqueue
      )
    ).rejects.toThrow("boom after enqueue");

    // Nothing persisted.
    expect(await prisma.event.count({ where: { accountId, idempotencyKey: key } })).toBe(0);
    expect(await prisma.delivery.count()).toBe(deliveriesBefore);
    expect(await fetchDeliveryJob()).toBeNull();
  });

  it("Test 6: worker manual consumption — fetch, read payload, complete", async () => {
    const endpointId = await makeEndpoint();
    const key = uniqueKey();

    const res = await sendEvent(endpointId, key, { type: "order.created", data: {} });
    expect(res.status).toBe(201);

    const event = await eventIdForKey(key);
    const delivery = await prisma.delivery.findFirstOrThrow({
      where: { eventId: event!.id },
    });

    // Single-iteration equivalent of the worker loop.
    const job = await fetchDeliveryJob();
    expect(job).not.toBeNull();
    expect(job!.data.deliveryId).toBe(delivery.id);
    await completeDeliveryJob(job!.id);

    // Completed -> nothing left to fetch.
    expect(await fetchDeliveryJob()).toBeNull();
  });

  it("Test 7: concurrent identical requests -> one Event, one Delivery, one job", async () => {
    const endpointId = await makeEndpoint();
    const key = uniqueKey();
    const body = { type: "order.created", data: { c: 1 } };

    const [res1, res2] = await Promise.all([
      sendEvent(endpointId, key, body),
      sendEvent(endpointId, key, body),
    ]);

    expect([res1.status, res2.status].sort()).toEqual([200, 201]);
    const j1 = (await res1.json()) as { id: string };
    const j2 = (await res2.json()) as { id: string };
    expect(j1.id).toBe(j2.id);

    expect(await prisma.event.count({ where: { accountId, idempotencyKey: key } })).toBe(1);
    const event = await eventIdForKey(key);
    expect(await prisma.delivery.count({ where: { eventId: event!.id } })).toBe(1);

    // Exactly one job.
    const job = await fetchDeliveryJob();
    expect(job).not.toBeNull();
    await completeDeliveryJob(job!.id);
    expect(await fetchDeliveryJob()).toBeNull();
  });
});
