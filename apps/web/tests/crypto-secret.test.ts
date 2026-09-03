import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MasterKeyError,
  decryptSecret,
  encryptSecret,
  generateSigningSecret,
  parseMasterKey,
} from "@webhook/shared";

// Pure crypto unit tests — no DB, no network.

const KEY = randomBytes(32);

describe("Phase 6 — signing secret generation", () => {
  it("P6-C1: generates whsec_-prefixed secrets with high entropy, unique per call", () => {
    const a = generateSigningSecret();
    const b = generateSigningSecret();
    expect(a.startsWith("whsec_")).toBe(true);
    expect(a).not.toBe(b);
    // 32 random bytes base64url ≈ 43 chars, plus the "whsec_" prefix.
    expect(a.length).toBeGreaterThan(40);
  });
});

describe("Phase 6 — AES-256-GCM secret encryption", () => {
  it("P6-C2: encrypt -> decrypt returns the original secret", () => {
    const secret = generateSigningSecret();
    const envelope = encryptSecret(secret, KEY);
    expect(decryptSecret(envelope, KEY)).toBe(secret);
  });

  it("P6-C3: ciphertext envelope does not contain the plaintext secret", () => {
    const secret = generateSigningSecret();
    const envelope = encryptSecret(secret, KEY);
    expect(envelope.includes(secret)).toBe(false);
    // Also not present after the whsec_ prefix is stripped.
    expect(envelope.includes(secret.slice("whsec_".length))).toBe(false);
    expect(envelope.startsWith("v1.")).toBe(true);
  });

  it("P6-C4: two encryptions of the same secret differ (fresh IV per call)", () => {
    const secret = generateSigningSecret();
    const e1 = encryptSecret(secret, KEY);
    const e2 = encryptSecret(secret, KEY);
    expect(e1).not.toBe(e2);
    // Both still decrypt to the same plaintext.
    expect(decryptSecret(e1, KEY)).toBe(secret);
    expect(decryptSecret(e2, KEY)).toBe(secret);
  });

  it("P6-C5: tampered ciphertext fails to decrypt (GCM auth)", () => {
    const secret = generateSigningSecret();
    const envelope = encryptSecret(secret, KEY);
    const [v, iv, ct, tag] = envelope.split(".");
    // Flip a byte in the ciphertext.
    const ctBuf = Buffer.from(ct!, "base64");
    ctBuf[0] = ctBuf[0]! ^ 0xff;
    const tampered = [v, iv, ctBuf.toString("base64"), tag].join(".");
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });

  it("P6-C6: tampered auth tag fails to decrypt", () => {
    const secret = generateSigningSecret();
    const envelope = encryptSecret(secret, KEY);
    const [v, iv, ct, tag] = envelope.split(".");
    const tagBuf = Buffer.from(tag!, "base64");
    tagBuf[0] = tagBuf[0]! ^  0xff;
    const tampered = [v, iv, ct, tagBuf.toString("base64")].join(".");
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });

  it("P6-C7: wrong master key fails to decrypt", () => {
    const secret = generateSigningSecret();
    const envelope = encryptSecret(secret, KEY);
    expect(() => decryptSecret(envelope, randomBytes(32))).toThrow();
  });

  it("P6-C8: malformed envelope formats are rejected (no plaintext fallback)", () => {
    // A legacy Phase-1 placeholder (plain hex) is NOT a valid v1 envelope.
    expect(() => decryptSecret(randomBytes(32).toString("hex"), KEY)).toThrow();
    // Wrong version / shape.
    expect(() => decryptSecret("v2.a.b.c", KEY)).toThrow();
    expect(() => decryptSecret("not-an-envelope", KEY)).toThrow();
    expect(() => decryptSecret("v1.only.three", KEY)).toThrow();
    // A raw plaintext secret is never accepted as-is.
    expect(() => decryptSecret("whsec_plaintextvalue", KEY)).toThrow();
  });
});

describe("Phase 6 — master key validation (fail closed)", () => {
  it("P6-C9: accepts exactly 32 bytes base64", () => {
    const raw = randomBytes(32).toString("base64");
    expect(parseMasterKey(raw).length).toBe(32);
  });

  it("P6-C10: rejects missing / empty / wrong-length keys with MasterKeyError", () => {
    expect(() => parseMasterKey(undefined)).toThrow(MasterKeyError);
    expect(() => parseMasterKey("")).toThrow(MasterKeyError);
    expect(() => parseMasterKey("   ")).toThrow(MasterKeyError);
    // 16 bytes -> too short, must NOT be padded/stretched into shape.
    expect(() => parseMasterKey(randomBytes(16).toString("base64"))).toThrow(MasterKeyError);
    // 33 bytes -> too long.
    expect(() => parseMasterKey(randomBytes(33).toString("base64"))).toThrow(MasterKeyError);
  });

  it("P6-C11: rejects malformed / non-canonical base64 that still decodes to 32 bytes", () => {
    const canonical = randomBytes(32).toString("base64");
    // Sanity: the canonical form is accepted.
    expect(parseMasterKey(canonical).length).toBe(32);

    // Internal whitespace: Node's lenient decoder still yields 32 bytes, but this
    // is NOT canonical and must be rejected.
    const withInternalSpace = canonical.slice(0, 10) + " " + canonical.slice(10);
    expect(Buffer.from(withInternalSpace, "base64").length).toBe(32); // decodes to 32...
    expect(() => parseMasterKey(withInternalSpace)).toThrow(MasterKeyError); // ...but rejected

    // Stray non-base64 punctuation is likewise ignored by the decoder -> rejected.
    const withPunct = canonical.slice(0, 10) + "*" + canonical.slice(10);
    expect(() => parseMasterKey(withPunct)).toThrow(MasterKeyError);
  });
});
