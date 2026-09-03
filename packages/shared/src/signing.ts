// Phase 6 — webhook HMAC-SHA256 signing + verification (one shared protocol).
//
// The WORKER signs; a RECEIVER verifies. Both live here because they must agree
// byte-for-byte on the protocol:
//
//   signedMaterial = `${timestamp}.${payloadRaw}`
//   signature      = HMAC_SHA256(signingSecret, signedMaterial)  (lowercase hex)
//   header value   = `t=${timestamp},v1=${signature}`
//
// where `timestamp` is a Unix time in SECONDS and `payloadRaw` is the EXACT
// stored event body bytes (never re-serialized).

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-Webhook-Signature";
export const DEFAULT_TOLERANCE_SECONDS = 300; // 5 minutes replay window

/** Build the signed material: `${timestamp}.${payloadRaw}`. Single canonical form. */
export function buildSignedMaterial(timestamp: number, payloadRaw: string): string {
  return `${timestamp}.${payloadRaw}`;
}

/** Compute the lowercase-hex HMAC-SHA256 signature over the signed material. */
export function computeSignature(
  secret: string,
  timestamp: number,
  payloadRaw: string
): string {
  return createHmac("sha256", secret)
    .update(buildSignedMaterial(timestamp, payloadRaw), "utf8")
    .digest("hex");
}

/**
 * Produce the `X-Webhook-Signature` header value for one delivery attempt:
 *   t=<timestamp>,v1=<hex-signature>
 * Callers pass a FRESH timestamp per attempt (retries re-sign with a new t).
 */
export function buildSignatureHeader(
  secret: string,
  timestamp: number,
  payloadRaw: string
): string {
  const signature = computeSignature(secret, timestamp, payloadRaw);
  return `t=${timestamp},v1=${signature}`;
}

/** Parsed form of an `X-Webhook-Signature` header value. */
export type ParsedSignatureHeader = { timestamp: number; v1: string };

/**
 * Parse `t=<int>,v1=<hex>` (order-independent, tolerant of extra whitespace).
 * Returns null on any structural problem: missing `t`, non-integer `t`, or
 * missing `v1`.
 */
export function parseSignatureHeader(header: string | null | undefined): ParsedSignatureHeader | null {
  if (typeof header !== "string" || header.trim() === "") return null;
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (!/^\d+$/.test(value)) return null;
      t = parseInt(value, 10);
    } else if (key === "v1") {
      if (!/^[0-9a-f]+$/.test(value)) return null;
      v1 = value;
    }
  }
  if (t === null || v1 === null) return null;
  return { timestamp: t, v1 };
}

/** Constant-time hex-string comparison. Safe against unequal lengths. */
function timingSafeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  // timingSafeEqual REQUIRES equal-length buffers; a length mismatch is already
  // a definitive "not equal", so short-circuit (still constant-time per length).
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

export type VerifyInput = {
  payloadRaw: string;
  signatureHeader: string | null | undefined;
  secret: string;
  now: number; // current Unix time in SECONDS (injected for deterministic tests)
  toleranceSeconds?: number;
};

export type VerifyResult =
  | { valid: true }
  | {
      valid: false;
      // Internal-only reason (for server logs). Do NOT return verbatim to an
      // untrusted caller — the demo receiver collapses all of these to a single
      // opaque error.
      reason:
        | "malformed_header"
        | "timestamp_out_of_tolerance"
        | "signature_mismatch";
    };

/**
 * Verify a webhook signature over the EXACT received raw body.
 *
 * Rejects: malformed/absent header, missing t or v1, a timestamp older or newer
 * than `toleranceSeconds` (replay protection, both directions), and any signature
 * mismatch. The comparison is constant-time (timingSafeEqual over equal-length
 * buffers) — never `expected === actual`.
 */
export function verifyWebhookSignature(input: VerifyInput): VerifyResult {
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const parsed = parseSignatureHeader(input.signatureHeader);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  if (Math.abs(input.now - parsed.timestamp) > tolerance) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  const expected = computeSignature(input.secret, parsed.timestamp, input.payloadRaw);
  if (!timingSafeHexEqual(expected, parsed.v1)) {
    return { valid: false, reason: "signature_mismatch" };
  }
  return { valid: true };
}
