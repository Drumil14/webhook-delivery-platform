import process from "node:process";

import {
  checkDatabaseConnection,
  completeDeliveryJob,
  fetchDeliveryJob,
  prisma,
  startDeliveryQueue,
  stopDeliveryQueue,
} from "@webhook/db";
import { APP_NAME, QUEUE_NAME } from "@webhook/shared";

// Phase 2 worker: a standalone, long-running Node process that manually consumes
// the delivery queue. It does NOT send webhooks yet — it only proves durable
// consumption works (fetch -> inspect -> complete).
//
// Future phase note: Phase 3 adds the stale-job guard (using
// expectedAttemptNumber), DeliveryAttempt, outbound HTTP, retries/backoff, and
// status transitions. None of that exists here.

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

  // Manual fetch loop (not work()): Phase 3 needs explicit control over when a
  // job is completed, so we fetch and complete by hand.
  while (running) {
    const job = await fetchDeliveryJob();

    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    console.log(
      `[worker] job ${job.id}: deliveryId=${job.data.deliveryId} expectedAttemptNumber=${job.data.expectedAttemptNumber}`
    );

    // Phase 2 does NOT: send HTTP, create DeliveryAttempt, change Delivery
    // status, or increment attemptCount. It only completes the job to prove
    // durable consumption.
    await completeDeliveryJob(job.id);
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
