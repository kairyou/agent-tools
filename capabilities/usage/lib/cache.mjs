// On-disk state under ~/.agent-tools/cache: the last working route per
// gateway, the latest usage snapshot, and refresh bookkeeping.

import { writeFile, mkdir, open, unlink, rename, stat, utimes } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  CACHE_DIR,
  ROUTE_CACHE_PATH,
  SNAPSHOT_PATH,
  REFRESH_STATE_PATH,
  readTextIfExists,
  debugLog,
} from "./config.mjs";
import { usageRouteCacheKey } from "./urls.mjs";
import { retainedCacheEntries, usageAccountCacheKey } from "./cache-policy.mjs";

const CACHE_VERSION = 1;
const WRITE_LOCK_PATH = join(CACHE_DIR, "usage-cache-write.lock");

// Route keys identify gateways; quota and refresh keys identify accounts.
async function readJsonCache(path, field) {
  try {
    const raw = await readTextIfExists(path);
    const entries = raw.trim() ? JSON.parse(raw)?.[field] : null;
    return {
      version: CACHE_VERSION,
      [field]: retainedCacheEntries(entries),
    };
  } catch {
    return { version: CACHE_VERSION, [field]: {} };
  }
}

// Read-modify-write serialized across processes: the gateway refresh lock
// covers only one account, and skill/CLI queries hold no lock at all, so
// concurrent writers would otherwise drop each other's entries. The temp file
// plus rename keeps readers from ever seeing a half-written file.
export async function updateJsonCache(path, field, source, mutate) {
  const release = await acquireWriteLock();
  if (!release) {
    // Losing one update is safer than an unlocked read-modify-write, which
    // would drop the other gateways' entries. Caches refill on the next run.
    await debugLog({ source, skipped: "cache write lock unavailable" });
    return;
  }
  try {
    const cache = await readJsonCache(path, field);
    mutate(cache[field]);
    cache[field] = retainedCacheEntries(cache[field]);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(cache, null, 2)}\n`);
    await rename(temp, path);
  } catch (error) {
    await debugLog({ source, error: error.message });
  } finally {
    await release();
  }
}

export async function readRouteCache() {
  return await readJsonCache(ROUTE_CACHE_PATH, "routes");
}

export async function rememberUsageRoute(context, route, result) {
  await updateJsonCache(ROUTE_CACHE_PATH, "routes", "route-cache", (routes) => {
    routes[usageRouteCacheKey(context.baseUrl)] = {
      route: route.id,
      path: route.path,
      source: result.source,
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function readUsageSnapshot(context) {
  const key = usageAccountCacheKey(context);
  return await readUsageSnapshotByKey(key);
}

export async function readUsageSnapshotByKey(key) {
  if (!key) return null;
  const cache = await readJsonCache(SNAPSHOT_PATH, "items");
  return cache.items[key] || null;
}

export async function rememberUsageSnapshot(context, result) {
  const key = usageAccountCacheKey(context);
  if (!key || !result?.text) return;
  await updateJsonCache(SNAPSHOT_PATH, "items", "snapshot-cache", (items) => {
    items[key] = {
      text: result.text,
      source: result.source,
      baseUrl: context.baseUrl,
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function rememberRefreshState(context, patch) {
  const key = usageAccountCacheKey(context);
  if (!key) return;
  await updateJsonCache(REFRESH_STATE_PATH, "items", "refresh-state", (items) => {
    items[key] = { ...(items[key] || {}), ...patch, baseUrl: context.baseUrl, updatedAt: new Date().toISOString() };
  });
}

export async function canRefreshUsage(context, minIntervalMs) {
  const key = usageAccountCacheKey(context);
  if (!key) return false;
  if (minIntervalMs <= 0) return true;
  const state = await readJsonCache(REFRESH_STATE_PATH, "items");
  const item = state.items[key] || {};
  const latest = Math.max(
    ...[item.lastStartedAt, item.lastSuccessAt, item.lastFailureAt]
      .map((value) => Date.parse(value || ""))
      .filter(Number.isFinite),
    0
  );
  return latest === 0 || Date.now() - latest >= minIntervalMs;
}

// `wx` fails when the file exists, which makes creating it an atomic
// cross-process lock. Returns a release function, or null when the lock is held.
//
// Best-effort, not a guarantee: the holder keeps touching the file so a live
// holder is unlikely to be declared stale, but a suspended machine, a stalled
// event loop, or a failing utimes can still make one miss its heartbeat. The
// owner token on release covers most of what slips through — a takeover that
// happens between reading the token and unlinking still isn't excluded, and a
// stale holder's heartbeat can even touch the new owner's file, since utimes
// works on the path rather than a handle. Good enough for a background usage
// cache, where the worst case is one duplicated refresh that self-heals.
async function tryLock(lockPath, staleMs, details = {}) {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(
          `${JSON.stringify({ token, pid: process.pid, ...details, startedAt: new Date().toISOString() })}\n`
        );
      } finally {
        await handle.close();
      }
      const heartbeat = setInterval(() => {
        const now = new Date();
        utimes(lockPath, now, now).catch(() => {});
      }, Math.max(50, Math.floor(staleMs / 3)));
      heartbeat.unref(); // must never keep the process alive
      return async () => {
        clearInterval(heartbeat);
        // If we were taken over anyway, the file belongs to someone else and
        // must survive; this check is why a missed heartbeat is recoverable.
        try {
          const held = JSON.parse(await readTextIfExists(lockPath));
          if (held?.token === token) await unlink(lockPath);
        } catch {
          // Unreadable or already gone: nothing of ours left to release.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) return null;
      const age = await stat(lockPath).then(
        ({ mtimeMs }) => Date.now() - mtimeMs,
        () => Infinity // vanished under us: retry immediately
      );
      if (age <= staleMs) return null;
      // Claim the stale lock by renaming it: rename is atomic, so only one
      // process wins and nobody deletes a lock another just created.
      try {
        const claimed = `${lockPath}.${token}`;
        await rename(lockPath, claimed);
        await unlink(claimed).catch(() => {});
      } catch {
        return null; // another process claimed it first
      }
    }
  }
  return null;
}

// The holder keeps its lock warm, so this window mostly decides how soon a
// crashed refresh is reclaimed rather than how long a slow one may run.
export async function acquireUsageRefreshLease(context, leaseMs = 60_000) {
  const key = usageAccountCacheKey(context);
  if (!key) return null;
  return await tryLock(join(CACHE_DIR, `usage-refresh-${key}.lock`), leaseMs);
}

// Writers wait briefly for each other; null means "skip this write" so a cache
// update never blocks a background refresh.
async function acquireWriteLock({ timeoutMs = 500, staleMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const release = await tryLock(WRITE_LOCK_PATH, staleMs);
    if (release) return release;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return null;
}
