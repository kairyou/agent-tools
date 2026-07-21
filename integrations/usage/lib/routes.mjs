// Known gateway usage endpoints and the probing order for a given context.

import { requestJson } from "./http.mjs";
import {
  usagePreset,
  panelUserHeaders,
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
  formatMoney,
  usageRoot,
  hasV1UsageFields,
  formatQuota,
  formatNewApiTokenLine,
  formatOpenRouterLine,
  formatPanelUserSelfLine,
  panelQuotaScale,
  panelQuotaLooksRemaining,
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
  const json = await requestJson(await subscriptionUrl(context.baseUrl), context.key, {
    name: "v1 usage",
  });
  if (!hasV1UsageFields(usageRoot(json))) throw new Error("v1 usage payload has no usage fields");
  return usageResult(context, "v1-usage", await formatQuota(context.label, json), json);
}

// NewAPI / OneAPI family panels: use the current API key as Bearer auth and
// query token usage from the service root rather than the /v1 OpenAI-compatible
// path.
async function fetchNewApiTokenUsage(context) {
  const json = await requestJson(joinUrl(serviceRoot(context.baseUrl), "/api/usage/token/"), context.key, {
    name: "NewAPI token usage",
  });
  const root = usageRoot(json);
  const quota = pickNumber(root, ["quota", "limit", "total_quota", "totalQuota"]);
  const used = pickNumber(root, ["used_quota", "usedQuota", "used"]);
  let remaining = pickNumber(root, ["remain_quota", "remainQuota", "remaining", "balance"]);
  if (remaining === undefined && quota !== undefined && used !== undefined) {
    remaining = Math.max(0, quota - used);
  }
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
  return usageResult(context, "newapi-token", await formatNewApiTokenLine(context.label, json), normalized);
}

// NewAPI / OneAPI / OneHub / DoneHub / Veloera panel session endpoint, based on
// Metapi's platform handling. This works when PROVIDER_USAGE_API_KEY is a panel
// access/session token, or when the site accepts the API key for /api/user/self.
async function fetchPanelUserSelfUsage(context) {
  const preset = await usagePreset();
  const kind = preset === "auto" ? "new-api" : preset;
  const json = await requestJson(joinUrl(serviceRoot(context.baseUrl), "/api/user/self"), context.key, {
    name: "panel /api/user/self",
    headers: await panelUserHeaders(),
  });
  const root = usageRoot(json);
  if (pickNumber(root, ["quota"]) === undefined && pickNumber(root, ["used_quota", "usedQuota"]) === undefined) {
    await debugLog({
      source: "panel /api/user/self",
      payloadKeys: Object.keys(root || {}).slice(0, 20),
      success: root?.success,
      message: root?.message || root?.error?.message || "",
    });
  }
  const scale = panelQuotaScale(kind);
  const quota = pickNumber(root, ["quota"]);
  const used = pickNumber(root, ["used_quota", "usedQuota"]);
  const remaining = panelQuotaLooksRemaining(kind)
    ? quota
    : (quota === undefined || used === undefined ? quota : Math.max(0, quota - used));
  const total = panelQuotaLooksRemaining(kind)
    ? (quota === undefined || used === undefined ? quota : quota + used)
    : quota;
  const normalized = {
    mode: "quota_limited",
    quota: {
      limit: total === undefined ? undefined : total / scale,
      used: used === undefined ? undefined : used / scale,
      remaining: remaining === undefined ? undefined : remaining / scale,
    },
    unit: "USD",
    source: "panel-user-self",
    raw: json,
  };
  return usageResult(
    context,
    "panel-user-self",
    await formatPanelUserSelfLine(context.label, json, kind),
    normalized
  );
}

