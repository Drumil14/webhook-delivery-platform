import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { ensureDemoAccount, prisma } from "@webhook/db";
import { validateEndpointUrl } from "@webhook/shared";

// POST /api/v1/endpoints
// Body: { "url": "https://example.com/webhook" }
// Creates an Endpoint owned by the demo account. Phase 1 only: no SSRF/HMAC.
export async function POST(request: NextRequest) {
  const raw = await request.text();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const url = (body as Record<string, unknown> | null)?.url;
  const check = validateEndpointUrl(url);
  if (!check.ok) {
    return NextResponse.json(
      { error: check.error, message: check.message },
      { status: 400 }
    );
  }

  const account = await ensureDemoAccount();

  // Phase 1 placeholder secret. Real encryption/rotation/signing is a future
  // phase; we only need a non-empty value for the required column. Never
  // returned in the response.
  const secretEncrypted = randomBytes(32).toString("hex");

  const endpoint = await prisma.endpoint.create({
    data: {
      accountId: account.id,
      url: check.url,
      secretEncrypted,
    },
    select: {
      id: true,
      url: true,
      status: true,
      rateLimitPerMinute: true,
      createdAt: true,
    },
  });

  return NextResponse.json(endpoint, { status: 201 });
}
