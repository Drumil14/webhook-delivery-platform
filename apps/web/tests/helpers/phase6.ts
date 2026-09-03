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
  url: string
): Promise<{ id: string; secret: string }> {
  const secret = generateSigningSecret();
  const secretEncrypted = encryptSecret(secret, testMasterKey());
  const endpoint = await prisma.endpoint.create({
    data: { accountId, url, secretEncrypted },
    select: { id: true },
  });
  return { id: endpoint.id, secret };
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
