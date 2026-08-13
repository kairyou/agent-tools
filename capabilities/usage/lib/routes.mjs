// Known gateway usage endpoints and the probing order for a given context.

import { readdir } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { requestJson } from "./http.mjs";
import {
  AGENT_TOOLS_HOME,
  agentConfig,
  usagePreset,
  newApiQuotaScale,
  providerUsageDays,
  debugLog,
} from "./config.mjs";
import {
  cleanBaseUrl,
  serviceRoot,
  joinUrl,
  hostIncludes,
  usageRouteCacheKey,
} from "./urls.mjs";
import {
  pickNumber,
  usageRoot,
  hasV1UsageFields,
  formatQuota,
  newApiTokenQuota,
  formatNewApiTokenLine,
  formatOneApiBillingLine,
  hasSpendableOneApiLimit,
  formatOpenRouterLine,
  formatClaudeCodeHubLine,
} from "./format.mjs";
import { readRouteCache } from "./cache.mjs";

async function subscriptionUrl(baseUrl) {
  const clean = baseUrl.replace(/\/+$/, "");
  const url = clean.endsWith("/v1") ? `${clean}/usage` : `${clean}/v1/usage`;
  return `${url}?days=${await providerUsageDays()}`;
}

function usageResult(context, source, text, raw) {
  return {
    updatedAt: new Date().toISOString(),
    baseUrl: context.baseUrl,
    provider: context.providerName,
    source,
    text,
    raw,
  };
}

// Sub2API and several private OpenAI-compatible gateways expose a lightweight
// OpenAI-style endpoint at /v1/usage. This is intentionally probed first for
// generic non-OpenAI base URLs because it does not require a management token.
async function fetchV1Usage(context) {
  const json = await requestJson(await subscriptionUrl(context.baseUrl), {
    key: context.key,
    name: "v1 usage",
  });
  if (!hasV1UsageFields(usageRoot(json))) throw new Error("v1 usage payload has no usage fields");
  return usageResult(context, "v1-usage", await formatQuota(json), json);
}

// New API exposes a read-only usage endpoint authenticated by the same relay
// API key used for model requests.
async function fetchNewApiTokenUsage(context) {
  const json = await requestJson(joinUrl(serviceRoot(context.baseUrl), "/api/usage/token/"), {
    key: context.key,
    name: "New API token usage",
  });
  const { quota, used, remaining } = newApiTokenQuota(json);
  const scale = await newApiQuotaScale();
  const quotaForWarning = scale ? quota / scale : quota;
  const usedForWarning = scale ? used / scale : used;
  const remainingForWarning = scale ? remaining / scale : remaining;
  const normalized = {
    mode: "quota_limited",
    quota: {
      limit: quotaForWarning,
      used: usedForWarning,
      remaining: remainingForWarning,
    },
    unit: scale ? "USD" : "quota",
    source: "newapi-token",
    raw: json,
  };
  return usageResult(context, "newapi-token", await formatNewApiTokenLine(json), normalized);
}

// One API's legacy OpenAI billing endpoints use the same relay API key as
// model requests. Subscription reports the total quota; usage reports cents.
async function fetchOneApiBillingUsage(context) {
  const base = serviceRoot(context.baseUrl);
  const subscription = await requestJson(joinUrl(base, "/v1/dashboard/billing/subscription"), {
    key: context.key,
    name: "One API billing subscription",
  });
  const usage = await requestJson(joinUrl(base, "/v1/dashboard/billing/usage"), {
    key: context.key,
    name: "One API billing usage",
  });
  const limit = pickNumber(subscription, ["hard_limit_usd", "hardLimitUsd"]);
  const usageCents = pickNumber(usage, ["total_usage", "totalUsage"]);
  if (limit === undefined || usageCents === undefined) {
    throw new Error("One API billing payload has no quota fields");
  }
  const used = usageCents / 100;
  const spendableLimit = hasSpendableOneApiLimit(limit);
  const normalized = {
    mode: spendableLimit ? "quota_limited" : "unrestricted",
    ...(spendableLimit ? {
      quota: {
        limit,
        used,
        remaining: Math.max(0, limit - used),
      },
    } : { used }),
    unit: "USD",
    source: "oneapi-billing",
    raw: { subscription, usage },
  };
  return usageResult(
    context,
    "oneapi-billing",
    formatOneApiBillingLine(limit, used),
    normalized
  );
}

// Claude Code Hub exposes self-scoped quota windows to the same API key used
// for model requests. The endpoint accepts the existing Bearer authentication.
async function fetchClaudeCodeHubUsage(context) {
  const base = cleanBaseUrl(context.baseUrl)
    .replace(/\/api\/v1$/i, "")
    .replace(/\/v1$/i, "");
  const json = await requestJson(joinUrl(base, "/api/v1/me/quota"), {
    key: context.key,
    name: "Claude Code Hub quota",
  });
  return usageResult(
    context,
    "claude-code-hub",
    formatClaudeCodeHubLine(json),
    json
  );
}

// OpenRouter exposes normal API-key usage at /api/v1/key. Some accounts also
// expose credits at /api/v1/credits; keep this route isolated because
// OpenRouter's base URL already includes /api/v1, unlike New API.
async function fetchOpenRouterUsage(context) {
  const base = cleanBaseUrl(context.baseUrl).includes("/api/v1")
    ? cleanBaseUrl(context.baseUrl)
    : joinUrl(serviceRoot(context.baseUrl), "/api/v1");
  const endpoints = [
    { source: "openrouter-key", url: joinUrl(base, "/key") },
    { source: "openrouter-credits", url: joinUrl(base, "/credits") },
  ];
  let lastError;
  for (const endpoint of endpoints) {
    try {
      const json = await requestJson(endpoint.url, { key: context.key, name: endpoint.source });
      return usageResult(context, endpoint.source, formatOpenRouterLine(json), json);
    } catch (error) {
      lastError = error;
      await debugLog({ source: endpoint.source, error: error.message });
    }
  }
  throw lastError || new Error("OpenRouter usage unavailable");
}

