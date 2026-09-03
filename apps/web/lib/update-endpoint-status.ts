import { prisma } from "@webhook/db";

// Phase 7 — endpoint pause/resume. The smallest possible status update; NOT a
// general CRUD/settings surface (endpoint list/detail UI is a later phase).

export type UpdateEndpointStatusResult =
  | { status: 200; body: { id: string; status: string } }
  | { status: 400 | 404; body: { error: string; message?: string } };

const VALID_STATUSES = new Set(["active", "paused"]);

/**
 * Set an endpoint's status to "active" or "paused", enforcing account ownership.
 *
 * - 404 if the endpoint does not exist OR belongs to another account (do not leak
 *   existence across accounts).
 * - 400 VALIDATION_ERROR for a missing/invalid status.
 * - 200 with the persisted status on success.
 */
export async function updateEndpointStatus(
  endpointId: string,
  accountId: string,
  rawBody: string
): Promise<UpdateEndpointStatusResult> {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "INVALID_JSON" } };
  }

  const status = (body as Record<string, unknown> | null)?.status;
  if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
    return {
      status: 400,
      body: { error: "VALIDATION_ERROR", message: '`status` must be "active" or "paused".' },
    };
  }

  // Ownership boundary: only update within the caller's account.
  const existing = await prisma.endpoint.findFirst({
    where: { id: endpointId, accountId },
    select: { id: true },
  });
  if (!existing) {
    return { status: 404, body: { error: "ENDPOINT_NOT_FOUND" } };
  }

  const updated = await prisma.endpoint.update({
    where: { id: endpointId },
    data: { status: status as "active" | "paused" },
    select: { id: true, status: true },
  });

  return { status: 200, body: { id: updated.id, status: updated.status } };
}
