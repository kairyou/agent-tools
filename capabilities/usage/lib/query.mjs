import { debugLog, usagePreset, HOOK_SNAPSHOT_MAX_AGE_MS, REFRESH_INTERVAL_MS } from "./config.mjs";
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

export async function queryUsageContext(context, { agent = "external", mode = "hook", rememberSnapshot = false } = {}) {
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

// Native status surfaces and commands share snapshots and one refresh per account.
export async function queryCachedProviderUsage(input, { agent, force = false, allowStale = true } = {}) {
  const context = normalizeUsageContext(input);
  if (!context.key || isOfficialBaseUrl(context.baseUrl)) return "";
  const account = usageAccountCacheKey(context);
  const cached = force && !allowStale ? null : await cachedUsage(context);
  const fallback = allowStale && cached && cached.ageMs < HOOK_SNAPSHOT_MAX_AGE_MS ? cached.text : "";
  let task = pendingUsageRefreshes.get(account);
  if (!task) {
    if (!force && cached && cached.ageMs < REFRESH_INTERVAL_MS) return cached.text;
    task = refreshCachedProviderUsage(context, { agent, force }).finally(() => pendingUsageRefreshes.delete(account));
    pendingUsageRefreshes.set(account, task);
  }
  return (await task) || fallback;
}

async function refreshCachedProviderUsage(context, { agent, force }) {
  const release = await acquireUsageRefreshLease(context);
  if (!release) return "";
  try {
    if (!force && !(await canRefreshUsage(context, REFRESH_INTERVAL_MS))) return "";
    await rememberRefreshState(context, { lastStartedAt: new Date().toISOString() });
    return (await queryUsageContext(context, { agent, rememberSnapshot: true }))?.text || "";
  } catch { return ""; }
  finally { await release(); }
}

export async function cachedUsage(context) {
  const cached = await readUsageSnapshot(context);
  const ageMs = cached?.updatedAt ? Date.now() - Date.parse(cached.updatedAt) : Infinity;
  return cached?.text && Number.isFinite(ageMs) ? { ...cached, ageMs } : null;
}
