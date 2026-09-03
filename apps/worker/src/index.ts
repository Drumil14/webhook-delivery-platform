import process from "node:process";

import {
  checkDatabaseConnection,
  fetchDeliveryJob,
  prisma,
  startDeliveryQueue,
  stopDeliveryQueue,
} from "@webhook/db";
import { APP_NAME, QUEUE_NAME } from "@webhook/shared";

import { processDeliveryJob } from "./process-delivery";

// Phase 3 worker: a standalone, long-running Node process that manually consumes
// the delivery queue and performs a real HTTP webhook delivery per job (load
// Delivery -> Event -> Endpoint, POST payloadRaw, record attempt, guarded
// finalize). It does NOT retry/backoff/sign/SSRF-protect yet — those are later
// phases.

const POLL_INTERVAL_MS = 1000;

let running = true;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log(`[worker] ${APP_NAME} worker starting...`);

  const connected = await checkDatabaseConnection();
  if (!connected) {
    console.error("[worker] Database connection failed. Exiting.");
    process.exit(1);
  }
  console.log("[worker] Database connection successful.");

  await startDeliveryQueue();
  console.log(`[worker] pg-boss started; queue "${QUEUE_NAME}" ready.`);
  console.log("[worker] Worker ready.");

  // Manual fetch loop (not work()): we need explicit control over when a job is
  // completed (completion joins the guarded finalize transaction).
  while (running) {
    const job = await fetchDeliveryJob();

    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // One failing job must not kill the loop.
    try {
      await processDeliveryJob(job);
    } catch (error) {
      // Leave the job for pg-boss to reclaim after expiry (at-least-once); do
      // not complete it, since we don't know the outcome.
      console.error(`[worker] Error processing job ${job.id}:`, error);
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] Received ${signal}, shutting down...`);
  running = false;
  await stopDeliveryQueue();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch(async (error) => {
  console.error("[worker] Fatal error during startup:", error);
  await stopDeliveryQueue().catch(() => {});
  process.exit(1);
});
