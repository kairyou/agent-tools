// On-disk state under ~/.agent-tools/cache: the last working route per
// gateway, the latest usage snapshot, and refresh bookkeeping.

import { writeFile, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ROUTE_CACHE_PATH,
  SNAPSHOT_PATH,
  REFRESH_STATE_PATH,
  REFRESH_LOCK_PATH,
  readTextIfExists,
  debugLog,
} from "./config.mjs";
import { usageRouteCacheKey } from "./urls.mjs";

const ROUTE_CACHE_VERSION = 1;
const SNAPSHOT_VERSION = 1;
const REFRESH_STATE_VERSION = 1;

export async function readRouteCache() {
  try {
    const raw = await readTextIfExists(ROUTE_CACHE_PATH);
    if (!raw.trim()) return { version: ROUTE_CACHE_VERSION, routes: {} };
    const parsed = JSON.parse(raw);
    return {
      version: ROUTE_CACHE_VERSION,
      routes: parsed?.routes && typeof parsed.routes === "object" ? parsed.routes : {},
    };
  } catch {
    return { version: ROUTE_CACHE_VERSION, routes: {} };
  }
}

export async function rememberUsageRoute(context, route, result) {
  try {
    const cache = await readRouteCache();
    const key = usageRouteCacheKey(context.baseUrl);
    cache.routes[key] = {
      route: route.id,
      path: route.path,
      source: result.source,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(dirname(ROUTE_CACHE_PATH), { recursive: true });
    await writeFile(ROUTE_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
  } catch (error) {
    await debugLog({ source: "route-cache", error: error.message });
  }
}

async function readSnapshotCache() {
  try {
    const raw = await readTextIfExists(SNAPSHOT_PATH);
    if (!raw.trim()) return { version: SNAPSHOT_VERSION, items: {} };
    const parsed = JSON.parse(raw);
    return {
      version: SNAPSHOT_VERSION,
      items: parsed?.items && typeof parsed.items === "object" ? parsed.items : {},
    };
  } catch {
    return { version: SNAPSHOT_VERSION, items: {} };
  }
}

export async function readUsageSnapshot(context) {
  const cache = await readSnapshotCache();
  return cache.items[usageRouteCacheKey(context.baseUrl)] || null;
}

export async function rememberUsageSnapshot(context, result) {
  if (!result?.text) return;
  try {
    const cache = await readSnapshotCache();
    const key = usageRouteCacheKey(context.baseUrl);
    cache.items[key] = {
      text: result.text,
      source: result.source,
      baseUrl: context.baseUrl,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
    await writeFile(SNAPSHOT_PATH, `${JSON.stringify(cache, null, 2)}\n`);
  } catch (error) {
    await debugLog({ source: "snapshot-cache", error: error.message });
  }
}

async function readRefreshState() {
  try {
    const raw = await readTextIfExists(REFRESH_STATE_PATH);
    if (!raw.trim()) return { version: REFRESH_STATE_VERSION, items: {} };
    const parsed = JSON.parse(raw);
    return {
      version: REFRESH_STATE_VERSION,
      items: parsed?.items && typeof parsed.items === "object" ? parsed.items : {},
    };
  } catch {
    return { version: REFRESH_STATE_VERSION, items: {} };
  }
}

export async function rememberRefreshState(context, patch) {
  try {
    const state = await readRefreshState();
    const key = usageRouteCacheKey(context.baseUrl);
    state.items[key] = {
      ...(state.items[key] || {}),
      ...patch,
      baseUrl: context.baseUrl,
    };
    await mkdir(dirname(REFRESH_STATE_PATH), { recursive: true });
    await writeFile(REFRESH_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    await debugLog({ source: "refresh-state", error: error.message });
  }
}

export async function canRefreshUsage(context, minIntervalMs) {
  if (minIntervalMs <= 0) return true;
  const state = await readRefreshState();
  const item = state.items[usageRouteCacheKey(context.baseUrl)] || {};
  const latest = Math.max(
    ...[item.lastStartedAt, item.lastSuccessAt, item.lastFailureAt]
      .map((value) => Date.parse(value || ""))
      .filter(Number.isFinite),
    0
  );
  return latest === 0 || Date.now() - latest >= minIntervalMs;
}

export async function acquireUsageRefreshLease(context, leaseMs = 60_000) {
  await mkdir(dirname(REFRESH_LOCK_PATH), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(REFRESH_LOCK_PATH, "wx");
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, baseUrl: context.baseUrl, startedAt: new Date().toISOString() })}\n`
        );
      } finally {
        await handle.close();
      }
      return async () => {
        await unlink(REFRESH_LOCK_PATH).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) return null;
      try {
        const lock = JSON.parse(await readTextIfExists(REFRESH_LOCK_PATH));
        const startedAt = Date.parse(lock?.startedAt || "");
        if (Number.isFinite(startedAt) && Date.now() - startedAt > leaseMs) {
          await unlink(REFRESH_LOCK_PATH).catch(() => {});
          continue;
        }
      } catch {
        await unlink(REFRESH_LOCK_PATH).catch(() => {});
        continue;
      }
      return null;
    }
  }
  return null;
}
