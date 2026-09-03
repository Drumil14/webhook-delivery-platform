import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  DEMO_ACCOUNT_ID,
  ensureDemoAccount,
  notifyDeliveryUpdate,
  prisma,
} from "@webhook/db";

import { GET as streamGET } from "@/app/api/v1/stream/route";
import {
  closeDeliveryUpdateListener,
  getDeliveryListenerState,
} from "@/lib/delivery-update-listener";

// Exercises the actual SSE route + the full Postgres -> LISTEN -> hub -> SSE path.

const controllers: AbortController[] = [];

function openStream(): Promise<Response> {
  const ctrl = new AbortController();
  controllers.push(ctrl);
  const req = new Request("http://test/api/v1/stream", { signal: ctrl.signal });
  return streamGET(req as never);
}

async function waitFor<T>(get: () => T | undefined | false, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = get();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  ms = 8000
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), remaining)),
    ]);
    if (result === "timeout") break;
    if (result.done) break;
    if (result.value) buffer += decoder.decode(result.value, { stream: true });
    if (buffer.includes(needle)) return buffer;
  }
  throw new Error(`did not receive "${needle}"; buffer so far:\n${buffer}`);
}

async function publish(deliveryId: string, eventId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await notifyDeliveryUpdate(tx, { accountId: DEMO_ACCOUNT_ID, deliveryId, eventId, kind: "attempted" });
  });
}

beforeAll(async () => {
  await ensureDemoAccount();
});

afterEach(() => {
  for (const c of controllers.splice(0)) c.abort();
});

afterAll(async () => {
  for (const c of controllers.splice(0)) c.abort();
  await closeDeliveryUpdateListener();
  await prisma.$disconnect();
});

describe("Phase 8 — SSE endpoint", () => {
  it("P8-7: responds text/event-stream and emits an initial 'ready' event", async () => {
    const res = await openStream();
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");

    const reader = res.body!.getReader();
    const text = await readUntil(reader, "event: ready");
    expect(text).toContain("event: ready");
    expect(text).toContain('"connected":true');
    await reader.cancel().catch(() => {});
  });

  it("P8-8: a real Delivery change is pushed as an 'event: delivery' SSE message", async () => {
    const res = await openStream();
    const reader = res.body!.getReader();
    await readUntil(reader, "event: ready"); // drain the ready event

    // Wait until the route has actually subscribed before publishing.
    await waitFor(() => getDeliveryListenerState().subscriberCount >= 1);

    const deliveryId = randomUUID();
    const eventId = randomUUID();
    await publish(deliveryId, eventId);

    const text = await readUntil(reader, "event: delivery");
    expect(text).toContain("event: delivery");
    expect(text).toContain(`"deliveryId":"${deliveryId}"`);
    expect(text).toContain(`"eventId":"${eventId}"`);
    expect(text).toContain('"kind":"attempted"');
    // The browser payload must NOT leak accountId.
    expect(text).not.toContain(DEMO_ACCOUNT_ID);
    await reader.cancel().catch(() => {});
  });
});
