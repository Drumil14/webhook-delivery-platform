import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { ensureDemoAccount } from "@webhook/db";

import { updateEndpointStatus } from "@/lib/update-endpoint-status";

// PATCH /api/v1/endpoints/:endpointId
// Body: { "status": "paused" } | { "status": "active" }
//
// Phase 7 pause/resume. Ownership is enforced against the (demo) account.
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ endpointId: string }> }
) {
  const { endpointId } = await ctx.params;
  const raw = await request.text();
  const account = await ensureDemoAccount();
  const result = await updateEndpointStatus(endpointId, account.id, raw);
  return NextResponse.json(result.body, { status: result.status });
}
