import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { ensureDemoAccount } from "@webhook/db";

import { replayDelivery } from "@/lib/replay-delivery";

// POST /api/v1/deliveries/:deliveryId/replay
//
// Phase 7 manual replay. Only DEAD deliveries may be replayed (409 otherwise).
// Creates a NEW Delivery (manual_replay) for the same Event with a fresh retry
// budget. Ownership is enforced against the (demo) account.
export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ deliveryId: string }> }
) {
  const { deliveryId } = await ctx.params;
  const account = await ensureDemoAccount();
  const result = await replayDelivery(deliveryId, account.id);
  return NextResponse.json(result.body, { status: result.status });
}
