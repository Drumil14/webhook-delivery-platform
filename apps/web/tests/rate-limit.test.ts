import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  completeDeliveryJob,
  deferDeliveryJob,
  ensureDemoAccount,
  fetchDeliveryJob,
  getDeliveryJobState,
  nextWindowStart,
  prisma,
  purgeDeliveryQueue,
  stopDeliveryQueue,
  tryAcquireEndpointRateLimit,
} from "@webhook/db";
import type { RetryPolicy } from "@webhook/shared";

import { processDeliveryJob } from "@webhook/worker/process-delivery";

import {
  deleteEndpointsAndWindows,
  ingestForEndpoint,
  insertEndpointRow,
  spyTransport,
} from "./helpers/phase6";

// Fast retry policy for the regression test.
const TINY_POLICY: RetryPolicy = {
  baseDelayMs: 1,
  multiplier: 1,
  maxDelayMs: 5,
  maxAttempts: 6,
  jitterPercent: 0,
};

let accountId: string;
const usedKeys: string[] = [];
const endpointIds: string[] = [];

function uniqueKey(): string {
  const k = `p7rl-${randomUUID()}`;
  usedKeys.push(k);
  return k;
}

async function makeEndpoint(rateLimitPerMinute: number): Promise<string> {
  const ep = await insertEndpointRow(accountId, `https://webhook.test/rl-${randomUUID()}`, {
    rateLimitPerMinute,
  });
  endpointIds.push(ep.id);
  return ep.id;
}

beforeAll(async () => {
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
  await prisma.$disconnect();
});

