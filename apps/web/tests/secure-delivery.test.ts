import { createServer as createHttpsServer, type Server } from "node:https";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ensureDemoAccount,
  fetchDeliveryJob,
  prisma,
  purgeDeliveryQueue,
  stopDeliveryQueue,
} from "@webhook/db";
import {
  buildSignatureHeader,
  resolveAndValidateHost,
  type ResolveResult,
} from "@webhook/shared";

import { processDeliveryJob } from "@webhook/worker/process-delivery";
import {
  secureWebhookRequest,
  type SecureTransportDeps,
} from "@webhook/worker/secure-transport";

import { ingestEvent } from "@/lib/ingest";
import { handleDemoReceiver } from "@/lib/demo-receiver";
import { insertEndpointRow, loadIpTestCert, loadTestCerts } from "./helpers/phase6";

// ---------------------------------------------------------------------------
// Real HTTPS receiver behind the ACTUAL production pinned transport. We connect
// to https://webhook.test:<port> while the socket is pinned (via the transport's
// resolveHost seam) to 127.0.0.1 where this server listens, and we trust a
// controlled test CA (SAN: webhook.test). TLS verification stays ON the whole
// time — production passes no `ca`, so the system trust store applies there.
// ---------------------------------------------------------------------------

const { ca, cert, key } = loadTestCerts();

let server: Server;
let port = 0;
const state = { lastSni: null as string | null, lastRemote: null as string | null };
const hitPaths: string[] = [];

function startServer(): Promise<void> {
  server = createHttpsServer({ cert, key }, (req, res) => {
    state.lastRemote = req.socket.remoteAddress ?? null;
    const path = (req.url ?? "/").split("?")[0]!;
    hitPaths.push(path);

    if (path === "/redirect") {
      res.writeHead(302, { location: `https://webhook.test:${port}/final` });
      res.end("redirecting");
      return;
    }
    if (path === "/final") {
      res.writeHead(200);
      res.end("final");
      return;
    }
    if (path === "/delay") {
      // Longer than the injected transport timeout -> a real timeout.
      setTimeout(() => {
        try {
          res.writeHead(200);
          res.end("late");
        } catch {
          /* client already aborted */
        }
      }, 2_000);
      return;
    }

    // Default: buffer the body and (for verify-signature) run the real receiver.
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (path === "/verify-signature") {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers.set(k, v);
          else if (Array.isArray(v)) headers.set(k, v.join(", "));
        }
        const request = new Request("http://receiver/verify-signature", {
          method: "POST",
          headers,
          body,
        });
        const response = await handleDemoReceiver("verify-signature", request as never);
        const text = await response.text();
        const out: Record<string, string> = {};
        response.headers.forEach((v, k) => (out[k] = v));
        res.writeHead(response.status, out);
        res.end(text);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`remote=${req.socket.remoteAddress}`);
    });
  });
  server.on("secureConnection", (s) => (state.lastSni = s.servername || null));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
}

// resolveHost seams for the transport:
// - pin127: simulate that webhook.test resolved+validated to our loopback server.
const pin127 = async (): Promise<ResolveResult> => ({ ok: true, pinnedIp: "127.0.0.1", family: 4 });
// - rebind: run the REAL validator over a DNS answer that (post-rebinding) points
//   at loopback -> the validator rejects it, exactly like delivery-time rebinding.
const rebindToLoopback = (hostname: string): Promise<ResolveResult> =>
  resolveAndValidateHost(hostname, { lookup: async () => [{ address: "127.0.0.1", family: 4 }] });

function pinnedDeps(): SecureTransportDeps {
  return { resolveHost: pin127, tlsCa: ca };
}

const base = () => `https://webhook.test:${port}`;

// ---- delivery scaffolding ----
let accountId: string;
const usedKeys: string[] = [];
const endpointIds: string[] = [];

function uniqueKey(): string {
  const k = `p6-${randomUUID()}`;
  usedKeys.push(k);
  return k;
}

async function makeEndpoint(path: string): Promise<{ id: string; secret: string }> {
  const ep = await insertEndpointRow(accountId, `${base()}${path}`);
  endpointIds.push(ep.id);
  return ep;
}

// Ingest an event for an endpoint and return its delivery id.
async function ingest(endpointId: string, key: string, rawBody?: string): Promise<string> {
  const payloadRaw = rawBody ?? JSON.stringify({ type: "order.created", data: { k: key } });
  const result = await ingestEvent({
    accountId,
    endpointId,
    eventType: "order.created",
    payloadRaw,
    idempotencyKey: key,
  });
  if (result.outcome !== "created") throw new Error("ingest did not create");
  const delivery = await prisma.delivery.findFirstOrThrow({
    where: { eventId: result.event.id },
    select: { id: true },
  });
  return delivery.id;
}

beforeAll(async () => {
  await startServer();
  accountId = (await ensureDemoAccount()).id;
});

