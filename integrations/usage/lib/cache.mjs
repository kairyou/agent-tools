// On-disk state under ~/.agent-tools/cache: the last working route per
// gateway, the latest usage snapshot, and refresh bookkeeping.

import { writeFile, mkdir, open, unlink, rename, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
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

const CACHE_VERSION = 1;
const WRITE_LOCK_PATH = join(CACHE_DIR, "usage-cache-write.lock");

// Every cache file is { version, <field>: { [gatewayKey]: entry } }.
async function readJsonCache(path, field) {
  try {
    const raw = await readTextIfExists(path);
    const entries = raw.trim() ? JSON.parse(raw)?.[field] : null;
    return {
      version: CACHE_VERSION,
      [field]: entries && typeof entries === "object" ? entries : {},
    };
  } catch {
    return { version: CACHE_VERSION, [field]: {} };
  }
}

// Read-modify-write serialized across processes: the gateway refresh lock
// covers only one relay, and skill/CLI queries hold no lock at all, so
// concurrent writers would otherwise drop each other's entries. The temp file
// plus rename keeps readers from ever seeing a half-written file.
async function updateJsonCache(path, field, source, mutate) {
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
  const cache = await readJsonCache(SNAPSHOT_PATH, "items");
  return cache.items[usageRouteCacheKey(context.baseUrl)] || null;
}

export async function rememberUsageSnapshot(context, result) {
  if (!result?.text) return;
  await updateJsonCache(SNAPSHOT_PATH, "items", "snapshot-cache", (items) => {
    items[usageRouteCacheKey(context.baseUrl)] = {
      text: result.text,
      source: result.source,
      baseUrl: context.baseUrl,
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function rememberRefreshState(context, patch) {
  await updateJsonCache(REFRESH_STATE_PATH, "items", "refresh-state", (items) => {
    const key = usageRouteCacheKey(context.baseUrl);
    items[key] = { ...(items[key] || {}), ...patch, baseUrl: context.baseUrl };
  });
}

export async function canRefreshUsage(context, minIntervalMs) {
  if (minIntervalMs <= 0) return true;
  const state = await readJsonCache(REFRESH_STATE_PATH, "items");
  const item = state.items[usageRouteCacheKey(context.baseUrl)] || {};
  const latest = Math.max(
    ...[item.lastStartedAt, item.lastSuccessAt, item.lastFailureAt]
      .map((value) => Date.parse(value || ""))
      .filter(Number.isFinite),
    0
  );
  return latest === 0 || Date.now() - latest >= minIntervalMs;
}

// `wx` fails when the file exists, which makes creating it an atomic
// cross-process lock. A lock left behind by a killed process is reclaimed once
// it is older than staleMs. Returns a release function, or null when held.
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
      return async () => {
        // Release only our own lock: if we were declared stale and taken over,
        // the file now belongs to another process and must survive.
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

// One lock per gateway, keyed like the route and snapshot caches, so
// refreshing one relay never blocks another.
function refreshLockPath(context) {
  const key = usageRouteCacheKey(context.baseUrl);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(CACHE_DIR, `usage-refresh-${hash}.lock`);
}

// Long enough that a slow but healthy refresh is never declared stale: probing
// every route can take minutes when a gateway stalls (each request retries once
// behind a 10s timeout). Shorter than this and a live refresh gets taken over.
export async function acquireUsageRefreshLease(context, leaseMs = 180_000) {
  return await tryLock(refreshLockPath(context), leaseMs, { baseUrl: context.baseUrl });
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
