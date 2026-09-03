// Phase 6 test helpers (NOT a test file — no *.test suffix, so vitest ignores it).
//
// Once SSRF enforcement is live, the endpoint-creation API rejects localhost /
// private / http destinations. Integration tests that need a local receiver
// therefore insert Endpoint rows DIRECTLY (with a real encrypted secret) and
// inject a deterministic transport/resolver. Production policy stays strict.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prisma } from "@webhook/db";
import {
  encryptSecret,
  generateSigningSecret,
  loadMasterKey,
} from "@webhook/shared";

import type {
  TransportRequest,
  TransportResult,
} from "@webhook/worker/secure-transport";

import { ingestEvent } from "@/lib/ingest";

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** The controlled test CA + leaf cert (SAN: webhook.test), generated with openssl. */
export function loadTestCerts(): { ca: Buffer; cert: Buffer; key: Buffer } {
  return {
    ca: readFileSync(resolve(FIXTURES_DIR, "ca.crt")),
    cert: readFileSync(resolve(FIXTURES_DIR, "leaf.crt")),
    key: readFileSync(resolve(FIXTURES_DIR, "leaf.key")),
  };
}

/** Same CA, but a leaf cert with an IP SAN (IP:127.0.0.1) for IP-literal TLS tests. */
export function loadIpTestCert(): { ca: Buffer; cert: Buffer; key: Buffer } {
  return {
    ca: readFileSync(resolve(FIXTURES_DIR, "ca.crt")),
    cert: readFileSync(resolve(FIXTURES_DIR, "leaf-ip.crt")),
    key: readFileSync(resolve(FIXTURES_DIR, "leaf-ip.key")),
  };
}

/** The master key the tests encrypt/decrypt endpoint secrets with (from env). */
export function testMasterKey(): Buffer {
  return loadMasterKey();
}

/**
 * Insert an Endpoint row directly, bypassing the SSRF-enforcing creation API, so
 * tests can point the worker at a local receiver. The stored secret is a REAL
 * AES-256-GCM envelope (no placeholders — the worker will decrypt + sign it).
 * Returns the endpoint id and the plaintext signing secret for assertions.
 */
export async function insertEndpointRow(
  accountId: string,
  url: string,
  opts: { rateLimitPerMinute?: number; status?: "active" | "paused" } = {}
): Promise<{ id: string; secret: string }> {
  const secret = generateSigningSecret();
  const secretEncrypted = encryptSecret(secret, testMasterKey());
  const endpoint = await prisma.endpoint.create({
    data: {
      accountId,
      url,
      secretEncrypted,
      ...(opts.rateLimitPerMinute !== undefined
        ? { rateLimitPerMinute: opts.rateLimitPerMinute }
        : {}),
      ...(opts.status !== undefined ? { status: opts.status } : {}),
    },
    select: { id: true },
  });
  return { id: endpoint.id, secret };
}

/**
 * Delete endpoints AND their rate-window rows (Phase 7 added a restrictive FK
 * from EndpointRateWindow -> Endpoint, so windows must go first). Safe to call
 * with endpoints that have no windows.
 */
export async function deleteEndpointsAndWindows(endpointIds: string[]): Promise<void> {
  if (endpointIds.length === 0) return;
  await prisma.endpointRateWindow.deleteMany({ where: { endpointId: { in: endpointIds } } });
  await prisma.endpoint.deleteMany({ where: { id: { in: endpointIds } } });
}

/** Ingest one event for an endpoint (real transactional path) -> returns ids. */
export async function ingestForEndpoint(
  accountId: string,
  endpointId: string,
  idempotencyKey: string,
  rawBody?: string
): Promise<{ deliveryId: string; eventId: string }> {
  const payloadRaw = rawBody ?? JSON.stringify({ type: "order.created", data: { k: idempotencyKey } });
  const result = await ingestEvent({
    accountId,
    endpointId,
    eventType: "order.created",
    payloadRaw,
    idempotencyKey,
  });
  if (result.outcome !== "created") throw new Error(`ingest did not create: ${result.outcome}`);
  const delivery = await prisma.delivery.findFirstOrThrow({
    where: { eventId: result.event.id },
    select: { id: true },
  });
  return { deliveryId: delivery.id, eventId: result.event.id };
}

/**
 * A spy transport that records every call and returns a canned result (200 by
 * default). Used by deferral tests to prove NO HTTP request was made (calls stay
 * empty) when a job is paused/rate-limited.
 */
export function spyTransport(result?: TransportResult): {
  transport: (req: TransportRequest) => Promise<TransportResult>;
  calls: TransportRequest[];
} {
  const calls: TransportRequest[] = [];
  const transport = async (req: TransportRequest): Promise<TransportResult> => {
    calls.push(req);
    return (
      result ?? {
        kind: "response",
        status: 200,
        headers: {},
        bodyText: null,
        resolvedIp: "127.0.0.1",
      }
    );
  };
  return { transport, calls };
}

/**
 * A deterministic transport for the reliability tests (Phase 3/5): connects over
 * plain HTTP to a local receiver, preserving the production contract — redirects
 * are NOT followed, and the timeout aborts the request. It exercises the worker's
 * classification/finalize pipeline without needing HTTPS/DNS. (The REAL pinned
 * HTTPS transport is exercised separately in secure-delivery.test.ts.)
 */
export function httpLoopbackTransport(): (req: TransportRequest) => Promise<TransportResult> {
  return async (req) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, req.timeoutMs);
    try {
      const response = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        redirect: "manual", // never follow redirects
        signal: controller.signal,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => (headers[k] = v));
      let bodyText: string | null = await response.text();
      if (bodyText.length === 0) bodyText = null;
      else if (bodyText.length > 10 * 1024) bodyText = bodyText.slice(0, 10 * 1024);
      return {
        kind: "response",
        status: response.status,
        headers,
        bodyText,
        resolvedIp: "127.0.0.1",
      };
    } catch (error) {
      if (timedOut) return { kind: "timeout", resolvedIp: "127.0.0.1" };
      return {
        kind: "network",
        message: error instanceof Error ? error.message : String(error),
        resolvedIp: "127.0.0.1",
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
