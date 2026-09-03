import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  deferDeliveryJob,
  ensureDemoAccount,
  fetchDeliveryJob,
  getDeliveryJobState,
  prisma,
  purgeDeliveryQueue,
  stopDeliveryQueue,
} from "@webhook/db";
import type { RetryPolicy } from "@webhook/shared";

import { processDeliveryJob } from "@webhook/worker/process-delivery";

import { updateEndpointStatus } from "@/lib/update-endpoint-status";
import { PATCH as patchEndpoint } from "@/app/api/v1/endpoints/[endpointId]/route";
import {
  deleteEndpointsAndWindows,
  ingestForEndpoint,
  insertEndpointRow,
  spyTransport,
} from "./helpers/phase6";

const TINY_POLICY: RetryPolicy = {
  baseDelayMs: 1,
  multiplier: 1,
  maxDelayMs: 5,
  maxAttempts: 6,
  jitterPercent: 0,
};

const FAIL_500 = {
  kind: "response" as const,
  status: 500,
  headers: {},
  bodyText: null,
  resolvedIp: "127.0.0.1",
};

let accountId: string;
const usedKeys: string[] = [];
const endpointIds: string[] = [];

function uniqueKey(): string {
  const k = `p7pause-${randomUUID()}`;
  usedKeys.push(k);
  return k;
}

