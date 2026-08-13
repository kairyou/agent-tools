// Secret redaction for logs, errors, and diagnostic output. The resolved API
// key must never leave the process in any output path, so every user-facing
// string funnels through redactSecrets() at the boundary.

const MASK = "***";

// Replace every occurrence of each secret in `text`. Secrets shorter than 4
// characters are still masked; they are simply too dangerous to echo anywhere.
export function redactSecrets(text, secrets) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const secret of secrets || []) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    out = out.split(secret).join(MASK);
  }
  return out;
}

// Redact secrets anywhere inside a JSON-serializable value (error payloads,
// provider responses captured in error detail, dry-run output).
export function redactDeep(value, secrets) {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, secrets);
    return out;
  }
  return value;
}
