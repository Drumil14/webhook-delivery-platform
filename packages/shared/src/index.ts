// packages/shared holds values/types/helpers that BOTH apps/web and apps/worker
// use. Phase 1 adds the payload fingerprint (shared because the worker will use
// the same bytes/fingerprint for signing in a later phase) and small request
// validators.
//
// Future phase note: HMAC signing, SSRF guards, retry/backoff, and DNS pinning
// will live here in later phases — NOT now.

export const APP_NAME = "Webhook Delivery Platform";

export { computePayloadFingerprint } from "./fingerprint";
export {
  IDEMPOTENCY_KEY_HEADER,
  validateEventBody,
  validateEndpointUrl,
} from "./validation";
export type { EventBodyValidation, EndpointUrlValidation } from "./validation";
export { QUEUE_NAME } from "./queue";
export type { JobPayload } from "./queue";
