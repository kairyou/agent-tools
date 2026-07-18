// Normalized error type for the vision runtime. Every failure surfaced to the
// MCP tool, the diagnostic CLI, or tests carries a stable `code` so callers can
// branch on category without parsing prose.

export const ERROR_CODES = Object.freeze({
  CONFIG: "config_error",
  INPUT: "input_error",
  FETCH: "fetch_error",
  RATE_LIMIT: "rate_limit_error",
  PROVIDER_AUTH: "provider_auth_error",
  PROVIDER_HTTP: "provider_http_error",
  PROVIDER_TIMEOUT: "provider_timeout_error",
  PROVIDER_RESPONSE: "provider_response_error",
});

export class VisionError extends Error {
  constructor(code, message, { cause, detail } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "VisionError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function isVisionError(err) {
  return err instanceof VisionError;
}

// Wrap unknown failures so callers always see a VisionError. Existing
// VisionErrors pass through untouched.
export function toVisionError(err, fallbackCode = ERROR_CODES.PROVIDER_HTTP) {
  if (isVisionError(err)) return err;
  const message = err && typeof err.message === "string" ? err.message : String(err);
  return new VisionError(fallbackCode, message, { cause: err });
}
