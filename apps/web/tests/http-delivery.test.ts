import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ensureDemoAccount,
  fetchDeliveryJob,
  finalizeDelivery,
  getDeliveryJobState,
  prisma,
  purgeDeliveryQueue,
  stopDeliveryQueue,
  type FinalizeAttempt,
  type FinalizeInput,
} from "@webhook/db";

import { processDeliveryJob } from "@webhook/worker/process-delivery";

import { POST as createEndpoint } from "@/app/api/v1/endpoints/route";
import { POST as postEvent } from "@/app/api/v1/endpoints/[endpointId]/events/route";

// ---- Controlled local HTTP test server (exists only in tests) --------------
type Received = {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
};

const received: Received[] = [];
const LARGE_BODY = "x".repeat(30 * 1024); // 30 KB, to exercise the ~10 KB cap
let server: Server;
let baseUrl: string;

function startServer(): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      received.push({
        url: req.url ?? "",
        method: req.method ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
        headers: req.headers,
      });
      switch (req.url) {
        case "/success":
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"ok":true}');
          break;
        case "/not-found":
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("nope");
          break;
        case "/large":
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(LARGE_BODY);
          break;
        default:
          res.writeHead(404);
          res.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

// ---- test helpers ----------------------------------------------------------
let accountId: string;
const createdEndpointIds: string[] = [];
const usedKeys: string[] = [];

function uniqueKey(): string {
  const key = `p3-${randomUUID()}`;
  usedKeys.push(key);
  return key;
}

async function makeEndpoint(path: string): Promise<string> {
  const req = new Request("http://test/api/v1/endpoints", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `${baseUrl}${path}` }),
  });
  const res = await createEndpoint(req as never);
  expect(res.status).toBe(201);
  const json = (await res.json()) as { id: string };
  createdEndpointIds.push(json.id);
  return json.id;
}

