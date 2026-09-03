// Shared database package. apps/web and apps/worker import from here so both
// use exactly the same Prisma client and connection logic.
export { prisma, checkDatabaseConnection } from "./client";
export { ensureDemoAccount, DEMO_ACCOUNT_ID } from "./account";
export {
  startDeliveryQueue,
  enqueueDeliveryJob,
  fetchDeliveryJob,
  completeDeliveryJob,
  getDeliveryJobState,
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

// Re-export generated Prisma types/enums (e.g. Account, Endpoint, Event,
// EndpointStatus, Prisma) so consumers don't import from the generated path.
export * from "./generated/prisma/client";
