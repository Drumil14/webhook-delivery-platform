import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  completeDeliveryJob,
  DELIVERY_QUEUE_CONFIG,
  ensureDemoAccount,
  failDeliveryJob,
  fetchDeliveryJob,
  finalizeDelivery,
  getDeliveryJobState,
  getDeliveryQueueConfig,
  prisma,
  purgeDeliveryQueue,
  stopDeliveryQueue,
  type FinalizeAttempt,
  type FinalizeInput,
} from "@webhook/db";
import type { RetryPolicy } from "@webhook/shared";

import {
  processDeliveryJob,
  WEBHOOK_TIMEOUT_MS,
} from "@webhook/worker/process-delivery";

import { handleDemoReceiver } from "@/lib/demo-receiver";
import { POST as postEvent } from "@/app/api/v1/endpoints/[endpointId]/events/route";
import { deleteEndpointsAndWindows, httpLoopbackTransport, insertEndpointRow } from "./helpers/phase6";

// Deterministic loopback transport: the worker's SSRF-safe HTTPS transport can't
// reach the plain-HTTP local receiver, so Phase 5 reliability tests inject this
// (it still honors redirect:manual + timeout). The REAL pinned HTTPS transport
// is exercised in secure-delivery.test.ts.
const LOOPBACK = httpLoopbackTransport();

// Fast policy for driving retries in tests: tiny delays, no jitter. The retry
// BUDGET still comes from Delivery.maxAttempts, not this policy.
const TINY_POLICY: RetryPolicy = {
  baseDelayMs: 1,
  multiplier: 1,
  maxDelayMs: 5,
  maxAttempts: 6,
  jitterPercent: 0,
};

// A local HTTP server that delegates to the REAL built-in demo receiver (so the
// DB-backed fail-then-succeed counter is exercised for real), reachable over
// real HTTP by the worker.
let server: Server;
let baseUrl: string;
let deadPort: number; // a closed port for deterministic network errors
// Records every path the server received, so a test can prove a redirect target
// was NOT followed.
const hitPaths: string[] = [];