const USAGE_ROUTES = {
  "v1-usage": {
    id: "v1-usage",
    path: "/v1/usage",
    run: fetchV1Usage,
  },
  "newapi-token": {
    id: "newapi-token",
    path: "/api/usage/token/",
    run: fetchNewApiTokenUsage,
  },
  "oneapi-billing": {
    id: "oneapi-billing",
    path: "/v1/dashboard/billing/subscription",
    run: fetchOneApiBillingUsage,
  },
  "openrouter": {
    id: "openrouter",
    path: "/api/v1/key",
    run: fetchOpenRouterUsage,
  },
  "claude-code-hub": {
    id: "claude-code-hub",
    path: "/api/v1/me/quota",
    run: fetchClaudeCodeHubUsage,
  },
};

// User-authored gateway routes, declared in config.jsonc:
//   "providerUsage": { "routes": ["custom/my-gateway.mjs"] }
// Paths resolve against ~/.agent-tools. Each module exports
// `export async function run(context, helpers)` plus an optional
// `export const meta = { id }` (id defaults to the file name). Broken modules
// are logged and skipped so a bad custom route cannot break the built-ins.
const CUSTOM_ROUTE_HELPERS = { requestJson, agentConfig };

let customRoutesPromise;
function customRoutes() {
  customRoutesPromise ||= loadCustomRoutes();
  return customRoutesPromise;
}

async function loadRouteModule(file, spec) {
  try {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.run !== "function") {
      throw new Error("missing `export async function run(context, helpers)`");
    }
    const id = String(mod.meta?.id || basename(file, extname(file)));
    return {
      id,
      path: spec,
      run: async (context) => {
        const result = await mod.run(context, CUSTOM_ROUTE_HELPERS);
        if (typeof result?.text !== "string" || !result.text) {
          throw new Error(`custom route ${id} returned no text`);
        }
        return {
          updatedAt: new Date().toISOString(),
          baseUrl: context.baseUrl,
          provider: context.providerName,
          source: id,
          ...result,
        };
      },
    };
  } catch (error) {
    await debugLog({ source: "custom-route", file, error: error.message });
    return null;
  }
}

async function loadCustomRoutes() {
  const routes = [];

  // config-declared routes probe first, in config order.
  const config = await agentConfig();
  const specs = Array.isArray(config.routes) ? config.routes : [];
  for (const spec of specs) {
    if (typeof spec !== "string" || !spec.trim()) continue;
    const file = isAbsolute(spec) ? spec : join(AGENT_TOOLS_HOME, spec);
    const route = await loadRouteModule(file, spec);
    if (route) routes.push(route);
  }

  // Repo-shipped routes: the installer replaces this directory from the
  // package's dist/usage/routes on every install, so a fork can distribute
  // gateways to everyone under git control. Config-declared ids win.
  const packagedDir = join(AGENT_TOOLS_HOME, "dist", "usage", "routes");
  let packaged = [];
  try {
    packaged = (await readdir(packagedDir)).filter((n) => n.endsWith(".mjs")).sort();
  } catch {
    packaged = [];
  }
  for (const name of packaged) {
    const route = await loadRouteModule(join(packagedDir, name), `dist/usage/routes/${name}`);
    if (route && !routes.some((existing) => existing.id === route.id)) routes.push(route);
  }

  return routes;
}

async function routeRegistry() {
  const registry = { ...USAGE_ROUTES };
  for (const route of await customRoutes()) registry[route.id] = route;
  return registry;
}

// Presets primarily select API-key usage protocols. Brand aliases map to a
// shared protocol when the upstream gateway exposes the same endpoints.
async function usageRouteIds(context) {
  const preset = await usagePreset();
  const routes = {
    "sub2api": ["v1-usage"],
    "openai-compatible": ["v1-usage"],
    "new-api": ["newapi-token"],
    "one-api": ["oneapi-billing"],
    "one-hub": ["oneapi-billing"],
    "done-hub": ["oneapi-billing"],
    "openrouter": ["openrouter"],
    "claude-code-hub": ["claude-code-hub"],
  };
  if (routes[preset]) return routes[preset];

  // A preset naming a registered route id (built-in or custom) selects it.
  if (preset !== "auto") return (await routeRegistry())[preset] ? [preset] : [];

  // Declared custom routes probe first, in config order.
  const customIds = (await customRoutes()).map((route) => route.id);
  const builtinIds = hostIncludes(context.baseUrl, "openrouter.ai")
    ? ["openrouter"]
    : ["v1-usage", "newapi-token", "oneapi-billing", "claude-code-hub"];
  return [...new Set([...customIds, ...builtinIds])];
}

async function cachedUsageRoute(context, registry) {
  const cache = await readRouteCache();
  const key = usageRouteCacheKey(context.baseUrl);
  const route = cache.routes[key];
  return route?.route && registry[route.route] ? route : null;
}

export async function orderedUsageRoutes(context) {
  const registry = await routeRegistry();
  const routeIds = await usageRouteIds(context);
  const cached = await cachedUsageRoute(context, registry);
  if (!cached || !routeIds.includes(cached.route)) return routeIds.map((id) => registry[id]).filter(Boolean);
  await debugLog({
    source: "route-cache",
    key: usageRouteCacheKey(context.baseUrl),
    route: cached.route,
    path: cached.path || registry[cached.route]?.path || "",
  });
  return [cached.route, ...routeIds.filter((id) => id !== cached.route)]
    .map((id) => registry[id])
    .filter(Boolean);
}
