import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "@webhook/db";

import { DEMO_TIMEOUT_DELAY_MS, handleDemoReceiver } from "@/lib/demo-receiver";
import { POST as demoReceiver } from "@/app/api/demo-receiver/[mode]/route";

const usedDeliveryIds: string[] = [];

function freshDeliveryId(): string {
  const id = `demo-${randomUUID()}`;
  usedDeliveryIds.push(id);
  return id;
}

function post(mode: string, headers: Record<string, string> = {}) {
  const req = new Request(`http://test/api/demo-receiver/${mode}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ hello: "world" }),
  });
  return demoReceiver(req as never, { params: Promise.resolve({ mode }) });
}

afterAll(async () => {
  if (usedDeliveryIds.length > 0) {
    await prisma.demoReceiverState.deleteMany({
      where: { deliveryId: { in: usedDeliveryIds } },
    });
  }
  await prisma.$disconnect();
});

describe("Phase 4 — demo receiver", () => {
  it("P4-1: success -> 200", async () => {
    const res = await post("success");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, mode: "success" });
  });

  it("P4-2: failure -> 500", async () => {
    const res = await post("failure");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ received: true, mode: "failure" });
  });

  it("P4-3: not-found -> 404", async () => {
    const res = await post("not-found");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ received: true, mode: "not-found" });
  });

  it("P4-4: rate-limit -> 429 with Retry-After: 5", async () => {
    const res = await post("rate-limit");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toEqual({ received: true, mode: "rate-limit" });
  });

  it("P4-5: timeout route delays; production default exceeds the ~10s webhook timeout", async () => {
    // Production route uses the real default, which must be > 10s so a real
    // delivery to /timeout reliably times out in Phase 5.
    expect(DEMO_TIMEOUT_DELAY_MS).toBeGreaterThan(10_000);

    // Prove the delay actually happens, fast, by injecting a short value (the
    // route uses the 12s default; the handler is parameterized).
    const injected = 80;
    const req = new Request("http://test/api/demo-receiver/timeout", {
      method: "POST",
    });
    const start = Date.now();
    const res = await handleDemoReceiver("timeout", req as never, {
      timeoutDelayMs: injected,
    });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, mode: "timeout" });
    expect(elapsed).toBeGreaterThanOrEqual(injected - 20); // small scheduling margin
  });

  it("P4-6: fail-then-succeed (fresh delivery): 500, 500, 200, 200", async () => {
    const deliveryId = freshDeliveryId();
    const h = { "x-webhook-delivery-id": deliveryId };

    const r1 = await post("fail-then-succeed", h);
    const r2 = await post("fail-then-succeed", h);
    const r3 = await post("fail-then-succeed", h);
    const r4 = await post("fail-then-succeed", h);

    expect([r1.status, r2.status, r3.status, r4.status]).toEqual([500, 500, 200, 200]);
    expect((await r1.json()).requestCount).toBe(1);
    expect((await r2.json()).requestCount).toBe(2);
    expect((await r3.json()).requestCount).toBe(3);
    expect((await r4.json()).requestCount).toBe(4);
  });

  it("P4-7: fail-then-succeed counters are isolated per delivery id", async () => {
    const a = freshDeliveryId();
    const b = freshDeliveryId();

    await post("fail-then-succeed", { "x-webhook-delivery-id": a });
    await post("fail-then-succeed", { "x-webhook-delivery-id": a });

    const bRes = await post("fail-then-succeed", { "x-webhook-delivery-id": b });
    expect(bRes.status).toBe(500);
    expect((await bRes.json()).requestCount).toBe(1); // not 3
  });

  it("P4-8: concurrent requests increment atomically (no lost updates)", async () => {
    const deliveryId = freshDeliveryId();
    const n = 10;

    const results = await Promise.all(
      Array.from({ length: n }, () =>
        post("fail-then-succeed", { "x-webhook-delivery-id": deliveryId })
      )
    );

    const counts = (
      await Promise.all(results.map((r) => r.json()))
    ).map((j) => j.requestCount as number);

    // Every request got a distinct count 1..n (no lost increments).
    expect([...counts].sort((x, y) => x - y)).toEqual(
      Array.from({ length: n }, (_, i) => i + 1)
    );

    // Persisted count equals number of requests sent.
    const state = await prisma.demoReceiverState.findUniqueOrThrow({
      where: { deliveryId },
    });
    expect(state.requestCount).toBe(n);
  });

  it("P4-9: fail-then-succeed without delivery-id header -> 400", async () => {
    const res = await post("fail-then-succeed");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "MISSING_DELIVERY_ID" });
  });

  it("P4-10: unknown mode -> 404 UNKNOWN_DEMO_MODE", async () => {
    const res = await post("banana");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "UNKNOWN_DEMO_MODE" });
  });
});
