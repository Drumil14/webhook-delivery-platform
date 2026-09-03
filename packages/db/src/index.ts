// Shared database package. apps/web and apps/worker import from here so both
// use exactly the same Prisma client and connection logic.
export { prisma, checkDatabaseConnection } from "./client";
export { ensureDemoAccount, DEMO_ACCOUNT_ID } from "./account";
export {
  startDeliveryQueue,
  getDeliveryQueueConfig,
  DELIVERY_QUEUE_CONFIG,
  enqueueDeliveryJob,
  fetchDeliveryJob,
  completeDeliveryJob,
  getDeliveryJobState,
  failDeliveryJob,
  purgeDeliveryQueue,
  stopDeliveryQueue,
} from "./boss";
export { finalizeDelivery } from "./finalize";
export type {
  FinalizeAttempt,
  FinalizeInput,
  FinalizeResult,
  FinalizeHooks,
} from "./finalize";

// Phase 7 — non-attempt job deferral (paused / rate-limited).
export { deferDeliveryJob } from "./defer";
export type { DeferResult, DeferHooks } from "./defer";

// Phase 7 — per-endpoint fixed-window rate limiter.
export {
  tryAcquireEndpointRateLimit,
  windowStartFor,
  nextWindowStart,
} from "./rate-limit";
export type { RateLimitAcquisition } from "./rate-limit";

// Phase 8 — realtime Delivery-update publisher (transactional pg_notify).
export { notifyDeliveryUpdate } from "./notify";

// Re-export generated Prisma types/enums (e.g. Account, Endpoint, Event,
// EndpointStatus, Prisma) so consumers don't import from the generated path.
export * from "./generated/prisma/client";
