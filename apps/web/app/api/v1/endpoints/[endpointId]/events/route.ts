import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { ensureDemoAccount, prisma } from "@webhook/db";
import { IDEMPOTENCY_KEY_HEADER, validateEventBody } from "@webhook/shared";

import { ingestEvent } from "@/lib/ingest";

// POST /api/v1/endpoints/:endpointId/events
// Header: Idempotency-Key: <unique-key>
// Body:   { "type": "order.created", "data": { ... } }
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ endpointId: string }> }
) {
  const { endpointId } = await ctx.params;

  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return NextResponse.json(
      { error: "MISSING_IDEMPOTENCY_KEY" },
      { status: 400 }
    );
  }

  // Read the RAW body exactly as received. This exact string is what we
  // fingerprint and store as payloadRaw (see raw-body guarantee in README).
  const payloadRaw = await request.text();

  const validation = validateEventBody(payloadRaw);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  // Account boundary: the endpoint must belong to the (demo) account.
  const account = await ensureDemoAccount();
  const endpoint = await prisma.endpoint.findFirst({
    where: { id: endpointId, accountId: account.id },
    select: { id: true },
  });
  if (!endpoint) {
    return NextResponse.json({ error: "ENDPOINT_NOT_FOUND" }, { status: 404 });
  }

  const result = await ingestEvent({
    accountId: account.id,
    endpointId: endpoint.id,
    eventType: validation.type,
    payloadRaw,
    idempotencyKey,
  });

  if (result.outcome === "conflict") {
    return NextResponse.json(
      { error: "IDEMPOTENCY_KEY_CONFLICT" },
      { status: 409 }
    );
  }

  const status = result.outcome === "created" ? 201 : 200;
  return NextResponse.json(
    {
      id: result.event.id,
      endpointId: result.event.endpointId,
      eventType: result.event.eventType,
      receivedAt: result.event.receivedAt,
    },
    { status }
  );
}
