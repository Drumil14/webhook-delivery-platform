// Shared database package. apps/web and apps/worker import from here so both
// use exactly the same Prisma client and connection logic.
export { prisma, checkDatabaseConnection } from "./client";
