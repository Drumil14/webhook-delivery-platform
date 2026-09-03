// Single delivery queue. One queue is enough for the whole platform.

export const QUEUE_NAME = "webhook-delivery";

/**
 * The pg-boss job payload. Deliberately tiny: it carries only identifiers, NOT
 * the event payload. The database (Delivery -> Event -> Endpoint) is the source
 * of truth; the worker loads what it needs by `deliveryId`. This keeps queue
 * jobs small and avoids stale copies of event data inside the queue.
 *
 * `expectedAttemptNumber` is part of the stable queue contract from the start.
 * Phase 2 always sets it to 1. Phase 3 will use it for the stale-job guard.
 */
export type JobPayload = {
  deliveryId: string;
  expectedAttemptNumber: number;
};
