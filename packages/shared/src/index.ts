// packages/shared holds values/types/helpers that BOTH apps/web and apps/worker
// use. Phase 1 adds the payload fingerprint (shared because the worker will use
// the same bytes/fingerprint for signing in a later phase) and small request
// validators.
//
// Future phase note: HMAC signing, SSRF guards, retry/backoff, and DNS pinning
// will live here in later phases — NOT now.

export const APP_NAME = "Webhook Delivery Platform";

export { computePayloadFingerprint } from "./fingerprint";
export { IDEMPOTENCY_KEY_HEADER, validateEventBody } from "./validation";
export type { EventBodyValidation } from "./validation";
export { QUEUE_NAME } from "./queue";
export type { JobPayload } from "./queue";
export {
  DEMO_RETRY_POLICY,
  PRODUCTION_RETRY_POLICY,
  baseRetryDelayMs,
  calculateRetryDelay,
} from "./retry";
export type { RetryPolicy } from "./retry";

// Phase 6 — signing secrets (generation + encryption at rest).
export {
  MasterKeyError,
  generateSigningSecret,
  parseMasterKey,
  loadMasterKey,
  encryptSecret,
  decryptSecret,
} from "./crypto-secret";

// Phase 6 — HMAC-SHA256 signing + verification protocol.
export {
  SIGNATURE_HEADER,
  DEFAULT_TOLERANCE_SECONDS,
  buildSignedMaterial,
  computeSignature,
  buildSignatureHeader,
  parseSignatureHeader,
  verifyWebhookSignature,
} from "./signing";
export type {
  ParsedSignatureHeader,
  VerifyInput,
  VerifyResult,
} from "./signing";

// Phase 8 — realtime delivery-update notification contract.
export {
  DELIVERY_UPDATE_CHANNEL,
  serializeDeliveryUpdate,
  parseDeliveryUpdate,
  toBrowserPayload,
} from "./realtime";
export type {
  DeliveryUpdateKind,
  DeliveryUpdateNotification,
  DeliveryUpdateBrowserPayload,
} from "./realtime";

// Phase 6 — SSRF policy: URL syntax + IP classification + resolve/validate.
export {
  validateEndpointUrlSyntax,
  classifyAddress,
  resolveAndValidateHost,
} from "./ssrf";
export type {
  UrlSyntaxResult,
  AddressClassification,
  ResolveResult,
  LookupAllFn,
} from "./ssrf";
