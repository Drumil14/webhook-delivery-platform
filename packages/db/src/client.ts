import process from "node:process";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client";

// This package only CONSUMES the connection string from the environment. How
// DATABASE_URL gets there (an injected env var in production, or a .env file
// loaded by the process in local dev) is the launching process's concern, not
// the database package's.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. In production, inject it as an environment " +
      "variable; in local dev, add it to the repo-root .env (see .env.example)."
  );
}

// Prisma 7 requires a driver adapter for direct database connections.
const adapter = new PrismaPg({ connectionString });

// Reuse a single PrismaClient across hot-reloads in development so we don't
// exhaust database connections. In production a fresh instance per process is
// fine (web and worker are separate processes).
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Minimal connectivity check used by both apps in Phase 0.
 * Runs a trivial `SELECT 1`; returns true if the database answered.
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.error("[db] Database connection check failed:", error);
    return false;
  }
}
