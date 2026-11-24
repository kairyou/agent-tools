import { setTimeout as delay } from "node:timers/promises";
import { debugLog, usagePreset, REFRESH_INTERVAL_MS } from "./config.mjs";
import { isOfficialBaseUrl } from "./urls.mjs";
import {
  readUsageSnapshot,
  acquireUsageRefreshLease,
  canRefreshUsage,
  rememberUsageRoute,
  rememberUsageSnapshot,
  rememberRefreshState,
} from "./cache.mjs";
import { orderedUsageRoutes } from "./routes.mjs";
import { normalizeUsageContext } from "./context.mjs";
import { usageAccountCacheKey } from "./cache-policy.mjs";

async function probeUsage(context, { agent = "external", mode = "hook", rememberSnapshot = false }) {
  await debugLog({
    mode,
    agent,
    providerName: context.providerName,
    baseUrl: context.baseUrl,
    preset: await usagePreset(),
    providerEnvKey: context.provider?.env_key || "",
    hasProviderUsageKey: Boolean(process.env.PROVIDER_USAGE_API_KEY),
    hasSub2apiKey: Boolean(process.env.SUB2API_API_KEY),
    hasProviderEnvKey: Boolean(context.provider?.env_key && process.env[context.provider.env_key]),
    hasAnthropicAuthToken: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
    hasAnthropicApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    hasEnvOpenaiKey: Boolean(process.env.OPENAI_API_KEY),
  });

  if (!context.key || isOfficialBaseUrl(context.baseUrl)) {
    return { skipped: true, text: "" };
  }

  let lastError;
  for (const route of await orderedUsageRoutes(context)) {
    try {
      const result = await route.run(context);
      await rememberUsageRoute(context, route, result);
      if (rememberSnapshot) {
        await rememberUsageSnapshot(context, result);
        await rememberRefreshState(context, {
          lastSuccessAt: new Date().toISOString(),
          lastError: "",
        });
      }
      return result;
    } catch (error) {
      lastError = error;
      await debugLog({ route: route.id, path: route.path, error: error.message });
    }
  }

  if (lastError) {
    if (rememberSnapshot) {
      await rememberRefreshState(context, {
        lastFailureAt: new Date().toISOString(),
        lastError: lastError.message,
      });
    }
    throw lastError;
  }
  return { skipped: true, text: "" };
}

export async function queryProviderUsage(input, options = {}) {
  return await queryUsageContext(normalizeUsageContext(input), options);
}

const pendingUsageRefreshes = new Map();
// A foreground query can join another process briefly. Status surfaces can
// show their existing snapshot immediately while that process refreshes.
const REFRESH_WAIT_MS = 10_000;
const REFRESH_POLL_MS = 50;

export async function queryUsageContext(context, options = {}) {
  if (!options.rememberSnapshot) return await probeUsage(context, options);
  if (!context.key || isOfficialBaseUrl(context.baseUrl)) return { skipped: true, text: "" };

  const { force = true, wait = force, reuseSnapshot = false } = options;
  const account = usageAccountCacheKey(context);
  const previous = wait && reuseSnapshot ? await readUsageSnapshot(context) : null;
  const deadline = performance.now() + REFRESH_WAIT_MS;
  let contended = false;
  while (true) {
    let task = pendingUsageRefreshes.get(account);
    if (!task) {
      const snapshotVersion = contended && reuseSnapshot ? previous?.updatedAt ?? "" : null;
      task = refreshUsage(context, { ...options, force }, snapshotVersion)
        .finally(() => pendingUsageRefreshes.delete(account));
      pendingUsageRefreshes.set(account, task);
    }
    const outcome = await task;
    if (outcome && (!outcome.fromSnapshot || reuseSnapshot)) return outcome.result;
    if (!wait) return { skipped: true, text: "" };

    contended = true;
    if (performance.now() >= deadline) throw new Error("Usage refresh is already in progress");
    await delay(REFRESH_POLL_MS);
  }
}

async function refreshUsage(context, options, snapshotVersion) {
  let release;
  try {
    release = await acquireUsageRefreshLease(context);
  } catch (error) {
    if (!["EACCES", "EPERM", "EROFS"].includes(error?.code)) throw error;
    // Read-only callers may query on demand. Automatic refreshes still need a
    // lease so multiple processes cannot bypass the shared refresh interval.
    if (!options.force) return null;
    return { result: await probeUsage(context, { ...options, rememberSnapshot: false }) };
  }
  if (!release) return null;
  try {
    // Only callers that accept cached output can reuse another process's
    // result. The snapshot deliberately omits the gateway's raw response.
    if (snapshotVersion !== null) {
      const cached = await cachedUsage(context);
      if (cached && cached.updatedAt !== snapshotVersion) {
        return { result: { ...cached, cached: true }, fromSnapshot: true };
      }
    }
    if (!options.force && !(await canRefreshUsage(context, REFRESH_INTERVAL_MS))) return null;
    await rememberRefreshState(context, { lastStartedAt: new Date().toISOString() });
    return { result: await probeUsage(context, options) };
  } finally {
    await release();
  }
}

// Native status surfaces and commands share snapshots and one refresh per account.
export async function queryCachedProviderUsage(input, { agent, force = false, allowStale = true } = {}) {
  const context = normalizeUsageContext(input);
  if (!context.key || isOfficialBaseUrl(context.baseUrl)) return "";
  const cached = force && !allowStale ? null : await cachedUsage(context);
  if (!force && cached && cached.ageMs < REFRESH_INTERVAL_MS) return cached.text;
  try {
    const result = await queryUsageContext(context, { agent, rememberSnapshot: true, force, wait: false, reuseSnapshot: true });
    if (result.text) return result.text;
  } catch { /* A background refresh may fail while a previous reading is still available. */ }
  return allowStale ? (await readUsageSnapshot(context))?.text || "" : "";
}

export async function cachedUsage(context) {
  const cached = await readUsageSnapshot(context);
  const ageMs = cached?.updatedAt ? Date.now() - Date.parse(cached.updatedAt) : Infinity;
  return cached?.text && Number.isFinite(ageMs) ? { ...cached, ageMs } : null;
}