// Sub2API exposes user balance as USD at /api/v1/auth/me. Newer deployments may
// also expose richer subscription summaries through /v1/usage, so this route is
// a fallback for deployments where /v1/usage is unavailable.
async function fetchSub2ApiAuthMeUsage(context) {
  const json = await requestJson(joinUrl(serviceRoot(context.baseUrl), "/api/v1/auth/me"), context.key, {
    name: "Sub2API auth/me",
  });
  const root = usageRoot(json);
  const balance = pickNumber(root, ["balance"]);
  if (balance === undefined) throw new Error("Sub2API auth/me payload has no balance field");
  const normalized = {
    mode: "unrestricted",
    planName: root?.username || root?.email || context.label || "Sub2API",
    balance,
    unit: "USD",
    source: "sub2api-auth-me",
    raw: json,
  };
  return usageResult(
    context,
    "sub2api-auth-me",
    `API | balance ${formatMoney(balance)}`,
    normalized
  );
}

// OpenRouter exposes normal API-key usage at /api/v1/key. Some accounts also
// expose credits at /api/v1/credits; keep this route isolated because
// OpenRouter's base URL already includes /api/v1, unlike NewAPI/OneAPI.
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
      const json = await requestJson(endpoint.url, context.key, { name: endpoint.source });
      return usageResult(context, endpoint.source, formatOpenRouterLine("OpenRouter", json), json);
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
  "sub2api-auth-me": {
    id: "sub2api-auth-me",
    path: "/api/v1/auth/me",
    run: fetchSub2ApiAuthMeUsage,
  },
  "newapi-token": {
    id: "newapi-token",
    path: "/api/usage/token/",
    run: fetchNewApiTokenUsage,
  },
  "panel-user-self": {
    id: "panel-user-self",
    path: "/api/user/self",
    run: fetchPanelUserSelfUsage,
  },
  "openrouter": {
    id: "openrouter",
    path: "/api/v1/key",
    run: fetchOpenRouterUsage,
  },
};

// Presets are probe-order aliases over the routes above, not separate
// protocols (e.g. anyrouter/agentrouter just try the NewAPI panel endpoints
// and /v1/usage in a different order).
// They do not provide panel session-cookie authentication; only endpoints that
// accept the configured Bearer key can succeed.
async function usageRouteIds(context) {
  const preset = await usagePreset();
  const routes = {
    "sub2api": ["v1-usage", "sub2api-auth-me"],
    "openai-compatible": ["v1-usage"],
    "new-api": ["newapi-token", "panel-user-self"],
    "one-api": ["newapi-token", "panel-user-self"],
    "onehub": ["newapi-token", "panel-user-self"],
    "one-hub": ["newapi-token", "panel-user-self"],
    "donehub": ["newapi-token", "panel-user-self"],
    "done-hub": ["newapi-token", "panel-user-self"],
    "veloera": ["panel-user-self", "newapi-token"],
    "anyrouter": ["newapi-token", "panel-user-self", "v1-usage"],
    "agentrouter": ["newapi-token", "panel-user-self", "v1-usage"],
    "openrouter": ["openrouter"],
  };
  if (routes[preset]) return routes[preset];

  if (preset !== "auto") return [];
  if (hostIncludes(context.baseUrl, "openrouter.ai")) return ["openrouter"];
  return ["v1-usage", "sub2api-auth-me", "newapi-token", "panel-user-self"];
}

async function cachedUsageRoute(context) {
  const cache = await readRouteCache();
  const key = usageRouteCacheKey(context.baseUrl);
  const route = cache.routes[key];
  return route?.route && USAGE_ROUTES[route.route] ? route : null;
}

export async function orderedUsageRoutes(context) {
  const routeIds = await usageRouteIds(context);
  const cached = await cachedUsageRoute(context);
  if (!cached || !routeIds.includes(cached.route)) return routeIds.map((id) => USAGE_ROUTES[id]).filter(Boolean);
  await debugLog({
    source: "route-cache",
    key: usageRouteCacheKey(context.baseUrl),
    route: cached.route,
    path: cached.path || USAGE_ROUTES[cached.route]?.path || "",
  });
  return [cached.route, ...routeIds.filter((id) => id !== cached.route)]
    .map((id) => USAGE_ROUTES[id])
    .filter(Boolean);
}
