import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { prisma } from "@webhook/db";

// Built-in DEMO receiver (Phase 4). A deterministic failure SIMULATOR with a
// CLOSED set of modes — not a proxy, not a rules engine, not user-controlled
// behavior. It exists so Phase 5 can prove retry behavior against predictable
// downstream responses.

// The real /timeout delay. It must exceed the frozen ~10s webhook request
// timeout that Phase 5 will introduce, so a real delivery to this route reliably
// times out. Tests inject a short value via handleDemoReceiver's options.
export const DEMO_TIMEOUT_DELAY_MS = 12_000;

const DELIVERY_ID_HEADER = "x-webhook-delivery-id";

const KNOWN_MODES = [
  "success",
  "failure",
  "not-found",
  "rate-limit",
  "timeout",
  "fail-then-succeed",
] as const;
type DemoMode = (typeof KNOWN_MODES)[number];

function isKnownMode(mode: string): mode is DemoMode {
  return (KNOWN_MODES as readonly string[]).includes(mode);
}

/**
 * Atomically record one more request for a demo delivery and return the new
 * count. A single INSERT ... ON CONFLICT DO UPDATE ... RETURNING avoids the
 * SELECT-then-UPDATE race, so concurrent requests can never lose an increment.
 */
async function incrementRequestCount(deliveryId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ requestCount: number }[]>`
    INSERT INTO "DemoReceiverState" ("deliveryId", "requestCount", "updatedAt")
    VALUES (${deliveryId}, 1, NOW())
    ON CONFLICT ("deliveryId")
    DO UPDATE SET "requestCount" = "DemoReceiverState"."requestCount" + 1,
                  "updatedAt" = NOW()
    RETURNING "requestCount"
  `;
  return rows[0]!.requestCount;
}

async function handleFailThenSucceed(request: NextRequest): Promise<NextResponse> {
  const deliveryId = request.headers.get(DELIVERY_ID_HEADER)?.trim();
  if (!deliveryId) {
    // Do NOT silently fall back to global state.
    return NextResponse.json(
      { error: "MISSING_DELIVERY_ID" },
      { status: 400 }
    );
  }

  const requestCount = await incrementRequestCount(deliveryId);

  // requests 1 and 2 fail (500), request 3+ succeed (200).
  const status = requestCount >= 3 ? 200 : 500;
  return NextResponse.json(
    { received: true, mode: "fail-then-succeed", requestCount },
    { status }
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type DemoReceiverOptions = {
  // The /timeout delay. Defaults to the real DEMO_TIMEOUT_DELAY_MS; tests inject
  // a short value to prove delayed behavior without waiting the full timeout.
  timeoutDelayMs?: number;
};

/** Route a demo request to its fixed, predefined behavior. */
export async function handleDemoReceiver(
  mode: string,
  request: NextRequest,
  options: DemoReceiverOptions = {}
): Promise<NextResponse> {
  if (!isKnownMode(mode)) {
    return NextResponse.json({ error: "UNKNOWN_DEMO_MODE" }, { status: 404 });
  }

  switch (mode) {
    case "success":
      return NextResponse.json({ received: true, mode: "success" }, { status: 200 });

    case "failure":
      // Deliberately a future-RETRYABLE failure. No retry scheduling here.
      return NextResponse.json({ received: true, mode: "failure" }, { status: 500 });

    case "not-found":
      // Exercises the Phase 3 permanent-failure path (-> Delivery dead).
      return NextResponse.json({ received: true, mode: "not-found" }, { status: 404 });

    case "rate-limit":
      // Phase 5 will consume Retry-After; Phase 4 only emits it.
      return NextResponse.json(
        { received: true, mode: "rate-limit" },
        { status: 429, headers: { "Retry-After": "5" } }
      );

    case "timeout":
      await sleep(options.timeoutDelayMs ?? DEMO_TIMEOUT_DELAY_MS);
      return NextResponse.json({ received: true, mode: "timeout" }, { status: 200 });

    case "fail-then-succeed":
      return handleFailThenSucceed(request);
  }
}
