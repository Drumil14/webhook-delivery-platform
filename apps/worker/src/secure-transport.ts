import { isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";

import { resolveAndValidateHost, type ResolveResult } from "@webhook/shared";

// Phase 6 — the actual SSRF-safe outbound transport (worker-only; it opens real
// sockets, so it does NOT belong in the shared package).
//
// Flow for EVERY request:
//   parse URL -> require https -> reject credentials
//   -> resolve + validate the hostname (SSRF preflight)
//   -> pin the socket to the validated IP via a custom `lookup`
//   -> keep the ORIGINAL hostname for Host header, TLS SNI, and certificate
//      validation (rejectUnauthorized stays true)
//   -> never follow redirects (https.request does not auto-follow anyway)

const MAX_RESPONSE_SNIPPET_BYTES = 10 * 1024; // ~10 KB cap (unchanged from Phase 5)

export type TransportRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};

// A response actually received from a real socket to a validated IP.
export type TransportResponse = {
  kind: "response";
  status: number;
  headers: Record<string, string>;
  bodyText: string | null;
  resolvedIp: string;
};

// The security preflight blocked the request — NO socket was opened. Treated by
// the caller as a PERMANENT failure (retrying an unsafe destination is pointless
// and dangerous), never as a retryable network error.
export type TransportSsrf = { kind: "ssrf"; reason: string };

// The socket was opened to a validated IP but the request timed out / errored.
export type TransportTimeout = { kind: "timeout"; resolvedIp: string | null };
export type TransportNetwork = {
  kind: "network";
  message: string;
  resolvedIp: string | null;
};

export type TransportResult =
  | TransportResponse
  | TransportSsrf
  | TransportTimeout
  | TransportNetwork;

export type SecureTransportDeps = {
  // Override the resolve+validate step (tests: simulate DNS rebinding, or pin a
  // loopback test server). Defaults to the real shared resolver.
  resolveHost?: (hostname: string) => Promise<ResolveResult>;
  // TEST-ONLY: trust a controlled CA so a local HTTPS test server verifies. This
  // does NOT weaken production TLS — production passes no `ca`, so the system
  // trust store + rejectUnauthorized:true apply.
  tlsCa?: string | Buffer;
};

/** Read an IncomingMessage body, capped at maxBytes, then stop. */
function readCappedBody(res: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (total === 0) return resolve(null);
      const buf = Buffer.concat(chunks).subarray(0, maxBytes);
      resolve(buf.toString("utf8"));
    };
    res.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (total < maxBytes) {
        chunks.push(chunk);
        total += chunk.length;
        if (total >= maxBytes) {
          // Enough captured; stop reading the rest of the body.
          res.destroy();
          finish();
        }
      }
    });
    res.on("end", finish);
    res.on("close", finish);
    res.on("error", finish);
  });
}

/**
 * Perform one SSRF-safe, DNS-pinned HTTPS request. See module header for the flow.
 * Returns a discriminated result; it never throws for expected network/SSRF
 * conditions (only truly-unexpected programmer errors would throw).
 */
export async function secureWebhookRequest(
  req: TransportRequest,
  deps: SecureTransportDeps = {}
): Promise<TransportResult> {
  let parsed: URL;
  try {
    parsed = new URL(req.url);
  } catch {
    return { kind: "ssrf", reason: "invalid_url" };
  }
  // Belt-and-suspenders: the creation-time check already enforces these, but the
  // transport re-checks because it is the real security boundary.
  if (parsed.protocol !== "https:") {
    return { kind: "ssrf", reason: "non_https_scheme" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { kind: "ssrf", reason: "credentials_in_url" };
  }

  const resolve = deps.resolveHost ?? ((h: string) => resolveAndValidateHost(h));
  const resolution = await resolve(parsed.hostname);
  if (!resolution.ok) {
    // Preflight blocked: do NOT open a socket.
    return { kind: "ssrf", reason: resolution.reason };
  }
  const pinnedIp = resolution.pinnedIp;
  const family = resolution.family;

  const port = parsed.port ? Number(parsed.port) : 443;
  const path = parsed.pathname + parsed.search;

  // SNI must be the hostname, never an IP. For an IP-literal destination we leave
  // servername unset: RFC 6066 forbids an IP in SNI (Node warns + will drop it),
  // and TLS still verifies the cert against the IP identity (IP SAN) because
  // `host` is the IP. For a hostname, SNI = the hostname.
  const strippedHost = stripBrackets(parsed.hostname);
  const hostIsIpLiteral = isIP(strippedHost) !== 0;

  const options: RequestOptions = {
    // Keep the ORIGINAL host: this drives the Host header, TLS SNI (for
    // hostnames), and certificate identity verification.
    host: parsed.hostname,
    servername: hostIsIpLiteral ? undefined : strippedHost,
    port,
    path,
    method: "POST",
    headers: req.headers,
    // rejectUnauthorized defaults to true — we NEVER disable it.
    // agent:false -> a fresh, non-pooled connection for THIS request. Without it
    // Node's keep-alive global agent could reuse a pooled socket from an earlier
    // attempt, bypassing this attempt's freshly resolved+validated+pinned IP.
    // V1 does not pool webhook connections.
    agent: false,
    // Pin the socket to the validated IP: this lookup ignores the hostname and
    // always returns our pre-validated address, so no second DNS resolution can
    // move the connection to a different (rebinding) target.
    lookup: (_hostname, _opts, cb) => {
      // https/tls call lookup with { all: true }; return an array.
      cb(null, [{ address: pinnedIp, family }] as never);
    },
  };
  if (deps.tlsCa !== undefined) {
    (options as RequestOptions & { ca?: string | Buffer }).ca = deps.tlsCa;
  }

  return new Promise<TransportResult>((resolveResult) => {
    let timedOut = false;
    let settled = false;
    const done = (result: TransportResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };

    const request = httpsRequest(options, (res) => {
      const status = res.statusCode ?? 0;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(", ");
      }
      readCappedBody(res, MAX_RESPONSE_SNIPPET_BYTES).then((bodyText) => {
        // https.request NEVER auto-follows redirects, so a 3xx arrives here as a
        // normal response with its 3xx status — classified as permanent upstream.
        done({ kind: "response", status, headers, bodyText, resolvedIp: pinnedIp });
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      request.destroy(new Error("timeout"));
    }, req.timeoutMs);

    request.on("error", (err) => {
      if (timedOut) {
        done({ kind: "timeout", resolvedIp: pinnedIp });
      } else {
        done({
          kind: "network",
          message: err instanceof Error ? err.message : String(err),
          resolvedIp: pinnedIp,
        });
      }
    });

    request.write(req.body);
    request.end();
  });
}

function stripBrackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}
