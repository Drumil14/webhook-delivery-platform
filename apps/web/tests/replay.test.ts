import { createServer as createHttpsServer, type Server } from "node:https";
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
  tryAcquireEndpointRateLimit,
} from "@webhook/db";
import { DEMO_RETRY_POLICY } from "@webhook/shared";

import { processDeliveryJob } from "@webhook/worker/process-delivery";
import { secureWebhookRequest } from "@webhook/worker/secure-transport";

import { replayDelivery, type ReplayEnqueueFn } from "@/lib/replay-delivery";
import { handleDemoReceiver } from "@/lib/demo-receiver";
import {
  deleteEndpointsAndWindows,
  ingestForEndpoint,
  insertEndpointRow,
  loadTestCerts,
  spyTransport,
} from "./helpers/phase6";

// ---- HTTPS verify-signature receiver (for the P7-17 security regression) ----
const { ca, cert, key } = loadTestCerts();
let server: Server;
let port = 0;

function startServer(): Promise<void> {
  server = createHttpsServer({ cert, key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(", "));
      }
      const request = new Request("http://receiver/verify-signature", { method: "POST", headers, body });
      const response = await handleDemoReceiver("verify-signature", request as never);
      const text = await response.text();
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(text);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
}

const pin127 = async () => ({ ok: true as const, pinnedIp: "127.0.0.1", family: 4 as const });

let accountId: string;
const usedKeys: string[] = [];
const endpointIds: string[] = [];

function uniqueKey(): string {
  const k = `p7replay-${randomUUID()}`;
  usedKeys.push(k);
  return k;
}

async function makeEndpoint(
  opts: { url?: string; status?: "active" | "paused"; rateLimitPerMinute?: number } = {}
): Promise<string> {
  const url = opts.url ?? `https://webhook.test/replay-${randomUUID()}`;
  const ep = await insertEndpointRow(accountId, url, {
    status: opts.status,
    rateLimitPerMinute: opts.rateLimitPerMinute,
  });
  endpointIds.push(ep.id);
  return ep.id;
}

/** Ingest an event, discard its automatic job, and mark the Delivery dead. */
async function makeDeadDelivery(
  endpointId: string,
  key: string
): Promise<{ deliveryId: string; eventId: string }> {
  const { deliveryId, eventId } = await ingestForEndpoint(accountId, endpointId, key);
  const job = await fetchDeliveryJob({ ignoreStartAfter: true });
  if (job) await completeDeliveryJob(job.id);
  await prisma.delivery.update({
    where: { id: deliveryId },
    data: { status: "dead", attemptCount: 2, nextRetryAt: null },
  });
  return { deliveryId, eventId };
}