function startReceiverServer(): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const mode = (req.url ?? "/").replace(/^\//, "").split("?")[0]!;
      hitPaths.push(req.url ?? "");

      // Controlled redirect endpoints (not part of the demo receiver).
      if (mode === "redirect") {
        res.writeHead(302, { location: `${baseUrl}/final` });
        res.end("redirecting");
        return;
      }
      if (mode === "final") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"final":true}');
        return;
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(", "));
      }
      const request = new Request(`http://receiver/${mode}`, {
        method: "POST",
        headers,
        body,
      });
      try {
        // Use a short /timeout delay (still > any injected worker timeout).
        const response = await handleDemoReceiver(mode, request as never, {
          timeoutDelayMs: 800,
        });
        const text = await response.text();
        const outHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => (outHeaders[key] = value));
        res.writeHead(response.status, outHeaders);
        res.end(text);
      } catch {
        try {
          res.writeHead(500);
          res.end();
        } catch {
          /* client may have aborted (timeout test) */
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
}

function findDeadPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

let accountId: string;
const createdEndpointIds: string[] = [];
const usedKeys: string[] = [];

function uniqueKey(): string {
  const key = `p5-${randomUUID()}`;
  usedKeys.push(key);
  return key;
}

// Insert the Endpoint row directly (http loopback URL bypasses creation SSRF).
async function makeEndpoint(url: string): Promise<string> {
  const ep = await insertEndpointRow(accountId, url);
  createdEndpointIds.push(ep.id);
  return ep.id;
}

async function ingest(endpointId: string, key: string): Promise<string> {
  const req = new Request(`http://test/api/v1/endpoints/${endpointId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ type: "order.created", data: { k: key } }),
  });
  const res = await postEvent(req as never, {
    params: Promise.resolve({ endpointId }),
  });
  expect(res.status).toBe(201);
  const event = await prisma.event.findUniqueOrThrow({
    where: { accountId_idempotencyKey: { accountId, idempotencyKey: key } },
    select: { id: true },
  });
  const delivery = await prisma.delivery.findFirstOrThrow({
    where: { eventId: event.id },
    select: { id: true },
  });
  return delivery.id;
}

async function drive(deliveryId: string): Promise<void> {
  for (let i = 0; i < 15; i++) {
    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    if (!job) break;
    await processDeliveryJob(job, { policy: TINY_POLICY, random: () => 0.5, transport: LOOPBACK });
    const d = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
      select: { status: true },
    });
    if (d.status !== "pending") break;
  }
}

function fixtureAttempt(): FinalizeAttempt {
  return {
    requestHeaders: {},
    responseStatus: 500,
    responseHeaders: {},
    responseBodySnippet: null,
    errorMessage: null,
    durationMs: 1,
    resolvedIp: null,
    outcome: "failure",
  };
}

beforeAll(async () => {
  await startReceiverServer();
  deadPort = await findDeadPort();
  const account = await ensureDemoAccount();
  accountId = account.id;
});

beforeEach(async () => {
  await purgeDeliveryQueue();
  hitPaths.length = 0;
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
        await prisma.demoReceiverState.deleteMany({ where: { deliveryId: { in: deliveryIds } } });
      }
      await prisma.delivery.deleteMany({ where: { eventId: { in: eventIds } } });
      await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    }
  }
  await deleteEndpointsAndWindows(createdEndpointIds);
  await purgeDeliveryQueue();
  await stopDeliveryQueue();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe("Phase 5 — retries, backoff, timeout, DLQ, recovery", () => {
  it("P5-3: retryable 500 schedules the next attempt", async () => {
    const endpointId = await makeEndpoint(`${baseUrl}/failure`);
    const deliveryId = await ingest(endpointId, uniqueKey());

    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    await processDeliveryJob(job!, { policy: TINY_POLICY, random: () => 0.5, transport: LOOPBACK });

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("pending");
    expect(d.attemptCount).toBe(1);
    expect(d.nextRetryAt).not.toBeNull();

    const attempts = await prisma.deliveryAttempt.findMany({ where: { deliveryId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe("failure");
    expect(attempts[0]!.responseStatus).toBe(500);

    const next = await fetchDeliveryJob({ ignoreStartAfter: true });
    expect(next!.data.deliveryId).toBe(deliveryId);
    expect(next!.data.expectedAttemptNumber).toBe(2);
    await completeDeliveryJob(next!.id);
  });

  it("P5-4: fail-then-succeed drives to succeeded in 3 attempts", async () => {
    const endpointId = await makeEndpoint(`${baseUrl}/fail-then-succeed`);
    const deliveryId = await ingest(endpointId, uniqueKey());

    await drive(deliveryId);

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("succeeded");
    expect(d.attemptCount).toBe(3);
    expect(d.nextRetryAt).toBeNull();

    const attempts = await prisma.deliveryAttempt.findMany({
      where: { deliveryId },
      orderBy: { attemptNumber: "asc" },
    });
    expect(attempts.map((a) => a.responseStatus)).toEqual([500, 500, 200]);
  });

  it("P5-5: always-500 exhausts maxAttempts -> dead", async () => {
    const endpointId = await makeEndpoint(`${baseUrl}/failure`);
    const deliveryId = await ingest(endpointId, uniqueKey());
    // Shrink the budget for a fast test (Delivery owns its budget).
    await prisma.delivery.update({ where: { id: deliveryId }, data: { maxAttempts: 3 } });

    await drive(deliveryId);

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("dead");
    expect(d.attemptCount).toBe(3);
    expect(d.nextRetryAt).toBeNull();

    expect(await prisma.deliveryAttempt.count({ where: { deliveryId } })).toBe(3);
    expect(await fetchDeliveryJob({ ignoreStartAfter: true })).toBeNull(); // no next job
  });

  it("P5-6: Retry-After makes nextRetryAt at least 5s out", async () => {
    const endpointId = await makeEndpoint(`${baseUrl}/rate-limit`);
    const deliveryId = await ingest(endpointId, uniqueKey());
    const fixedNow = Date.now();

    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    // Demo policy backoff for attempt 2 (~1.6s at random=0) < 5s, so Retry-After wins.
    await processDeliveryJob(job!, { now: () => fixedNow, random: () => 0, transport: LOOPBACK });

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("pending");
    expect(d.attemptCount).toBe(1);
    expect(d.nextRetryAt!.getTime() - fixedNow).toBeGreaterThanOrEqual(5_000);

    const a = await prisma.deliveryAttempt.findFirstOrThrow({ where: { deliveryId } });
    expect(a.responseStatus).toBe(429);
    expect(a.outcome).toBe("failure");
  });

  it("P5-7: default timeout is 10s; an injected short timeout aborts -> outcome=timeout", async () => {
    expect(WEBHOOK_TIMEOUT_MS).toBe(10_000);

    const endpointId = await makeEndpoint(`${baseUrl}/timeout`); // receiver waits 800ms
    const deliveryId = await ingest(endpointId, uniqueKey());

    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    await processDeliveryJob(job!, { policy: TINY_POLICY, timeoutMs: 200, random: () => 0.5, transport: LOOPBACK });

    const a = await prisma.deliveryAttempt.findFirstOrThrow({ where: { deliveryId } });
    expect(a.outcome).toBe("timeout");
    expect(a.errorMessage).toContain("timed out");
    expect(a.responseStatus).toBeNull();

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("pending"); // retryable, budget remains
    expect(d.nextRetryAt).not.toBeNull();
  });

  it("P5-8: network error -> outcome=network_error, retry scheduled, worker survives", async () => {
    const endpointId = await makeEndpoint(`http://127.0.0.1:${deadPort}/`);
    const deliveryId = await ingest(endpointId, uniqueKey());

    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    // Must not throw out of processDeliveryJob.
    await processDeliveryJob(job!, { policy: TINY_POLICY, timeoutMs: 3_000, random: () => 0.5, transport: LOOPBACK });

    const a = await prisma.deliveryAttempt.findFirstOrThrow({ where: { deliveryId } });
    expect(a.outcome).toBe("network_error");
    expect(a.responseStatus).toBeNull();

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("pending");
    expect(d.nextRetryAt).not.toBeNull();

    const next = await fetchDeliveryJob({ ignoreStartAfter: true });
    expect(next!.data.expectedAttemptNumber).toBe(2);
    await completeDeliveryJob(next!.id);
  });

  it("P5-9: retry finalize rollback leaves nothing changed", async () => {
    const endpointId = await makeEndpoint(`${baseUrl}/failure`);
    const deliveryId = await ingest(endpointId, uniqueKey());
    const job = await fetchDeliveryJob({ ignoreStartAfter: true });

    const nextRetryAt = new Date(Date.now() + 1_000);
    const { eventId } = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
      select: { eventId: true },
    });
    const input: FinalizeInput = {
      deliveryId,
      expectedAttemptNumber: 1,
      jobId: job!.id,
      accountId,
      eventId,
      newStatus: "pending",
      nextRetryAt,
      attempt: fixtureAttempt(),
      retry: { nextExpectedAttemptNumber: 2, startAfter: nextRetryAt },
    };

    await expect(
      finalizeDelivery(input, { beforeCommit: async () => { throw new Error("boom"); } })
    ).rejects.toThrow("boom");

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.attemptCount).toBe(0);
    expect(d.status).toBe("pending");
    expect(d.nextRetryAt).toBeNull();
    expect(await prisma.deliveryAttempt.count({ where: { deliveryId } })).toBe(0);
    // No next job was created, and the current job was NOT completed.
    expect(await fetchDeliveryJob({ ignoreStartAfter: true })).toBeNull();
    expect(await getDeliveryJobState(job!.id)).not.toBe("completed");
  });

  it("P5-10: stale retry completion is discarded", async () => {
    const endpointId = await makeEndpoint(`${baseUrl}/failure`);
    const deliveryId = await ingest(endpointId, uniqueKey());
    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    await prisma.delivery.update({ where: { id: deliveryId }, data: { attemptCount: 5 } });

    const nextRetryAt = new Date(Date.now() + 1_000);
    const { eventId } = await prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
      select: { eventId: true },
    });
    const result = await finalizeDelivery({
      deliveryId,
      expectedAttemptNumber: 1, // guard wants attemptCount=0, but it's 5 -> stale
      jobId: job!.id,
      accountId,
      eventId,
      newStatus: "pending",
      nextRetryAt,
      attempt: fixtureAttempt(),
      retry: { nextExpectedAttemptNumber: 2, startAfter: nextRetryAt },
    });

    expect(result).toBe("stale");
    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.attemptCount).toBe(5);
    expect(d.status).toBe("pending");
    expect(await prisma.deliveryAttempt.count({ where: { deliveryId } })).toBe(0);
  });

  it("P5-11: pg-boss infra failure makes an uncompleted job eligible again", async () => {
    const endpointId = await makeEndpoint(`${baseUrl}/success`);
    const deliveryId = await ingest(endpointId, uniqueKey());

    const job = await fetchDeliveryJob({ ignoreStartAfter: true }); // claimed (active)
    expect(job).not.toBeNull();

    // Simulate a worker that claimed but never completed (crash/expiry).
    await failDeliveryJob(job!.id);

    // Infra retry budget makes it eligible again (same job id / deliveryId).
    const reclaimed = await fetchDeliveryJob({ ignoreStartAfter: true });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.data.deliveryId).toBe(deliveryId);

    await completeDeliveryJob(reclaimed!.id);
  });

  it("P5-12: 404 remains permanent (no retry)", async () => {
    const endpointId = await makeEndpoint(`${baseUrl}/not-found`);
    const deliveryId = await ingest(endpointId, uniqueKey());

    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    await processDeliveryJob(job!, { policy: TINY_POLICY, random: () => 0.5, transport: LOOPBACK });

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("dead");
    expect(d.attemptCount).toBe(1);

    const a = await prisma.deliveryAttempt.findFirstOrThrow({ where: { deliveryId } });
    expect(a.outcome).toBe("failure");
    expect(a.responseStatus).toBe(404);

    expect(await fetchDeliveryJob({ ignoreStartAfter: true })).toBeNull();
  });

  it("P5-13: live pg-boss queue config matches the desired infra retry settings", async () => {
    const cfg = await getDeliveryQueueConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.retryLimit).toBe(DELIVERY_QUEUE_CONFIG.retryLimit); // 3
    expect(cfg!.retryDelay).toBe(DELIVERY_QUEUE_CONFIG.retryDelay); // 2
    expect(cfg!.expireInSeconds).toBe(DELIVERY_QUEUE_CONFIG.expireInSeconds); // 60
  });

  it("P5-14: 302 redirect is NOT followed -> records 302, Delivery dead", async () => {
    const endpointId = await makeEndpoint(`${baseUrl}/redirect`);
    const deliveryId = await ingest(endpointId, uniqueKey());

    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    await processDeliveryJob(job!, { policy: TINY_POLICY, random: () => 0.5, transport: LOOPBACK });

    // The redirect target must NOT have been fetched.
    expect(hitPaths).toContain("/redirect");
    expect(hitPaths).not.toContain("/final");

    const a = await prisma.deliveryAttempt.findFirstOrThrow({ where: { deliveryId } });
    expect(a.responseStatus).toBe(302);
    expect(a.outcome).toBe("failure");

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("dead");
    expect(d.attemptCount).toBe(1);
    expect(await fetchDeliveryJob({ ignoreStartAfter: true })).toBeNull(); // no retry
  });
});
