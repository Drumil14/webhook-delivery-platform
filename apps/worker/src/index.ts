import process from "node:process";

import { checkDatabaseConnection, prisma } from "@webhook/db";
import { APP_NAME } from "@webhook/shared";

// Phase 0 worker: a standalone, long-running Node process (NOT Next.js).
// Its only job right now is to start, connect to the same PostgreSQL database
// via packages/db, log that it is running, and stay alive.
//
// Future phase note: pg-boss, job fetching, webhook delivery, retries/backoff,
// and crash recovery all belong to later phases. Nothing is polled or sent yet.

async function main(): Promise<void> {
  console.log(`[worker] ${APP_NAME} worker starting...`);

  const connected = await checkDatabaseConnection();
  if (!connected) {
    console.error("[worker] Database connection failed. Exiting.");
    process.exit(1);
  }
  console.log("[worker] Database connection successful.");
  console.log("[worker] Worker ready.");

  // Keep the process alive as a long-running service. This idle timer does no
  // work; it simply prevents Node from exiting once main() returns.
  const heartbeat = setInterval(() => {
    // intentionally empty in Phase 0
  }, 60_000);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] Received ${signal}, shutting down...`);
    clearInterval(heartbeat);
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[worker] Fatal error during startup:", error);
  process.exit(1);
});
