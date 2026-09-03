import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { createEndpoint } from "@/lib/create-endpoint";

// POST /api/v1/endpoints
// Body: { "url": "https://example.com/webhook" }
//
// Creates an Endpoint owned by the demo account with a cryptographically-random
// HMAC signing secret (encrypted at rest). The plaintext `secret` is returned in
// this response ONLY — it is reveal-once and cannot be retrieved again.
//
// The URL must be https, must not embed credentials, and must resolve to a public
// address (SSRF check). This creation-time check is advisory fast feedback; the
// worker re-validates immediately before every delivery attempt.
export async function POST(request: NextRequest) {
  const raw = await request.text();
  const result = await createEndpoint(raw);
  return NextResponse.json(result.body, { status: result.status });
}