beforeAll(async () => {
  await startServer();
  accountId = (await ensureDemoAccount()).id;
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
        await prisma.deliveryAttempt.deleteMany({ where: { deliveryId: { in: deliveryIds } } });
      }
      await prisma.delivery.deleteMany({ where: { eventId: { in: eventIds } } });
      await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    }
  }
  await deleteEndpointsAndWindows(endpointIds);
  await purgeDeliveryQueue();
  await stopDeliveryQueue();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe("Phase 7 — manual replay", () => {
  it("P7-10: replay of a dead delivery creates a new manual_replay Delivery", async () => {
    const endpointId = await makeEndpoint();
    const { deliveryId: origId, eventId } = await makeDeadDelivery(endpointId, uniqueKey());

    const res = await replayDelivery(origId, accountId);
    expect(res.status).toBe(201);
    if (res.status !== 201) return;

    expect(res.body.eventId).toBe(eventId); // same Event
    expect(res.body.id).not.toBe(origId); // new Delivery
    expect(res.body.status).toBe("pending");
    expect(res.body.attemptCount).toBe(0);
    expect(res.body.triggeredBy).toBe("manual_replay");
    expect(res.body.replayOfDeliveryId).toBe(origId);
    expect(res.body.maxAttempts).toBe(DEMO_RETRY_POLICY.maxAttempts); // fresh budget

    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    expect(job!.data.deliveryId).toBe(res.body.id);
    expect(job!.data.expectedAttemptNumber).toBe(1);
    await completeDeliveryJob(job!.id);

    // Original is untouched.
    const orig = await prisma.delivery.findUniqueOrThrow({ where: { id: origId } });
    expect(orig.status).toBe("dead");
    expect(orig.attemptCount).toBe(2);
  });

  it("P7-11: replay does not create a new Event", async () => {
    const endpointId = await makeEndpoint();
    const { deliveryId } = await makeDeadDelivery(endpointId, uniqueKey());

    const before = await prisma.event.count({ where: { accountId } });
    const res = await replayDelivery(deliveryId, accountId);
    expect(res.status).toBe(201);
    const after = await prisma.event.count({ where: { accountId } });
    expect(after).toBe(before);
  });

  it("P7-12: replay of a non-dead delivery is rejected (409)", async () => {
    const endpointId = await makeEndpoint();
    const { deliveryId, eventId } = await ingestForEndpoint(accountId, endpointId, uniqueKey());
    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    await completeDeliveryJob(job!.id);

    // pending -> 409
    const pendingRes = await replayDelivery(deliveryId, accountId);
    expect(pendingRes.status).toBe(409);
    if (pendingRes.status === 409) expect(pendingRes.body.error).toBe("DELIVERY_NOT_REPLAYABLE");

    // succeeded -> 409
    await prisma.delivery.update({ where: { id: deliveryId }, data: { status: "succeeded" } });
    const succRes = await replayDelivery(deliveryId, accountId);
    expect(succRes.status).toBe(409);

    // Nothing new was created.
    expect(await prisma.delivery.count({ where: { eventId, triggeredBy: "manual_replay" } })).toBe(0);
    expect(await fetchDeliveryJob({ ignoreStartAfter: true })).toBeNull();
  });

  it("P7-13: replay rolls back atomically (no new Delivery, no new job)", async () => {
    const endpointId = await makeEndpoint();
    const { deliveryId, eventId } = await makeDeadDelivery(endpointId, uniqueKey());

    const failing: ReplayEnqueueFn = async (tx, payload) => {
      await enqueueDeliveryJob(tx, payload);
      throw new Error("boom after enqueue");
    };

    await expect(replayDelivery(deliveryId, accountId, failing)).rejects.toThrow("boom after enqueue");

    expect(await prisma.delivery.count({ where: { eventId, triggeredBy: "manual_replay" } })).toBe(0);
    expect(await fetchDeliveryJob({ ignoreStartAfter: true })).toBeNull();
    const orig = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(orig.status).toBe("dead");
  });

  it("P7-14: replay while paused -> new Delivery created, worker defers it", async () => {
    const endpointId = await makeEndpoint({ status: "paused" });
    const { deliveryId: origId } = await makeDeadDelivery(endpointId, uniqueKey());

    const res = await replayDelivery(origId, accountId);
    expect(res.status).toBe(201);
    if (res.status !== 201) return;
    const newId = res.body.id;

    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    expect(job!.data.deliveryId).toBe(newId);
    const spy = spyTransport();
    await processDeliveryJob(job!, { transport: spy.transport, pauseRecheckMs: 5_000 });

    expect(spy.calls).toHaveLength(0);
    expect(await prisma.deliveryAttempt.count({ where: { deliveryId: newId } })).toBe(0);
    expect((await prisma.delivery.findUniqueOrThrow({ where: { id: newId } })).status).toBe("pending");
  });

  it("P7-15: replay shares the endpoint rate limit (no bypass)", async () => {
    const endpointId = await makeEndpoint({ rateLimitPerMinute: 1 });
    const nowMs = Date.UTC(2026, 0, 1, 9, 0, 15);
    // Exhaust the window before replaying.
    expect((await tryAcquireEndpointRateLimit(endpointId, 1, nowMs)).allowed).toBe(true);

    const { deliveryId: origId } = await makeDeadDelivery(endpointId, uniqueKey());
    const res = await replayDelivery(origId, accountId);
    expect(res.status).toBe(201);
    if (res.status !== 201) return;
    const newId = res.body.id;

    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    const spy = spyTransport();
    await processDeliveryJob(job!, { now: () => nowMs, transport: spy.transport });

    // Deferred by the same limiter — no bypass for replay traffic.
    expect(spy.calls).toHaveLength(0);
    const nd = await prisma.delivery.findUniqueOrThrow({ where: { id: newId } });
    expect(nd.status).toBe("pending");
    expect(nd.attemptCount).toBe(0);
  });

  it("P7-17: replay uses the SAME security pipeline (HMAC + pinned HTTPS + TLS)", async () => {
    const endpointId = await makeEndpoint({ url: `https://webhook.test:${port}/verify-signature` });
    const { deliveryId: origId } = await makeDeadDelivery(endpointId, uniqueKey());

    const res = await replayDelivery(origId, accountId);
    expect(res.status).toBe(201);
    if (res.status !== 201) return;
    const newId = res.body.id;

    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    await processDeliveryJob(job!, {
      transport: (req) => secureWebhookRequest(req, { resolveHost: pin127, tlsCa: ca }),
    });

    // Delivered over real pinned HTTPS; the receiver verified the HMAC signature.
    const nd = await prisma.delivery.findUniqueOrThrow({ where: { id: newId } });
    expect(nd.status).toBe("succeeded");
    const a = await prisma.deliveryAttempt.findFirstOrThrow({ where: { deliveryId: newId } });
    expect(a.outcome).toBe("success");
    expect(a.responseStatus).toBe(200);
    expect(a.resolvedIp).toBe("127.0.0.1");
    const headers = a.requestHeaders as Record<string, string>;
    expect(headers["x-webhook-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]+$/);
  });
});
