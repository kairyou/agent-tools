import { createHmac } from "node:crypto";
import { usageRouteCacheKey } from "./urls.mjs";

// Retention bounds abandoned accounts without a cleanup timer. Display freshness
// is checked separately; retaining an entry does not make its quota current.
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_ENTRIES = 64;

export function usageAccountCacheKey({ baseUrl, key } = {}) {
  if (!baseUrl || !key) return "";
  // A keyed digest identifies the account without persisting its credential.
  return createHmac("sha256", key).update(usageRouteCacheKey(baseUrl)).digest("hex");
}

export function cacheEntryTime(entry) {
  return Math.max(0, ...[entry?.updatedAt, entry?.lastStartedAt, entry?.lastSuccessAt, entry?.lastFailureAt]
    .map((value) => Date.parse(value || "")).filter(Number.isFinite));
}

export function retainedCacheEntries(entries, now = Date.now()) {
  return Object.fromEntries(Object.entries(entries || {}).reverse()
    .filter(([, entry]) => cacheEntryTime(entry) > now - RETENTION_MS)
    .sort(([, a], [, b]) => cacheEntryTime(b) - cacheEntryTime(a))
    .slice(0, MAX_ENTRIES));
}