async function makeEndpoint(status: "active" | "paused" = "active"): Promise<string> {
  const ep = await insertEndpointRow(accountId, `https://webhook.test/pause-${randomUUID()}`, {
    status,
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

describe("Phase 7 — endpoint pause / resume", () => {
  it("P7-5: PATCH pauses/resumes; enforces ownership + validation", async () => {
    const endpointId = await makeEndpoint("active");

    // Pause via the real route handler.
    const pauseReq = new Request(`http://test/api/v1/endpoints/${endpointId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    const pauseRes = await patchEndpoint(pauseReq as never, {
      params: Promise.resolve({ endpointId }),
    });
    expect(pauseRes.status).toBe(200);
    expect((await prisma.endpoint.findUniqueOrThrow({ where: { id: endpointId } })).status).toBe(
      "paused"
    );

    // Resume via the lib.
    const resume = await updateEndpointStatus(endpointId, accountId, JSON.stringify({ status: "active" }));
    expect(resume.status).toBe(200);
    expect((await prisma.endpoint.findUniqueOrThrow({ where: { id: endpointId } })).status).toBe(
      "active"
    );

    // Ownership: another account cannot update this endpoint -> 404 (no leak).
    const foreign = await updateEndpointStatus(endpointId, "some-other-account", JSON.stringify({ status: "paused" }));
    expect(foreign.status).toBe(404);
    expect((await prisma.endpoint.findUniqueOrThrow({ where: { id: endpointId } })).status).toBe(
      "active"
    );

    // Invalid status -> 400 VALIDATION_ERROR.
    const bad = await updateEndpointStatus(endpointId, accountId, JSON.stringify({ status: "nope" }));
    expect(bad.status).toBe(400);
    if (bad.status === 400) expect(bad.body.error).toBe("VALIDATION_ERROR");
  });

  it("P7-6: a paused endpoint defers the job without an attempt", async () => {
    const endpointId = await makeEndpoint("paused");
    const { deliveryId } = await ingestForEndpoint(accountId, endpointId, uniqueKey());
    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    const spy = spyTransport();
    const nowMs = Date.now();

    await processDeliveryJob(job!, { now: () => nowMs, transport: spy.transport, pauseRecheckMs: 5_000 });

    expect(spy.calls).toHaveLength(0); // no HTTP
    expect(await prisma.deliveryAttempt.count({ where: { deliveryId } })).toBe(0);
    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("pending");
    expect(d.attemptCount).toBe(0);
    expect(d.nextRetryAt?.getTime()).toBe(nowMs + 5_000); // pause recheck time

    const next = await fetchDeliveryJob({ ignoreStartAfter: true });
    expect(next!.data.deliveryId).toBe(deliveryId);
    expect(next!.data.expectedAttemptNumber).toBe(1); // SAME number
    expect(await getDeliveryJobState(job!.id)).toBe("completed");
  });

  it("P7-7: paused deferral rolls back atomically on failure", async () => {
    const endpointId = await makeEndpoint("paused");
    const { deliveryId, eventId } = await ingestForEndpoint(accountId, endpointId, uniqueKey());
    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    const deferUntil = new Date(Date.now() + 30_000);

    await expect(
      deferDeliveryJob(
        { deliveryId, expectedAttemptNumber: 1, jobId: job!.id, deferUntil, accountId, eventId },
        { beforeCommit: async () => { throw new Error("boom"); } }
      )
    ).rejects.toThrow("boom");

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.nextRetryAt).toBeNull();
    expect(await fetchDeliveryJob({ ignoreStartAfter: true })).toBeNull();
    expect(await getDeliveryJobState(job!.id)).not.toBe("completed");
  });

  it("P7-8: ingestion while paused is accepted; the worker defers it", async () => {
    const endpointId = await makeEndpoint("paused");
    const key = uniqueKey();
    const { deliveryId, eventId } = await ingestForEndpoint(accountId, endpointId, key);

    // Event + Delivery + job were all created despite the paused endpoint.
    expect(await prisma.event.count({ where: { id: eventId } })).toBe(1);
    expect(await prisma.delivery.count({ where: { id: deliveryId } })).toBe(1);
    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    expect(job!.data.deliveryId).toBe(deliveryId);

    // The worker holds it (defers) rather than sending.
    const spy = spyTransport();
    await processDeliveryJob(job!, { transport: spy.transport, pauseRecheckMs: 5_000 });
    expect(spy.calls).toHaveLength(0);
    expect(await prisma.deliveryAttempt.count({ where: { deliveryId } })).toBe(0);
  });

  it("P7-9: retry budget is preserved across a pause", async () => {
    const endpointId = await makeEndpoint("active");
    const { deliveryId } = await ingestForEndpoint(accountId, endpointId, uniqueKey());

    // Attempt 1 fails -> attemptCount 1, retry scheduled expecting attempt 2.
    const job1 = await fetchDeliveryJob({ ignoreStartAfter: true });
    await processDeliveryJob(job1!, { policy: TINY_POLICY, random: () => 0.5, transport: spyTransport(FAIL_500).transport });
    let d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.attemptCount).toBe(1);
    expect(d.status).toBe("pending");

    // Pause, then the retry job (expecting 2) wakes and is deferred WITHOUT attempt.
    await updateEndpointStatus(endpointId, accountId, JSON.stringify({ status: "paused" }));
    const job2 = await fetchDeliveryJob({ ignoreStartAfter: true });
    expect(job2!.data.expectedAttemptNumber).toBe(2);
    const spy = spyTransport();
    await processDeliveryJob(job2!, { transport: spy.transport, pauseRecheckMs: 2_000 });
    expect(spy.calls).toHaveLength(0);
    d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.attemptCount).toBe(1); // unchanged — budget preserved

    // Replacement job STILL expects attempt 2.
    const job3 = await fetchDeliveryJob({ ignoreStartAfter: true });
    expect(job3!.data.expectedAttemptNumber).toBe(2);

    // Resume, then the same delivery continues: the next real attempt is #2.
    await updateEndpointStatus(endpointId, accountId, JSON.stringify({ status: "active" }));
    await processDeliveryJob(job3!, { policy: TINY_POLICY, random: () => 0.5, transport: spyTransport().transport });
    d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("succeeded");
    expect(d.attemptCount).toBe(2);
    const attempts = await prisma.deliveryAttempt.findMany({
      where: { deliveryId },
      orderBy: { attemptNumber: "asc" },
    });
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2]); // deferral recorded no attempt
  });
});
