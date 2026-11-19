import { scryptSync } from "node:crypto";
import { usageRouteCacheKey } from "./urls.mjs";

// Retention bounds abandoned accounts without a cleanup timer. Display freshness
// is checked separately; retaining an entry does not make its quota current.
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_ENTRIES = 64;
const ACCOUNT_KEY_PREFIX = "scrypt-";
const accountKeys = new Map();

export function usageAccountCacheKey({ baseUrl, key } = {}) {
  if (!baseUrl || !key) return "";
  const route = usageRouteCacheKey(baseUrl);
  const identity = JSON.stringify([route, key]);
  const cached = accountKeys.get(identity);
  if (cached) return cached;

  // Relay credentials can be short. Use a memory-hard derivation and a stable
  // gateway salt so all agents share the same fingerprint for this account.
  const fingerprint = scryptSync(key, route, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 });
  const accountKey = ACCOUNT_KEY_PREFIX + fingerprint.toString("hex");
  if (accountKeys.size === MAX_ENTRIES) accountKeys.delete(accountKeys.keys().next().value);
  accountKeys.set(identity, accountKey);
  return accountKey;
}

export function isUsageAccountCacheKey(key) {
  return typeof key === "string" && key.startsWith(ACCOUNT_KEY_PREFIX) &&
    /^[a-f0-9]{64}$/.test(key.slice(ACCOUNT_KEY_PREFIX.length));
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