function sendEvent(endpointId: string, key: string, body: unknown) {
  const req = new Request(`http://test/api/v1/endpoints/${endpointId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return postEvent(req as never, { params: Promise.resolve({ endpointId }) });
}

async function loadForKey(key: string) {
  const event = await prisma.event.findUniqueOrThrow({
    where: { accountId_idempotencyKey: { accountId, idempotencyKey: key } },
    select: { id: true, payloadRaw: true },
  });
  const delivery = await prisma.delivery.findFirstOrThrow({
    where: { eventId: event.id },
  });
  return { event, delivery };
}

async function processNext(): Promise<void> {
  const job = await fetchDeliveryJob();
  expect(job).not.toBeNull();
  await processDeliveryJob(job!);
}

function fixtureAttempt(): FinalizeAttempt {
  return {
    requestHeaders: { "content-type": "application/json" },
    responseStatus: 200,
    responseHeaders: { "content-type": "application/json" },
    responseBodySnippet: null,
    errorMessage: null,
    durationMs: 1,
    resolvedIp: null,
    outcome: "success",
  };
}

beforeAll(async () => {
  await startServer();
  const account = await ensureDemoAccount();
  accountId = account.id;
});

beforeEach(async () => {
  await purgeDeliveryQueue();
});

afterAll(async () => {
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
        await prisma.deliveryAttempt.deleteMany({
          where: { deliveryId: { in: deliveryIds } },
        });
      }
      await prisma.delivery.deleteMany({ where: { eventId: { in: eventIds } } });
      await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    }
  }
  if (createdEndpointIds.length > 0) {
    await prisma.endpoint.deleteMany({ where: { id: { in: createdEndpointIds } } });
  }
  await purgeDeliveryQueue();
  await stopDeliveryQueue();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe("Phase 3 — HTTP delivery + guarded finalize", () => {
  it("P3-1: successful HTTP delivery -> succeeded, attemptCount=1, exact body received", async () => {
    const endpointId = await makeEndpoint("/success");
    const key = uniqueKey();
    expect((await sendEvent(endpointId, key, { type: "order.created", data: { x: 1 } })).status).toBe(201);

    const { event } = await loadForKey(key);
    await processNext();

    const rec = received.find((r) => r.headers["x-webhook-event-id"] === event.id);
    expect(rec).toBeDefined();
    expect(rec!.body).toBe(event.payloadRaw);

    const delivery = await prisma.delivery.findFirstOrThrow({ where: { eventId: event.id } });
    expect(delivery.status).toBe("succeeded");
    expect(delivery.attemptCount).toBe(1);
  });

  it("P3-2: DeliveryAttempt recorded with response details", async () => {
    const endpointId = await makeEndpoint("/success");
    const key = uniqueKey();
    await sendEvent(endpointId, key, { type: "order.created", data: { y: 2 } });

    const { delivery } = await loadForKey(key);
    await processNext();

    const attempts = await prisma.deliveryAttempt.findMany({ where: { deliveryId: delivery.id } });
    expect(attempts).toHaveLength(1);
    const a = attempts[0]!;
    expect(a.attemptNumber).toBe(1);
    expect(a.outcome).toBe("success");
    expect(a.responseStatus).toBe(200);
    expect(a.durationMs).toBeGreaterThanOrEqual(0);
    expect((a.requestHeaders as Record<string, string>)["content-type"]).toBe("application/json");
    expect(a.responseHeaders).toBeTruthy();
    expect(a.responseBodySnippet).toBe('{"ok":true}');
  });

  it("P3-3: permanent failure (404) -> dead, attemptCount=1, no retry job", async () => {
    const endpointId = await makeEndpoint("/not-found");
    const key = uniqueKey();
    await sendEvent(endpointId, key, { type: "order.created", data: {} });

    const { delivery } = await loadForKey(key);
    await processNext();

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(d.status).toBe("dead");
    expect(d.attemptCount).toBe(1);

    const attempts = await prisma.deliveryAttempt.findMany({ where: { deliveryId: delivery.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe("failure");
    expect(attempts[0]!.responseStatus).toBe(404);

    expect(await fetchDeliveryJob()).toBeNull(); // no retry job created
  });

  it("P3-4: exact body preservation (weird whitespace)", async () => {
    const endpointId = await makeEndpoint("/success");
    const key = uniqueKey();
    const raw = '{ "type" : "order.created", "data" : { "x" : 1 } }';
    expect((await sendEvent(endpointId, key, raw)).status).toBe(201);

    const { event } = await loadForKey(key);
    expect(event.payloadRaw).toBe(raw); // stored verbatim

    await processNext();

    const rec = received.find((r) => r.headers["x-webhook-event-id"] === event.id);
    expect(rec!.body).toBe(raw); // transmitted verbatim (not re-serialized)
  });

  it("P3-5: response body truncated to ~10 KB", async () => {
    const endpointId = await makeEndpoint("/large");
    const key = uniqueKey();
    await sendEvent(endpointId, key, { type: "order.created", data: {} });

    const { delivery } = await loadForKey(key);
    await processNext();

    const a = await prisma.deliveryAttempt.findFirstOrThrow({ where: { deliveryId: delivery.id } });
    expect(a.responseBodySnippet).toBeTruthy();
    expect(a.responseBodySnippet!.length).toBeLessThanOrEqual(10 * 1024);
    expect(a.responseBodySnippet!.length).toBeLessThan(LARGE_BODY.length);
  });

  it("P3-6: guard wins once under concurrent finalize", async () => {
    const endpointId = await makeEndpoint("/success");
    const key = uniqueKey();
    await sendEvent(endpointId, key, { type: "order.created", data: {} });

    const { delivery } = await loadForKey(key);
    const job = await fetchDeliveryJob();
    expect(job).not.toBeNull();

    const input: FinalizeInput = {
      deliveryId: delivery.id,
      expectedAttemptNumber: 1,
      jobId: job!.id,
      newStatus: "succeeded",
      nextRetryAt: null,
      attempt: fixtureAttempt(),
    };

    const [r1, r2] = await Promise.all([finalizeDelivery(input), finalizeDelivery(input)]);
    expect([r1, r2].sort()).toEqual(["stale", "won"]);

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(d.attemptCount).toBe(1);
    const attempts = await prisma.deliveryAttempt.findMany({ where: { deliveryId: delivery.id } });
    expect(attempts).toHaveLength(1);
  });

  it("P3-7: stale completion is discarded (guard mismatch)", async () => {
    const endpointId = await makeEndpoint("/success");
    const key = uniqueKey();
    await sendEvent(endpointId, key, { type: "order.created", data: {} });

    const { delivery } = await loadForKey(key);
    const job = await fetchDeliveryJob();

    // Make attemptCount no longer match expectedAttemptNumber - 1 (=0).
    await prisma.delivery.update({ where: { id: delivery.id }, data: { attemptCount: 5 } });

    const result = await finalizeDelivery({
      deliveryId: delivery.id,
      expectedAttemptNumber: 1,
      jobId: job!.id,
      newStatus: "succeeded",
      nextRetryAt: null,
      attempt: fixtureAttempt(),
    });

    expect(result).toBe("stale");
    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(d.attemptCount).toBe(5); // unchanged
    expect(d.status).toBe("pending"); // unchanged
    expect(await prisma.deliveryAttempt.count({ where: { deliveryId: delivery.id } })).toBe(0);
  });

  it("P3-8: finalize rollback leaves Delivery/attempt/job untouched", async () => {
    const endpointId = await makeEndpoint("/success");
    const key = uniqueKey();
    await sendEvent(endpointId, key, { type: "order.created", data: {} });

    const { delivery } = await loadForKey(key);
    const job = await fetchDeliveryJob();

    await expect(
      finalizeDelivery(
        {
          deliveryId: delivery.id,
          expectedAttemptNumber: 1,
          jobId: job!.id,
          newStatus: "succeeded",
          nextRetryAt: null,
          attempt: fixtureAttempt(),
        },
        { beforeCommit: async () => { throw new Error("boom before commit"); } }
      )
    ).rejects.toThrow("boom before commit");

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(d.attemptCount).toBe(0); // unchanged
    expect(d.status).toBe("pending"); // unchanged
    expect(await prisma.deliveryAttempt.count({ where: { deliveryId: delivery.id } })).toBe(0);

    // The queue completion rolled back with the transaction.
    expect(await getDeliveryJobState(job!.id)).not.toBe("completed");
  });
});
