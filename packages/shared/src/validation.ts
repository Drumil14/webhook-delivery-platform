// Small, dependency-free request validation shared by the API routes.
// The surface is intentionally tiny; a full schema library (e.g. Zod) is
// deferred until schemas actually grow.

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

export type EventBodyValidation =
  | { ok: true; type: string }
  | { ok: false; error: "INVALID_JSON" | "VALIDATION_ERROR" };

/**
 * Validate an event request body from its RAW serialized form.
 * Requires a JSON object with a non-empty string `type`.
 * (The raw string itself is what gets fingerprinted/stored — see ingest.)
 */
export function validateEventBody(raw: string): EventBodyValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "INVALID_JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "VALIDATION_ERROR" };
  }

  const type = (parsed as Record<string, unknown>).type;
  if (typeof type !== "string" || type.trim() === "") {
    return { ok: false, error: "VALIDATION_ERROR" };
  }

  return { ok: true, type };
}

export type EndpointUrlValidation =
  | { ok: true; url: string }
  | { ok: false; error: "VALIDATION_ERROR"; message: string };

/** Validate an endpoint URL: must be a parseable http(s) URL. */
export function validateEndpointUrl(url: unknown): EndpointUrlValidation {
  if (typeof url !== "string" || url.trim() === "") {
    return { ok: false, error: "VALIDATION_ERROR", message: "`url` is required." };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "VALIDATION_ERROR", message: "`url` is not a valid URL." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: "VALIDATION_ERROR",
      message: "`url` must use http or https.",
    };
  }

  return { ok: true, url };
}
