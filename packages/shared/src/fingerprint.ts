import { createHash } from "node:crypto";

/**
 * Compute the payload fingerprint for an event.
 *
 * Identity is (endpointId + payloadRaw), NOT the body alone: the same
 * idempotency key with the same body but a DIFFERENT endpoint must be treated
 * as a different operation.
 *
 * Encoding is unambiguous via length-prefixing the endpointId: we write
 * `<len>:<endpointId>:<payloadRaw>`. Because <len> tells you exactly how many
 * characters the endpointId occupies, no two distinct (endpointId, payloadRaw)
 * pairs can ever produce the same input string (no delimiter-collision).
 */
export function computePayloadFingerprint(
  endpointId: string,
  payloadRaw: string
): string {
  const framed = `${endpointId.length}:${endpointId}:${payloadRaw}`;
  return createHash("sha256").update(framed, "utf8").digest("hex");
}
