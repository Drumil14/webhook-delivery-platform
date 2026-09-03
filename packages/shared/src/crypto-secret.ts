// Phase 6 — webhook signing-secret generation + encryption at rest.
//
// Two distinct secrets live in this system, do NOT confuse them:
//  - The ENDPOINT SIGNING SECRET (`whsec_...`): per-endpoint, used to HMAC-sign
//    webhook deliveries. Generated here, encrypted, stored in Endpoint.secretEncrypted.
//  - The SERVER MASTER KEY (WEBHOOK_SECRET_ENCRYPTION_KEY): one server-wide key
//    used ONLY to encrypt/decrypt endpoint signing secrets at rest. Never stored
//    in the DB, never returned by any API, never logged.
//
// These are PURE crypto primitives. They receive the master key as an argument;
// they never read process.env themselves (that would make them untestable and
// hide a fail-open path). The one env-reading convenience, loadMasterKey(), is a
// thin, clearly-separated wrapper below.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM parameters.
const ALGORITHM = "aes-256-gcm";
const MASTER_KEY_BYTES = 32; // 256-bit key
const IV_BYTES = 12; // 96-bit nonce (the GCM standard/recommended size)
const AUTH_TAG_BYTES = 16; // 128-bit authentication tag
const ENVELOPE_VERSION = "v1";

// At least 32 bytes of entropy for the signing secret material.
const SIGNING_SECRET_BYTES = 32;
const SIGNING_SECRET_PREFIX = "whsec_";

/**
 * Thrown when the server master key is missing or malformed. Distinct from a
 * generic decrypt failure so callers can tell an OPERATIONAL misconfiguration
 * (bad/absent env var -> fail the whole process/job, let ops fix it) apart from
 * a DATA problem (one endpoint's ciphertext is corrupt/legacy).
 */
export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyError";
  }
}

/**
 * Generate a fresh, cryptographically-random endpoint signing secret.
 * Format: `whsec_<base64url of 32 random bytes>`. The prefix is cosmetic; the
 * entropy is what matters. NEVER derived from ids/timestamps; uses crypto.randomBytes.
 */
export function generateSigningSecret(): string {
  return SIGNING_SECRET_PREFIX + randomBytes(SIGNING_SECRET_BYTES).toString("base64url");
}

/**
 * Parse + validate a base64-encoded 256-bit master key. Fails CLOSED: the
 * decoded key must be EXACTLY 32 bytes. We never hash/pad/truncate a weak input
 * into shape — a wrong-length key is a hard error.
 */
export function parseMasterKey(raw: string | undefined | null): Buffer {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new MasterKeyError(
      "WEBHOOK_SECRET_ENCRYPTION_KEY is not set. Provide 32 random bytes, base64-encoded."
    );
  }
  const trimmed = raw.trim();
  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, "base64");
  } catch {
    throw new MasterKeyError("WEBHOOK_SECRET_ENCRYPTION_KEY is not valid base64.");
  }
  if (decoded.length !== MASTER_KEY_BYTES) {
    throw new MasterKeyError(
      `WEBHOOK_SECRET_ENCRYPTION_KEY must decode to exactly ${MASTER_KEY_BYTES} bytes ` +
        `(got ${decoded.length}). Generate one with: ` +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  // Reject MALFORMED / NON-CANONICAL base64 that still happens to decode to 32
  // bytes: Node's base64 decoder is lenient (it silently ignores internal
  // whitespace/invalid characters and tolerates wrong padding or non-zero unused
  // trailing bits). Requiring the input to equal the canonical re-encoding of the
  // decoded bytes rejects all of those — the key must be exactly what a correct
  // `randomBytes(32).toString("base64")` would produce.
  if (decoded.toString("base64") !== trimmed) {
    throw new MasterKeyError(
      "WEBHOOK_SECRET_ENCRYPTION_KEY must be canonical standard base64 of exactly 32 bytes."
    );
  }
  return decoded;
}

/**
 * Convenience wrapper: read + validate the master key from the environment.
 * Kept SEPARATE from the crypto primitives on purpose — encrypt/decrypt never
 * touch process.env. Throws MasterKeyError (fail closed) if absent/malformed.
 */
export function loadMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  return parseMasterKey(env.WEBHOOK_SECRET_ENCRYPTION_KEY);
}

/**
 * Encrypt a plaintext secret with AES-256-GCM under `masterKey`.
 * Returns a versioned, self-describing envelope:
 *
 *   v1.<ivBase64>.<ciphertextBase64>.<authTagBase64>
 *
 * A FRESH random IV is generated per call, so encrypting the same plaintext
 * twice yields different ciphertext. The GCM auth tag makes the ciphertext
 * tamper-evident (decryption throws if any byte is altered).
 */
export function encryptSecret(plaintext: string, masterKey: Buffer): string {
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw new MasterKeyError("master key must be exactly 32 bytes.");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString("base64"),
    ciphertext.toString("base64"),
    authTag.toString("base64"),
  ].join(".");
}

/**
 * Decrypt an envelope produced by encryptSecret. Throws on ANY problem:
 *  - malformed envelope (wrong shape/version/lengths)
 *  - tampered ciphertext or auth tag (GCM verification fails)
 *  - wrong master key
 *
 * There is NO plaintext fallback. A value that is not a valid v1 envelope (e.g.
 * a legacy Phase 1 placeholder) is rejected, never treated as a plaintext secret.
 */
export function decryptSecret(envelope: string, masterKey: Buffer): string {
  if (masterKey.length !== MASTER_KEY_BYTES) {
    throw new MasterKeyError("master key must be exactly 32 bytes.");
  }
  if (typeof envelope !== "string") {
    throw new Error("encrypted secret is not a string.");
  }
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error("encrypted secret is not a valid v1 envelope.");
  }
  const iv = Buffer.from(parts[1]!, "base64");
  const ciphertext = Buffer.from(parts[2]!, "base64");
  const authTag = Buffer.from(parts[3]!, "base64");
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new Error("encrypted secret has malformed IV or auth tag.");
  }
  const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(authTag);
  // decipher.final() throws if the auth tag does not verify (tamper/wrong key).
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
