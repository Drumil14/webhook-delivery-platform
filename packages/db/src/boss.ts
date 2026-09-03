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

// INFRASTRUCTURE retry config (pg-boss's own retries). This layer ONLY covers
// jobs that never finalized (worker crash, uncaught throw, DB failure, job
// expiry) — NOT HTTP 500/429, which our app handles by completing the job and
// enqueuing a fresh scheduled one. Explanations:
//  - expireInSeconds=60: a fetched (active) job not completed within 60s is
//    reclaimed. Comfortably above HTTP timeout (10s) + load + finalize tx.
//  - retryLimit=3: pg-boss re-makes a failed/expired job available up to 3x.
//  - retryDelay=2: seconds before a reclaimed job becomes fetchable again.
const INFRA_RETRY_LIMIT = 3;
const INFRA_RETRY_DELAY_SECONDS = 2;
const INFRA_EXPIRE_IN_SECONDS = 60;

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
    const queueOptions = {
      retryLimit: INFRA_RETRY_LIMIT,
      retryDelay: INFRA_RETRY_DELAY_SECONDS,
      expireInSeconds: INFRA_EXPIRE_IN_SECONDS,
    };
    startPromise = boss
      .start()
      .then(async () => {
        // createQueue is idempotent (won't update an existing queue), so also
        // updateQueue to ensure the infra retry config is applied.
        await boss.createQueue(QUEUE_NAME, queueOptions);
        await boss.updateQueue(QUEUE_NAME, queueOptions);
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

/** The infra retry config we reconcile the queue to (exposed for verification). */
export const DELIVERY_QUEUE_CONFIG = {
  retryLimit: INFRA_RETRY_LIMIT,
  retryDelay: INFRA_RETRY_DELAY_SECONDS,
  expireInSeconds: INFRA_EXPIRE_IN_SECONDS,
} as const;

/** Read the LIVE pg-boss queue config (retryLimit/retryDelay/expireInSeconds). */
export async function getDeliveryQueueConfig(): Promise<{
  retryLimit: number | undefined;
  retryDelay: number | undefined;
  expireInSeconds: number | undefined;
} | null> {
  const boss = await getBoss();
  const q = await boss.getQueue(QUEUE_NAME);
  if (!q) return null;
  return {
    retryLimit: q.retryLimit,
    retryDelay: q.retryDelay,
    expireInSeconds: q.expireInSeconds,
  };
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
  payload: JobPayload,
  options: { startAfter?: Date } = {}
): Promise<void> {
  const boss = await getBoss();
  // `startAfter` schedules a webhook RETRY at nextRetryAt; omit for the first
  // (immediate) job. Written in the caller's transaction via the adapter.
  // pg-boss validates options strictly, so only include startAfter when set.
  const sendOptions = options.startAfter
    ? { db: fromPrisma(tx), startAfter: options.startAfter }
    : { db: fromPrisma(tx) };
  await boss.send(QUEUE_NAME, payload, sendOptions);
}

/**
 * Manually fetch (at most) one job. Returns a small, pg-boss-free shape so
 * callers don't depend on pg-boss types. Manual fetch (not `work()`) is
 * intentional: Phase 3 needs explicit control over when a job is completed.
 */
export async function fetchDeliveryJob(
  options: { ignoreStartAfter?: boolean } = {}
): Promise<{ id: string; data: JobPayload } | null> {
  const boss = await getBoss();
  // `ignoreStartAfter` lets tests grab a scheduled retry job immediately instead
  // of waiting out its backoff. Production leaves it unset (respects schedule).
  // pg-boss validates strictly, so only pass the flag when true.
  const jobs = options.ignoreStartAfter
    ? await boss.fetch<JobPayload>(QUEUE_NAME, { ignoreStartAfter: true })
    : await boss.fetch<JobPayload>(QUEUE_NAME);
  const job = jobs[0];
  if (!job) return null;
  return { id: job.id, data: job.data };
}

/**
 * Manually mark a fetched job complete. If a Prisma transaction is passed, the
 * completion is run through the pg-boss Prisma adapter so it joins that
 * transaction (used by the guarded finalize so Delivery state + attempt + queue
 * completion commit together).
 *
 * Returns the number of jobs actually transitioned (0 or 1). pg-boss's completion
 * SQL is `UPDATE ... WHERE id = ? AND state = 'active'`, so the return acts as a
 * compare-and-set: 1 means THIS call completed an active job; 0 means the job was
 * already completed (e.g. by a concurrent worker) — used by deferDeliveryJob to
 * make concurrent deferrals of the same job mutually exclusive.
 */
export async function completeDeliveryJob(
  jobId: string,
  tx?: Prisma.TransactionClient
): Promise<number> {
  const boss = await getBoss();
  const response = tx
    ? await boss.complete(QUEUE_NAME, jobId, null, { db: fromPrisma(tx) })
    : await boss.complete(QUEUE_NAME, jobId);
  // CommandResponse is typed as {} but carries `affected` at runtime.
  return (response as { affected?: number }).affected ?? 0;
}

/** Test-support: current pg-boss state of a job ('active' | 'completed' | ...) or null. */
export async function getDeliveryJobState(jobId: string): Promise<string | null> {
  const boss = await getBoss();
  const job = await boss.getJobById(QUEUE_NAME, jobId);
  return job?.state ?? null;
}

/**
 * Mark a fetched (active) job as failed. This is pg-boss's INFRASTRUCTURE
 * failure path — the same one an expired/uncompleted job takes — so a job with
 * infra retry budget becomes eligible again. Used to deterministically exercise
 * crash/reclaim behavior without waiting for expireInSeconds.
 */
export async function failDeliveryJob(jobId: string): Promise<void> {
  const boss = await getBoss();
  await boss.fail(QUEUE_NAME, jobId);
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
