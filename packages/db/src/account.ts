import { createHash } from "node:crypto";

import { prisma } from "./client";

// V1 uses a single, deterministic demo account. There is NO authentication yet;
// this simply gives every request a real Account to own Endpoints/Events so the
// account boundary can be enforced in queries.
export const DEMO_ACCOUNT_ID = "00000000-0000-0000-0000-000000000001";

// Placeholder API key hash. Not used for auth in Phase 1; it exists only so the
// required `apiKeyHash` column has a real, stable value.
const DEMO_API_KEY = "demo-api-key-phase1";
const DEMO_API_KEY_HASH = createHash("sha256").update(DEMO_API_KEY).digest("hex");

/**
 * Idempotently ensures the demo account exists and returns it.
 * Safe to call on every request (upsert on a fixed id).
 */
export function ensureDemoAccount() {
  return prisma.account.upsert({
    where: { id: DEMO_ACCOUNT_ID },
    update: {},
    create: {
      id: DEMO_ACCOUNT_ID,
      name: "Demo Account",
      apiKeyHash: DEMO_API_KEY_HASH,
    },
  });
}
