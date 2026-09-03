import { randomBytes } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { prisma, stopDeliveryQueue } from "@webhook/db";
import { decryptSecret, type LookupAllFn } from "@webhook/shared";

import { createEndpoint, type CreateEndpointResult } from "@/lib/create-endpoint";

// Creation-time SSRF + secret behavior. Uses the createEndpoint lib directly with
// an INJECTED resolver + master key, so it never touches real DNS and is fully
// deterministic. (The endpoints route just wraps this lib.)

const MASTER_KEY = randomBytes(32);
const createdIds: string[] = [];

// A resolver that always returns a safe public address (for the "accepted" case).
const publicLookup: LookupAllFn = async () => [{ address: "9.9.9.9", family: 4 }];
// A resolver that returns a private address (for hostname-based rejection cases).
const loopbackLookup: LookupAllFn = async () => [{ address: "127.0.0.1", family: 4 }];

async function create(url: string, lookup: LookupAllFn = publicLookup) {
  const result = await createEndpoint(JSON.stringify({ url }), { lookup, masterKey: MASTER_KEY });
  if (result.status === 201) createdIds.push(result.body.id);
  return result;
}

/** Assert a 400 rejection with a specific error code (narrows the union). */
function expectRejected(result: CreateEndpointResult, code: string, ctx?: string): void {
  expect(result.status, ctx).toBe(400);
  if (result.status !== 400) return;
  expect(result.body.error, ctx).toBe(code);
}

afterAll(async () => {
  if (createdIds.length > 0) {
    await prisma.endpoint.deleteMany({ where: { id: { in: createdIds } } });
  }
  await stopDeliveryQueue();
  await prisma.$disconnect();
});

describe("Phase 6 — endpoint creation security", () => {
  it("P6-E1: https URL resolving to a public IP is accepted; returns a reveal-once secret", async () => {
    const result = await create("https://api.customer.com/webhook", publicLookup);
    expect(result.status).toBe(201);
    if (result.status !== 201) return;

    // Plaintext secret returned exactly here.
    expect(result.body.secret.startsWith("whsec_")).toBe(true);
    expect(result.body.url).toBe("https://api.customer.com/webhook");
    expect(result.body.status).toBe("active");
    expect(result.body.rateLimitPerMinute).toBe(60);

    // DB stores the ENCRYPTED value, not the plaintext.
    const row = await prisma.endpoint.findUniqueOrThrow({
      where: { id: result.body.id },
      select: { secretEncrypted: true },
    });
    expect(row.secretEncrypted.startsWith("v1.")).toBe(true);
    expect(row.secretEncrypted.includes(result.body.secret)).toBe(false);
    // ...and it decrypts back to exactly the revealed plaintext.
    expect(decryptSecret(row.secretEncrypted, MASTER_KEY)).toBe(result.body.secret);
  });

  it("P6-E2: the created endpoint select never re-exposes the secret", async () => {
    // Proves there is no field carrying the plaintext in a normal endpoint read.
    const result = await create("https://api.customer.com/another", publicLookup);
    expect(result.status).toBe(201);
    if (result.status !== 201) return;
    const row = await prisma.endpoint.findUniqueOrThrow({ where: { id: result.body.id } });
    expect(JSON.stringify(row).includes(result.body.secret)).toBe(false);
  });

  it("P6-E3: http is rejected", async () => {
    expectRejected(await create("http://api.customer.com/webhook"), "UNSAFE_ENDPOINT_URL");
  });

  it("P6-E4: embedded credentials are rejected", async () => {
    expectRejected(
      await create("https://user:pass@api.customer.com/webhook"),
      "UNSAFE_ENDPOINT_URL"
    );
  });

  it("P6-E5: a localhost hostname (resolves to 127.0.0.1) is rejected", async () => {
    expectRejected(await create("https://localhost/webhook", loopbackLookup), "UNSAFE_ENDPOINT_URL");
  });

  it("P6-E6: private / reserved IP LITERALS are rejected (no DNS needed)", async () => {
    const literals = [
      "https://127.0.0.1/webhook", // loopback
      "https://10.0.0.5/webhook", // private
      "https://192.168.1.1/webhook", // private
      "https://169.254.169.254/latest/meta-data", // cloud metadata
      "https://[::1]/webhook", // IPv6 loopback
      "https://[fc00::1]/webhook", // IPv6 unique-local (fc00::/7)
      "https://[fe80::1]/webhook", // IPv6 link-local (fe80::/10)
      "https://[::ffff:127.0.0.1]/webhook", // IPv4-mapped private
    ];
    for (const url of literals) {
      expectRejected(await create(url, publicLookup), "UNSAFE_ENDPOINT_URL", url);
    }
  });

  it("P6-E7: a public IP literal is accepted", async () => {
    const result = await create("https://8.8.8.8/webhook", publicLookup);
    expect(result.status).toBe(201);
  });

  it("P6-E8: a hostname resolving to a mix of public + private is rejected", async () => {
    const mixed: LookupAllFn = async () => [
      { address: "9.9.9.9", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    expectRejected(await create("https://sneaky.example/webhook", mixed), "UNSAFE_ENDPOINT_URL");
  });

  it("P6-E9: malformed URL body is a validation error", async () => {
    expectRejected(await create("not-a-url"), "VALIDATION_ERROR");
  });
});
