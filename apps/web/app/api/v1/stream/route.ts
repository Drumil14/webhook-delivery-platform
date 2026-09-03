import type { NextRequest } from "next/server";

import { ensureDemoAccount } from "@webhook/db";

import {
  subscribeToDeliveryUpdates,
  type DeliverySubscription,
} from "@/lib/delivery-update-listener";

// GET /api/v1/stream — Server-Sent Events for realtime Delivery-change pings.
//
// This is an INVALIDATION channel: it sends only { deliveryId, eventId, kind }.
// The browser refetches canonical REST state on each ping (Phase 11).
//
// Requires a long-running Node process + a persistent PostgreSQL LISTEN
// connection, so it MUST run on the Node.js runtime (not Edge).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 20_000;

export async function GET(request: NextRequest) {
  // Current account context (V1 demo account; no auth yet). The stream only ever
  // forwards notifications matching this account.
  const account = await ensureDemoAccount();
  const encoder = new TextEncoder();

  // Reachable from both the abort listener and the stream's cancel().
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* stream already closed */
        }
      };

      cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        request.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Tiny initial event so the client knows the stream is live.
      send(`event: ready\ndata: ${JSON.stringify({ connected: true })}\n\n`);

      const subscription: DeliverySubscription = {
        accountId: account.id,
        onNotify: (payload) => send(`event: delivery\ndata: ${JSON.stringify(payload)}\n\n`),
        onClose: cleanup, // listener failure -> close this stream; browser reconnects
      };

      try {
        unsubscribe = await subscribeToDeliveryUpdates(subscription);
      } catch {
        // Could not establish the LISTEN connection: close the stream so the
        // browser reconnects later rather than believing realtime is working.
        cleanup();
        return;
      }

      // Heartbeat comment keeps idle connections alive through proxies.
      heartbeat = setInterval(() => send(`: heartbeat\n\n`), HEARTBEAT_MS);

      if (request.signal.aborted) cleanup();
      else request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      // Consumer cancelled (client disconnected): ensure unsubscribe + heartbeat
      // teardown even if the abort signal didn't fire.
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
