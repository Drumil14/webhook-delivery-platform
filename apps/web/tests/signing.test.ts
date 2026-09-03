import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildSignatureHeader,
  computeSignature,
  parseSignatureHeader,
  verifyWebhookSignature,
} from "@webhook/shared";

// Pure HMAC signing/verification unit tests — no DB, no network.

const SECRET = "whsec_test_secret_material_x";
// Deliberately awkward whitespace to prove exact-byte signing (a parse+
// re-stringify would change these bytes and break the signature).
const PAYLOAD = '{ "type" : "order.created", "data" : { "x" : 1 } }';
const NOW = 1_700_000_000; // fixed Unix seconds

describe("Phase 6 — HMAC signing", () => {
  it("P6-S1: signs `${t}.${payloadRaw}` with HMAC-SHA256 lowercase hex", () => {
    const t = NOW;
    const expected = createHmac("sha256", SECRET).update(`${t}.${PAYLOAD}`).digest("hex");
    expect(computeSignature(SECRET, t, PAYLOAD)).toBe(expected);
    expect(buildSignatureHeader(SECRET, t, PAYLOAD)).toBe(`t=${t},v1=${expected}`);
  });

  it("P6-S2: parseSignatureHeader reads t and v1 (order-independent)", () => {
    const parsed = parseSignatureHeader("t=1700000000,v1=abcdef01");
    expect(parsed).toEqual({ timestamp: 1_700_000_000, v1: "abcdef01" });
    expect(parseSignatureHeader("v1=abcdef01,t=1700000000")).toEqual({
      timestamp: 1_700_000_000,
      v1: "abcdef01",
    });
  });

  it("P6-S3: parseSignatureHeader rejects malformed / missing parts", () => {
    expect(parseSignatureHeader(null)).toBeNull();
    expect(parseSignatureHeader("")).toBeNull();
    expect(parseSignatureHeader("v1=abcdef")).toBeNull(); // missing t
    expect(parseSignatureHeader("t=1700000000")).toBeNull(); // missing v1
    expect(parseSignatureHeader("t=notanumber,v1=abcdef")).toBeNull();
    expect(parseSignatureHeader("t=1700000000,v1=NOTHEX")).toBeNull();
  });
});

describe("Phase 6 — signature verification", () => {
  it("P6-S4: a valid signature verifies over the EXACT payload bytes", () => {
    const header = buildSignatureHeader(SECRET, NOW, PAYLOAD);
    const result = verifyWebhookSignature({
      payloadRaw: PAYLOAD,
      signatureHeader: header,
      secret: SECRET,
      now: NOW,
    });
    expect(result.valid).toBe(true);
  });

  it("P6-S5: a tampered body fails (signed A, deliver B)", () => {
    const header = buildSignatureHeader(SECRET, NOW, PAYLOAD);
    const result = verifyWebhookSignature({
      payloadRaw: PAYLOAD + " ", // one extra byte
      signatureHeader: header,
      secret: SECRET,
      now: NOW,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("signature_mismatch");
  });

  it("P6-S6: wrong secret fails", () => {
    const header = buildSignatureHeader(SECRET, NOW, PAYLOAD);
    const result = verifyWebhookSignature({
      payloadRaw: PAYLOAD,
      signatureHeader: header,
      secret: "whsec_a_different_secret",
      now: NOW,
    });
    expect(result.valid).toBe(false);
  });

  it("P6-S7: a too-old timestamp is rejected (replay window)", () => {
    // Sign at NOW, verify 10 minutes later with 5-minute tolerance.
    const header = buildSignatureHeader(SECRET, NOW, PAYLOAD);
    const result = verifyWebhookSignature({
      payloadRaw: PAYLOAD,
      signatureHeader: header,
      secret: SECRET,
      now: NOW + 600,
      toleranceSeconds: 300,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("timestamp_out_of_tolerance");
  });

  it("P6-S8: a far-future timestamp is rejected", () => {
    const header = buildSignatureHeader(SECRET, NOW + 600, PAYLOAD);
    const result = verifyWebhookSignature({
      payloadRaw: PAYLOAD,
      signatureHeader: header,
      secret: SECRET,
      now: NOW,
      toleranceSeconds: 300,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("timestamp_out_of_tolerance");
  });

  it("P6-S9: within-tolerance timestamps still verify", () => {
    const header = buildSignatureHeader(SECRET, NOW, PAYLOAD);
    for (const skew of [-299, 0, 299]) {
      const result = verifyWebhookSignature({
        payloadRaw: PAYLOAD,
        signatureHeader: header,
        secret: SECRET,
        now: NOW + skew,
        toleranceSeconds: 300,
      });
      expect(result.valid).toBe(true);
    }
  });

  it("P6-S10: a malformed / absent signature header is rejected", () => {
    for (const header of [null, "", "garbage", "t=1700000000"]) {
      const result = verifyWebhookSignature({
        payloadRaw: PAYLOAD,
        signatureHeader: header,
        secret: SECRET,
        now: NOW,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe("malformed_header");
    }
  });
});
