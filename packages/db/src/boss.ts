import process from "node:process";

import { PgBoss, fromPrisma } from "pg-boss";

import { QUEUE_NAME, type JobPayload } from "@webhook/shared";

import type { Prisma } from "./generated/prisma/client";

// pg-boss is a PostgreSQL-backed job queue. It owns its own `pgboss` schema
// (separate from our `public` schema), so it never collides with our Prisma
// models and Prisma migrate never sees its tables.
//
// This module is the ONLY place that imports pg-boss. Everything else uses the
// small functions below, so pg-boss stays an implementation detail.

let startPromise: Promise<PgBoss> | null = null;
let started: PgBoss | null = null;

/**
 * Lazily construct + start a single pg-boss instance for this process and
 * ensure our one queue exists. `start()` is idempotent and creates/updates the
 * pgboss schema; `createQueue()` is idempotent too.
 */
function getBoss(): Promise<PgBoss> {
  if (!startPromise) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set; cannot start pg-boss.");
    }
    const boss = new PgBoss(connectionString);
    boss.on("error", (error) => console.error("[pg-boss] error:", error));
    startPromise = boss
      .start()
      .then(async () => {
        await boss.createQueue(QUEUE_NAME);
        started = boss;
        return boss;
      })
      .catch((error) => {
        // Allow a later retry if startup failed.
        startPromise = null;
        throw error;
      });
  }
  return startPromise;
}

/** Ensure pg-boss is started and the delivery queue exists (used by the worker). */
export async function startDeliveryQueue(): Promise<void> {
  await getBoss();
}

/**
 * Enqueue the delivery job INSIDE an existing Prisma transaction, using the
 * pg-boss Prisma adapter (`fromPrisma(tx)`). Because the insert into pgboss's
 * job table runs on the same transaction connection, the job is only visible if
 * the surrounding transaction commits — this is what makes Event + Delivery +
 * job atomic.
 */
export async function enqueueDeliveryJob(
  tx: Prisma.TransactionClient,
  payload: JobPayload
): Promise<void> {
  const boss = await getBoss();
  await boss.send(QUEUE_NAME, payload, { db: fromPrisma(tx) });
}

/**
 * Manually fetch (at most) one job. Returns a small, pg-boss-free shape so
 * callers don't depend on pg-boss types. Manual fetch (not `work()`) is
 * intentional: Phase 3 needs explicit control over when a job is completed.
 */
export async function fetchDeliveryJob(): Promise<{
  id: string;
  data: JobPayload;
} | null> {
  const boss = await getBoss();
  const jobs = await boss.fetch<JobPayload>(QUEUE_NAME); // default batchSize: 1
  const job = jobs[0];
  if (!job) return null;
  return { id: job.id, data: job.data };
}

/**
 * Manually mark a fetched job complete. If a Prisma transaction is passed, the
 * completion is run through the pg-boss Prisma adapter so it joins that
 * transaction (used by the guarded finalize so Delivery state + attempt + queue
 * completion commit together).
 */
export async function completeDeliveryJob(
  jobId: string,
  tx?: Prisma.TransactionClient
): Promise<void> {
  const boss = await getBoss();
  if (tx) {
    await boss.complete(QUEUE_NAME, jobId, null, { db: fromPrisma(tx) });
  } else {
    await boss.complete(QUEUE_NAME, jobId);
  }
}

/** Test-support: current pg-boss state of a job ('active' | 'completed' | ...) or null. */
export async function getDeliveryJobState(jobId: string): Promise<string | null> {
  const boss = await getBoss();
  const job = await boss.getJobById(QUEUE_NAME, jobId);
  return job?.state ?? null;
}

/** Delete all jobs on the delivery queue (used by tests for isolation). */
export async function purgeDeliveryQueue(): Promise<void> {
  const boss = await getBoss();
  await boss.deleteAllJobs(QUEUE_NAME);
}

/** Stop pg-boss cleanly (graceful). Safe to call if never started. */
export async function stopDeliveryQueue(): Promise<void> {
  if (started) {
    await started.stop({ graceful: true });
    started = null;
    startPromise = null;
  }
}
