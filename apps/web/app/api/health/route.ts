import { NextResponse } from "next/server";

import { checkDatabaseConnection } from "@webhook/db";

// Minimal health endpoint: confirms the web process is up and can reach the
// same PostgreSQL database used by the worker.
export const dynamic = "force-dynamic";

export async function GET() {
  const connected = await checkDatabaseConnection();

  return NextResponse.json(
    {
      status: connected ? "ok" : "error",
      database: connected ? "connected" : "disconnected",
    },
    { status: connected ? 200 : 503 }
  );
}
