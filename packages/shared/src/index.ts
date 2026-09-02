// packages/shared holds values/types that BOTH apps/web and apps/worker use.
// Phase 0 only needs to prove the shared import works from both processes.
//
// Future phase note: HMAC signing, SSRF guards, retry/backoff, payload
// fingerprinting, and Zod event schemas will live here in later phases.

export const APP_NAME = "Webhook Delivery Platform";
