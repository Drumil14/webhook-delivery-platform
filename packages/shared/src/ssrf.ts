// Phase 6 — SSRF policy: URL syntax rules + IP address classification + a
// resolve-and-validate step shared by BOTH the web app (creation-time advisory
// check) and the worker (delivery-time security boundary).
//
// The pure pieces (URL syntax + IP classification) have no I/O and are trivially
// unit-testable. resolveAndValidateHost does DNS but accepts an injectable
// `lookup`, so tests can simulate any DNS answer (including rebinding) without
// touching the network. The actual pinned SOCKET connection lives in the worker
// (apps/worker/src/secure-transport.ts), not here.

import { promises as dns } from "node:dns";

import ipaddr from "ipaddr.js";

export type UrlSyntaxResult =
  | { ok: true; url: string; hostname: string }
  // `kind` lets callers map to the right error code: "malformed" (bad/absent
  // URL) -> VALIDATION_ERROR; "policy" (non-https / credentials) -> UNSAFE_ENDPOINT_URL.
  | { ok: false; kind: "malformed" | "policy"; message: string };

/**
 * Validate endpoint URL SYNTAX (no DNS). Enforces the production policy:
 *  - must be a parseable URL
 *  - must use https:  (http is rejected even for localhost — the security
 *    boundary is more important than local-dev convenience)
 *  - must NOT embed username/password credentials
 *  - must contain a hostname
 *
 * This does not prove the destination is safe (that needs DNS + IP checks); it
 * is the cheap, structural gate.
 */
export function validateEndpointUrlSyntax(url: unknown): UrlSyntaxResult {
  if (typeof url !== "string" || url.trim() === "") {
    return { ok: false, kind: "malformed", message: "`url` is required." };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, kind: "malformed", message: "`url` is not a valid URL." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, kind: "policy", message: "`url` must use https." };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, kind: "policy", message: "`url` must not contain embedded credentials." };
  }
  if (!parsed.hostname) {
    return { ok: false, kind: "malformed", message: "`url` must contain a hostname." };
  }
  return { ok: true, url, hostname: parsed.hostname };
}

export type AddressClassification = { safe: boolean; reason: string };

/** URL.hostname keeps brackets around IPv6 literals ("[::1]"); strip them. */
function stripBrackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

/**
 * Classify a single IP address. SAFE iff it is a globally-routable public
 * ("unicast") address. Everything else — loopback, private (RFC1918), link-local
 * (incl. 169.254.169.254 cloud metadata), CGNAT, unspecified, multicast,
 * broadcast, unique-local IPv6, and other reserved ranges — is UNSAFE.
 *
 * IPv4-mapped IPv6 (::ffff:a.b.c.d) is unwrapped to its embedded IPv4 and
 * classified under the IPv4 policy, so `::ffff:127.0.0.1` is rejected as loopback.
 *
 * Range detection uses ipaddr.js, which handles the fiddly IPv4/IPv6 range math
 * (the reason we depend on it rather than hand-rolling CIDR checks).
 */
export function classifyAddress(ip: string): AddressClassification {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return { safe: false, reason: "unparseable_address" };
  }
  let range = addr.range();
  if (addr.kind() === "ipv6" && range === "ipv4Mapped") {
    // Unwrap and re-classify the embedded IPv4 — do NOT assume "it's IPv6, so it
    // already passed the IPv4 checks".
    range = (addr as ipaddr.IPv6).toIPv4Address().range();
  }
  if (range === "unicast") return { safe: true, reason: "unicast" };
  return { safe: false, reason: range };
}

export type ResolveResult =
  | { ok: true; pinnedIp: string; family: 4 | 6 }
  | { ok: false; reason: string };

/** All-addresses DNS lookup seam. Default resolves real DNS; tests inject fakes. */
export type LookupAllFn = (
  hostname: string
) => Promise<{ address: string; family: number }[]>;

const defaultLookup: LookupAllFn = (hostname) =>
  // verbatim:true keeps IPv4/IPv6 in resolver order (no reordering) so we see
  // and validate every address the resolver actually returned.
  dns.lookup(hostname, { all: true, verbatim: true });

/**
 * Resolve `hostname` to a concrete IP to connect to, validating along the way.
 *
 * - IP literals are classified directly (no DNS).
 * - Otherwise DNS is resolved FRESH (never cached), and EVERY returned address
 *   is validated. If ANY address is unsafe, the whole host is rejected — a
 *   conservative V1 stance that closes "one good, one bad" tricks.
 * - On success, one validated address is chosen to pin the connection to.
 *
 * This must be called immediately before EVERY delivery attempt (and at
 * creation time for fast feedback); its result must not be cached across attempts.
 */
export async function resolveAndValidateHost(
  hostname: string,
  opts: { lookup?: LookupAllFn } = {}
): Promise<ResolveResult> {
  const host = stripBrackets(hostname);

  // IP literal (e.g. https://127.0.0.1/ or https://[::1]/): validate directly.
  if (ipaddr.isValid(host)) {
    const c = classifyAddress(host);
    if (!c.safe) return { ok: false, reason: c.reason };
    const family = ipaddr.parse(host).kind() === "ipv6" ? 6 : 4;
    return { ok: true, pinnedIp: host, family };
  }

  const lookup = opts.lookup ?? defaultLookup;
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host);
  } catch {
    return { ok: false, reason: "dns_resolution_failed" };
  }
  if (!addresses || addresses.length === 0) {
    return { ok: false, reason: "no_addresses" };
  }

  // Validate EVERY resolved address; reject the host if any is unsafe.
  for (const a of addresses) {
    const c = classifyAddress(a.address);
    if (!c.safe) return { ok: false, reason: c.reason };
  }

  const chosen = addresses[0]!;
  return { ok: true, pinnedIp: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}