beforeEach(async () => {
  await purgeDeliveryQueue();
  hitPaths.length = 0;
  state.lastSni = null;
  state.lastRemote = null;
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
  if (endpointIds.length > 0) {
    await prisma.endpoint.deleteMany({ where: { id: { in: endpointIds } } });
  }
  await purgeDeliveryQueue();
  await stopDeliveryQueue();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe("Phase 6 — pinned HTTPS transport", () => {
  it("P6-T1: connects to the pinned IP while TLS/SNI/Host stay the original hostname", async () => {
    const result = await secureWebhookRequest(
      { url: `${base()}/echo`, headers: {}, body: "hi", timeoutMs: 5_000 },
      pinnedDeps()
    );
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.status).toBe(200);
    // The transport reports the validated IP it pinned to.
    expect(result.resolvedIp).toBe("127.0.0.1");
    // The socket actually connected to 127.0.0.1...
    expect(result.bodyText).toContain("remote=127.0.0.1");
    expect(state.lastRemote).toBe("127.0.0.1");
    // ...while the server observed SNI = the ORIGINAL hostname (not the IP).
    expect(state.lastSni).toBe("webhook.test");
  });

  it("P6-T2: TLS verification stays ON — an untrusted cert (no test CA) fails", async () => {
    // Same pinned socket, but do NOT pass the test CA: the self-signed server
    // cert is not in the default trust store, so the handshake must fail. This
    // proves we never disabled rejectUnauthorized.
    const result = await secureWebhookRequest(
      { url: `${base()}/echo`, headers: {}, body: "hi", timeoutMs: 5_000 },
      { resolveHost: pin127 } // no tlsCa
    );
    expect(result.kind).toBe("network");
  });

  it("P6-T3: a request timeout is classified as timeout (not a hung socket)", async () => {
    const result = await secureWebhookRequest(
      { url: `${base()}/delay`, headers: {}, body: "hi", timeoutMs: 300 },
      pinnedDeps()
    );
    expect(result.kind).toBe("timeout");
  });

  it("P6-T4: a DNS-rebinding resolution is blocked BEFORE any socket opens", async () => {
    const before = hitPaths.length;
    const result = await secureWebhookRequest(
      { url: `${base()}/echo`, headers: {}, body: "hi", timeoutMs: 5_000 },
      { resolveHost: rebindToLoopback, tlsCa: ca }
    );
    expect(result.kind).toBe("ssrf");
    // The server was never contacted.
    expect(hitPaths.length).toBe(before);
  });
});

describe("Phase 6 — end-to-end signed delivery", () => {
  it("P6-T5: signature round-trip -> receiver verifies -> Delivery succeeded, resolvedIp set", async () => {
    // Deliberately awkward whitespace: proves stored==signed==sent==verified bytes.
    const raw = '{ "type" : "order.created", "data" : { "x" : 1 } }';
    const ep = await makeEndpoint("/verify-signature");
    const deliveryId = await ingest(ep.id, uniqueKey(), raw);

    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    await processDeliveryJob(job!, { transport: (req) => secureWebhookRequest(req, pinnedDeps()) });

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("succeeded");
    expect(d.attemptCount).toBe(1);

    const a = await prisma.deliveryAttempt.findFirstOrThrow({ where: { deliveryId } });
    expect(a.outcome).toBe("success");
    expect(a.responseStatus).toBe(200);
    expect(a.resolvedIp).toBe("127.0.0.1");
    // The signature header we actually sent was recorded (an HMAC, not the secret).
    const headers = a.requestHeaders as Record<string, string>;
    expect(headers["x-webhook-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]+$/);
    expect(JSON.stringify(headers).includes(ep.secret)).toBe(false);
  });

  it("P6-T6: a tampered body fails verification at the receiver (401)", async () => {
    const ep = await makeEndpoint("/verify-signature");
    const deliveryId = await ingest(ep.id, uniqueKey());
    const event = await prisma.event.findFirstOrThrow({
      where: { deliveries: { some: { id: deliveryId } } },
      select: { payloadRaw: true },
    });

    // Correct signature over the real body, but deliver a DIFFERENT body.
    const t = Math.floor(Date.now() / 1000);
    const goodHeader = buildSignatureHeader(ep.secret, t, event.payloadRaw);
    const request = new Request("http://receiver/verify-signature", {
      method: "POST",
      headers: { "x-webhook-delivery-id": deliveryId, "x-webhook-signature": goodHeader },
      body: event.payloadRaw + "TAMPER",
    });
    const response = await handleDemoReceiver("verify-signature", request as never);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "INVALID_WEBHOOK_SIGNATURE" });
  });

  it("P6-T7: an expired timestamp fails verification at the receiver (401)", async () => {
    const ep = await makeEndpoint("/verify-signature");
    const deliveryId = await ingest(ep.id, uniqueKey());
    const event = await prisma.event.findFirstOrThrow({
      where: { deliveries: { some: { id: deliveryId } } },
      select: { payloadRaw: true },
    });

    // Correctly signed, but 10 minutes old (> 5-minute receiver tolerance).
    const oldT = Math.floor(Date.now() / 1000) - 600;
    const header = buildSignatureHeader(ep.secret, oldT, event.payloadRaw);
    const request = new Request("http://receiver/verify-signature", {
      method: "POST",
      headers: { "x-webhook-delivery-id": deliveryId, "x-webhook-signature": header },
      body: event.payloadRaw,
    });
    const response = await handleDemoReceiver("verify-signature", request as never);
    expect(response.status).toBe(401);
  });

  it("P6-T8: DNS rebinding at delivery time -> no HTTP, permanent dead", async () => {
    const ep = await makeEndpoint("/verify-signature");
    const deliveryId = await ingest(ep.id, uniqueKey());
    const before = hitPaths.length;

    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    await processDeliveryJob(job!, {
      transport: (req) => secureWebhookRequest(req, { resolveHost: rebindToLoopback, tlsCa: ca }),
    });

    // No socket was opened to the receiver.
    expect(hitPaths.length).toBe(before);

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("dead");
    expect(d.attemptCount).toBe(1);

    const a = await prisma.deliveryAttempt.findFirstOrThrow({ where: { deliveryId } });
    expect(a.outcome).toBe("failure");
    expect(a.responseStatus).toBeNull();
    expect(a.errorMessage).toBe("unsafe endpoint destination");
    expect(a.resolvedIp).toBeNull();
    // Not retried.
    expect(await fetchDeliveryJob({ ignoreStartAfter: true })).toBeNull();
  });

  it("P6-T9: a 302 redirect is NOT followed by the real transport -> 302, dead", async () => {
    const ep = await makeEndpoint("/redirect");
    const deliveryId = await ingest(ep.id, uniqueKey());

    const job = await fetchDeliveryJob({ ignoreStartAfter: true });
    await processDeliveryJob(job!, { transport: (req) => secureWebhookRequest(req, pinnedDeps()) });

    expect(hitPaths).toContain("/redirect");
    expect(hitPaths).not.toContain("/final");

    const a = await prisma.deliveryAttempt.findFirstOrThrow({ where: { deliveryId } });
    expect(a.responseStatus).toBe(302);
    expect(a.outcome).toBe("failure");

    const d = await prisma.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("dead");
    expect(await fetchDeliveryJob({ ignoreStartAfter: true })).toBeNull();
  });
});

describe("Phase 6 — connection isolation & IP-literal TLS", () => {
  it("P6-T10: separate attempts do NOT reuse a pooled socket (agent:false)", async () => {
    // A dedicated HTTPS server that records the client's source port per request.
    // With connection pooling, two sequential requests would share one socket
    // (same remotePort). agent:false forces a fresh connection each attempt.
    const remotePorts: number[] = [];
    const srv = createHttpsServer({ cert, key }, (req, res) => {
      remotePorts.push(req.socket.remotePort ?? -1);
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const p = (srv.address() as { port: number }).port;
    try {
      const url = `https://webhook.test:${p}/echo`;
      const r1 = await secureWebhookRequest({ url, headers: {}, body: "a", timeoutMs: 5_000 }, pinnedDeps());
      const r2 = await secureWebhookRequest({ url, headers: {}, body: "b", timeoutMs: 5_000 }, pinnedDeps());
      expect(r1.kind).toBe("response");
      expect(r2.kind).toBe("response");
      expect(remotePorts).toHaveLength(2);
      // Two distinct sockets -> two distinct source ports -> no reuse.
      expect(remotePorts[0]).not.toBe(remotePorts[1]);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("P6-T11: IP-literal endpoint — TLS verifies against IP SAN, SNI is NOT the IP", async () => {
    // Server presents a cert whose SAN is IP:127.0.0.1 (not a DNS name).
    const ip = loadIpTestCert();
    // `unknown` sidesteps the string|false union narrowing; we assert on values.
    let observedSni: unknown = "UNSET";
    const srv = createHttpsServer({ cert: ip.cert, key: ip.key }, (req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    srv.on("secureConnection", (s) => (observedSni = s.servername));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const p = (srv.address() as { port: number }).port;
    try {
      // IP-literal destination; pin to that same validated IP, trust the test CA.
      const result = await secureWebhookRequest(
        { url: `https://127.0.0.1:${p}/`, headers: {}, body: "x", timeoutMs: 5_000 },
        { resolveHost: async () => ({ ok: true, pinnedIp: "127.0.0.1", family: 4 }), tlsCa: ip.ca }
      );
      // TLS verification stayed ON and PASSED against the IP SAN.
      expect(result.kind).toBe("response");
      if (result.kind === "response") {
        expect(result.status).toBe(200);
        expect(result.resolvedIp).toBe("127.0.0.1");
      }
      // Crucially, SNI was NOT set to the IP (RFC 6066) -> server saw no server name.
      expect(observedSni).not.toBe("127.0.0.1");
      expect(observedSni === false || observedSni === null || observedSni === "").toBe(true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
