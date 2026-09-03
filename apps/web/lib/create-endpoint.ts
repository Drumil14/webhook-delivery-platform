import { ensureDemoAccount, prisma } from "@webhook/db";
import {
  encryptSecret,
  generateSigningSecret,
  loadMasterKey,
  resolveAndValidateHost,
  validateEndpointUrlSyntax,
  type LookupAllFn,
} from "@webhook/shared";

// Phase 6 — Endpoint creation with a real signing secret + SSRF validation.
//
// Extracted from the route handler so it can be unit-tested with an injected DNS
// resolver (deterministic accept/reject) and master key, without hitting real DNS.

export type CreateEndpointSuccess = {
  status: 201;
  body: {
    id: string;
    url: string;
    status: string;
    rateLimitPerMinute: number;
    createdAt: Date;
    // reveal-once: the plaintext signing secret is returned HERE and NOWHERE ELSE.
    secret: string;
  };
};

export type CreateEndpointFailure = {
  status: 400;
  body: { error: string; message?: string };
};

export type CreateEndpointResult = CreateEndpointSuccess | CreateEndpointFailure;

export type CreateEndpointDeps = {
  // Inject a deterministic DNS resolver in tests (simulate public/private/rebinding).
  lookup?: LookupAllFn;
  // Inject the master key in tests; defaults to loadMasterKey() (env, fail-closed).
  masterKey?: Buffer;
};

/**
 * Create an Endpoint from a raw JSON request body.
 *
 * On success returns the endpoint metadata PLUS the plaintext signing secret,
 * exactly once. The plaintext secret is never stored, never logged, and never
 * returned by any other endpoint — secret rotation/reveal is future work.
 */
export async function createEndpoint(
  rawBody: string,
  deps: CreateEndpointDeps = {}
): Promise<CreateEndpointResult> {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "INVALID_JSON" } };
  }

  const url = (body as Record<string, unknown> | null)?.url;

  // 1-3. URL syntax policy: https-only, no embedded credentials, valid host.
  const syntax = validateEndpointUrlSyntax(url);
  if (!syntax.ok) {
    if (syntax.kind === "malformed") {
      return { status: 400, body: { error: "VALIDATION_ERROR", message: syntax.message } };
    }
    return { status: 400, body: { error: "UNSAFE_ENDPOINT_URL", message: syntax.message } };
  }

  // Optional per-endpoint rate limit (positive integer; default 60). Not a
  // settings system — just an optional field on creation.
  const rlRaw = (body as Record<string, unknown> | null)?.rateLimitPerMinute;
  let rateLimitPerMinute = 60;
  if (rlRaw !== undefined) {
    if (typeof rlRaw !== "number" || !Number.isInteger(rlRaw) || rlRaw < 1 || rlRaw > 10_000) {
      return {
        status: 400,
        body: {
          error: "VALIDATION_ERROR",
          message: "`rateLimitPerMinute` must be an integer between 1 and 10000.",
        },
      };
    }
    rateLimitPerMinute = rlRaw;
  }

  // 4-5. Creation-time SSRF check: resolve the hostname and validate every
  // address. This is fast advisory feedback — the delivery-time check in the
  // worker is the real security boundary (DNS can change between now and then).
  const resolution = await resolveAndValidateHost(syntax.hostname, { lookup: deps.lookup });
  if (!resolution.ok) {
    // Do not leak internal infrastructure details (which IP/range) to the caller.
    return { status: 400, body: { error: "UNSAFE_ENDPOINT_URL" } };
  }

  const account = await ensureDemoAccount();

  // Generate a cryptographically-random signing secret, encrypt it, store ONLY
  // the ciphertext. loadMasterKey() fails closed if the server master key is
  // missing/malformed (no plaintext fallback, no per-boot key generation).
  const masterKey = deps.masterKey ?? loadMasterKey();
  const plaintextSecret = generateSigningSecret();
  const secretEncrypted = encryptSecret(plaintextSecret, masterKey);

  const endpoint = await prisma.endpoint.create({
    data: {
      accountId: account.id,
      url: syntax.url,
      secretEncrypted,
      rateLimitPerMinute,
    },
    select: {
      id: true,
      url: true,
      status: true,
      rateLimitPerMinute: true,
      createdAt: true,
    },
  });

  return {
    status: 201,
    body: { ...endpoint, secret: plaintextSecret },
  };
}
