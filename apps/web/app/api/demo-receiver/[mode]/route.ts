import type { NextRequest } from "next/server";

import { handleDemoReceiver } from "@/lib/demo-receiver";

// POST /api/demo-receiver/:mode
// Built-in demo webhook receiver (Phase 4). Fixed set of modes only.
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ mode: string }> }
) {
  const { mode } = await ctx.params;
  return handleDemoReceiver(mode, request);
}
