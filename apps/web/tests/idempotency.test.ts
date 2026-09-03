import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ensureDemoAccount,
  prisma,
  stopDeliveryQueue,
} from "@webhook/db";

import { POST as postEvent } from "@/app/api/v1/endpoints/[endpointId]/events/route";
import { insertEndpointRow } from "./helpers/phase6";

// These are REAL integration tests: they call the actual route handlers, which
// hit the actual PostgreSQL database. Idempotency is NOT mocked.

let accountId: string;
const createdEndpointIds: string[] = [];
const usedKeys: string[] = [];

function uniqueKey(): string {
  const key = `test-${randomUUID()}`;
  usedKeys.push(key);
  return key;
}

// Insert the Endpoint row directly (Phase 6 SSRF rejects arbitrary URLs at the
// creation API; these idempotency tests only need an Endpoint to exist).
async function makeEndpoint(url = "https://example.com/webhook"): Promise<string> {
  const ep = await insertEndpointRow(accountId, url);
  createdEndpointIds.push(ep.id);
  return ep.id;
}

function eventRequest(endpointId: string, key: string, body: unknown): Request {
  return new Request(`http://test/api/v1/endpoints/${endpointId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function sendEvent(endpointId: string, key: string, body: unknown) {
  return postEvent(eventRequest(endpointId, key, body) as never, {
    params: Promise.resolve({ endpointId }),
  });
}

function countEvents(key: string): Promise<number> {
  return prisma.event.count({
    where: { accountId, idempotencyKey: key },
  });
}

beforeAll(async () => {
  const account = await ensureDemoAccount();
  accountId = account.id;
});

afterAll(async () => {
  // Clean up rows created by this test run. Deliveries reference Events (FK
  // RESTRICT), so delete Deliveries first.
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
    await prisma.endpoint.deleteMany({
      where: { id: { in: createdEndpointIds } },
    });
  }
  // Ingestion now starts pg-boss; stop it so the test process exits cleanly.
  await stopDeliveryQueue();
  await prisma.$disconnect();
});

describe("event ingestion idempotency", () => {
  it("new event -> 201 and exactly one Event exists", async () => {
    const endpointId = await makeEndpoint();
    const key = uniqueKey();

    const res = await sendEvent(endpointId, key, {
      type: "order.created",
      data: { orderId: "ord_1" },
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; eventType: string };
    expect(json.eventType).toBe("order.created");
    expect(await countEvents(key)).toBe(1);
  });

  it("same key + same payload -> returns same Event, only one row", async () => {
    const endpointId = await makeEndpoint();
    const key = uniqueKey();
    const body = { type: "order.created", data: { orderId: "ord_2" } };

    const res1 = await sendEvent(endpointId, key, body);
    const res2 = await sendEvent(endpointId, key, body);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(200); // safe retry
    const j1 = (await res1.json()) as { id: string };
    const j2 = (await res2.json()) as { id: string };
    expect(j2.id).toBe(j1.id);
    expect(await countEvents(key)).toBe(1);
  });

  it("same key + different payload -> 409 conflict", async () => {
    const endpointId = await makeEndpoint();
    const key = uniqueKey();

    const res1 = await sendEvent(endpointId, key, {
      type: "order.created",
      data: { orderId: "A" },
    });
    const res2 = await sendEvent(endpointId, key, {
      type: "order.created",
      data: { orderId: "B" },
    });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(409);
    const err = (await res2.json()) as { error: string };
    expect(err.error).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(await countEvents(key)).toBe(1);
  });

  it("same key + same body + DIFFERENT endpoint -> 409 (endpointId is in fingerprint)", async () => {
    const endpointA = await makeEndpoint("https://example.com/a");
    const endpointB = await makeEndpoint("https://example.com/b");
    const key = uniqueKey();
    const body = { type: "order.created", data: { orderId: "same" } };

    const resA = await sendEvent(endpointA, key, body);
    const resB = await sendEvent(endpointB, key, body);

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(409);
    expect(await countEvents(key)).toBe(1);
  });

  it("CONCURRENT identical requests -> exactly one row, both succeed, same id", async () => {
    const endpointId = await makeEndpoint();
    const key = uniqueKey();
    const body = { type: "order.created", data: { orderId: "concurrent-same" } };

    const [res1, res2] = await Promise.all([
      sendEvent(endpointId, key, body),
      sendEvent(endpointId, key, body),
    ]);

    // Both callers succeed (one created, one duplicate) — order not guaranteed.
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 201]);

    const j1 = (await res1.json()) as { id: string };
    const j2 = (await res2.json()) as { id: string };
    expect(j1.id).toBe(j2.id);

    expect(await countEvents(key)).toBe(1);
  });

  it("CONCURRENT same key + different body -> one 201, one 409, one row (order-independent)", async () => {
    const endpointId = await makeEndpoint();
    const key = uniqueKey();

    const [res1, res2] = await Promise.all([
      sendEvent(endpointId, key, { type: "order.created", data: { n: 1 } }),
      sendEvent(endpointId, key, { type: "order.created", data: { n: 2 } }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(await countEvents(key)).toBe(1);
  });
});
