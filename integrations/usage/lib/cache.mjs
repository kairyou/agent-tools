// On-disk state under ~/.agent-tools/cache: the last working route per
// gateway, the latest usage snapshot, and refresh bookkeeping.

import { writeFile, mkdir, open, unlink, rename, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, ...details, startedAt: new Date().toISOString() })}\n`
        );
      } finally {
        await handle.close();
      }
      return async () => {
        await unlink(lockPath).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) return null;
      const age = await stat(lockPath).then(
        ({ mtimeMs }) => Date.now() - mtimeMs,
        () => Infinity // vanished under us: retry immediately
      );
      if (age <= staleMs) return null;
      await unlink(lockPath).catch(() => {});
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

export async function acquireUsageRefreshLease(context, leaseMs = 60_000) {
  return await tryLock(refreshLockPath(context), leaseMs, { baseUrl: context.baseUrl });
}

// Writers wait briefly for each other. Cache writes must never block a
// background refresh, so on timeout we proceed unserialized instead.
async function acquireWriteLock({ timeoutMs = 500, staleMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const release = await tryLock(WRITE_LOCK_PATH, staleMs);
    if (release) return release;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return async () => {};
}