describe("Phase 7 — per-endpoint rate limiting", () => {
  it("P7-1: concurrent acquisition allows exactly `limit`, never more", async () => {
    const endpointId = await makeEndpoint(2);
    const now = Date.now();

    // 5 workers race for 2 slots in the SAME window.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => tryAcquireEndpointRateLimit(endpointId, 2, now))
    );
    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(2); // never 3+

    // The stored counter did not grow past the limit despite 3 denials.
    const win = await prisma.endpointRateWindow.findFirstOrThrow({ where: { endpointId } });
    expect(win.requestCount).toBe(2);
  });

  it("P7-4: window rollover restores capacity (injected clock)", async () => {
    const endpointId = await makeEndpoint(2);
    const t0 = Date.UTC(2026, 0, 1, 10, 24, 37); // 10:24:37 -> window 10:24:00

    expect((await tryAcquireEndpointRateLimit(endpointId, 2, t0)).allowed).toBe(true);
    expect((await tryAcquireEndpointRateLimit(endpointId, 2, t0)).allowed).toBe(true);
    expect((await tryAcquireEndpointRateLimit(endpointId, 2, t0)).allowed).toBe(false); // full

    // Advance into the next minute -> fresh window -> capacity again.
    const t1 = t0 + 60_000;
    expect((await tryAcquireEndpointRateLimit(endpointId, 2, t1)).allowed).toBe(true);
  });

  it("P7-2: over-limit job defers without an attempt", async () => {
    const endpointId = await makeEndpoint(1);
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 30);
    // Exhaust the window up front.
    expect((await tryAcquireEndpointRateLimit(endpointId, 1, nowMs)).allowed).toBe(true);

    const { deliveryId } = await ingestForEndpoint(accountId, endpointId, uniqueKey());
    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    const spy = spyTransport();
    await processDeliveryJob(job!, { now: () => nowMs, transport: spy.transport });

    // No HTTP, no attempt, attemptCount unchanged.
    expect(spy.calls).toHaveLength(0);
    expect(await prisma.deliveryAttempt.count({ where: { deliveryId } })).toBe(0);
    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("pending");
    expect(d.attemptCount).toBe(0);
    // nextRetryAt = start of next window.
    expect(d.nextRetryAt?.getTime()).toBe(nextWindowStart(nowMs).getTime());

    // Replacement job keeps the SAME expectedAttemptNumber; current job completed.
    const next = await fetchDeliveryJob({ ignoreStartAfter: true });
    expect(next!.data.deliveryId).toBe(deliveryId);
    expect(next!.data.expectedAttemptNumber).toBe(1);
    await completeDeliveryJob(next!.id);
    expect(await getDeliveryJobState(job!.id)).toBe("completed");
  });

  it("P7-3: rate-limit deferral rolls back atomically on failure", async () => {
    const endpointId = await makeEndpoint(5);
    const { deliveryId, eventId } = await ingestForEndpoint(accountId, endpointId, uniqueKey());
    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    const deferUntil = new Date(Date.now() + 60_000);

    await expect(
      deferDeliveryJob(
        { deliveryId, expectedAttemptNumber: 1, jobId: job!.id, deferUntil, accountId, eventId },
        { beforeCommit: async () => { throw new Error("boom"); } }
      )
    ).rejects.toThrow("boom");

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.nextRetryAt).toBeNull(); // unchanged
    expect(await fetchDeliveryJob({ ignoreStartAfter: true })).toBeNull(); // no replacement
    expect(await getDeliveryJobState(job!.id)).not.toBe("completed"); // current not completed
  });

  it("P7-18: concurrent deferrals of the same delivery/attempt cannot both schedule", async () => {
    const endpointId = await makeEndpoint(60);
    const { deliveryId, eventId } = await ingestForEndpoint(accountId, endpointId, uniqueKey());
    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    const deferUntil = new Date(Date.now() + 60_000);

    // Two workers race to defer the SAME delivery / expectedAttemptNumber / job.
    // (Deferral is transport-agnostic, so this one helper-level race covers both
    // the pause and rate-limit paths, which both call deferDeliveryJob.)
    const [r1, r2] = await Promise.all([
      deferDeliveryJob({ deliveryId, expectedAttemptNumber: 1, jobId: job!.id, deferUntil, accountId, eventId }),
      deferDeliveryJob({ deliveryId, expectedAttemptNumber: 1, jobId: job!.id, deferUntil, accountId, eventId }),
    ]);

    // Exactly one wins; the other is stale — never both.
    expect([r1, r2].sort()).toEqual(["stale", "won"]);

    // No attempt consumed; nextRetryAt set once by the winner.
    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.attemptCount).toBe(0);
    expect(d.status).toBe("pending");
    expect(d.nextRetryAt?.getTime()).toBe(deferUntil.getTime());

    // Exactly ONE replacement job exists — no double-scheduling.
    const first = await fetchDeliveryJob({ ignoreStartAfter: true });
    expect(first).not.toBeNull();
    expect(first!.data.deliveryId).toBe(deliveryId);
    expect(first!.data.expectedAttemptNumber).toBe(1);
    await completeDeliveryJob(first!.id);
    expect(await fetchDeliveryJob({ ignoreStartAfter: true })).toBeNull();
  });

  it("P7-16: fail -> fail -> success still works with the limiter in the path", async () => {
    const endpointId = await makeEndpoint(60); // ample budget; limiter never blocks
    const { deliveryId } = await ingestForEndpoint(accountId, endpointId, uniqueKey());

    // Stateful transport: first two attempts 500, third 200.
    let n = 0;
    const transport = async () => {
      n += 1;
      const status = n < 3 ? 500 : 200;
      return { kind: "response" as const, status, headers: {}, bodyText: null, resolvedIp: "127.0.0.1" };
    };

    for (let i = 0; i < 10; i++) {
      const job = await fetchDeliveryJob({ ignoreStartAfter: true });
      if (!job) break;
      await processDeliveryJob(job, { policy: TINY_POLICY, random: () => 0.5, transport });
      const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId }, select: { status: true } });
      if (d.status !== "pending") break;
    }

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("succeeded");
    expect(d.attemptCount).toBe(3);
    const statuses = (
      await prisma.deliveryAttempt.findMany({ where: { deliveryId }, orderBy: { attemptNumber: "asc" } })
    ).map((a) => a.responseStatus);
    expect(statuses).toEqual([500, 500, 200]);
  });
});
