#!/usr/bin/env node
// Agent usage runtime (agent-tooling).
// Reads the active provider, probes known gateway usage endpoints, and prints a
// compact balance/quota message. Fails open when provider usage cannot be fetched.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createContext, runInContext } from "node:vm";
import { pathToFileURL } from "node:url";

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const AGENT_TOOLING_HOME = process.env.AGENT_TOOLING_HOME || join(homedir(), ".agent-tooling");
const AUTH_PATH = join(CODEX_HOME, "auth.json");
const CODEX_CONFIG_PATH = join(CODEX_HOME, "config.toml");
const AGENT_CONFIG_PATH = process.env.AGENT_TOOLING_CONFIG || join(AGENT_TOOLING_HOME, "config.jsonc");
const DEBUG_PATH = join(AGENT_TOOLING_HOME, "logs", "usage-debug.log");
const ROUTE_CACHE_PATH = join(AGENT_TOOLING_HOME, "cache", "usage-routes.json");
const SNAPSHOT_PATH = join(AGENT_TOOLING_HOME, "cache", "usage-snapshot.json");
const REFRESH_STATE_PATH = join(AGENT_TOOLING_HOME, "cache", "usage-refresh-state.json");
const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_USAGE_DAYS = 30;
const MAX_USAGE_DAYS = 90;
const DEFAULT_NEW_API_QUOTA_SCALE = 500000;
const ROUTE_CACHE_VERSION = 1;
const SNAPSHOT_VERSION = 1;
const REFRESH_STATE_VERSION = 1;
const SHIELD_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

function parseArgs(argv) {
  const opts = { mode: "hook", agent: "codex" };
  let modeSet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--agent" && argv[i + 1]) {
      opts.agent = argv[++i];
    } else if (arg.startsWith("--agent=")) {
      opts.agent = arg.slice("--agent=".length);
    } else if (!arg.startsWith("-") && !modeSet) {
      opts.mode = arg;
      modeSet = true;
    }
  }
  return opts;
}

const cli = parseArgs(process.argv.slice(2));
const mode = cli.mode;

async function debugLog(event) {
  const config = await agentConfig();
  if (process.env.PROVIDER_USAGE_DEBUG !== "1" && config.debug !== true) return;
  await mkdir(dirname(DEBUG_PATH), { recursive: true });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    ...event,
  });
  await writeFile(DEBUG_PATH, `${line}\n`, { flag: "a" });
}

function hookOut(message) {
  const payload = { continue: true };
  if (message) payload.systemMessage = message;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function textOut(message) {
  if (message) process.stdout.write(`${message}\n`);
}

function failSoft(message, error) {
  const detail = error?.message ? `: ${error.message}` : "";
  if (mode === "hook") hookOut();
  else if (mode !== "refresh") textOut(`${message}${detail}`);
}

function shortPreview(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function isShieldChallenge(contentType, text) {
  const normalizedType = String(contentType || "").toLowerCase();
  return (
    (normalizedType.includes("text/html") && /var\s+arg1\s*=|acw_sc__v2|cdn_sec_tc|<script/i.test(text)) ||
    /var\s+arg1\s*=/.test(text)
  );
}

function parseChallengeArg1(html) {
  const match = String(html).match(/var\s+arg1\s*=\s*['"]([0-9a-fA-F]+)['"]/);
  return match?.[1]?.toUpperCase() || "";
}

function parseChallengeMapping(html) {
  const match = String(html).match(/for\(var m=\[([^\]]+)\],p=L\(0x115\)/);
  if (!match?.[1]) return null;
  const values = match[1].split(",").map((raw) => {
    const value = raw.trim().toLowerCase();
    if (!value) return Number.NaN;
    return value.startsWith("0x") ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value, 10);
  });
  return values.some((value) => Number.isNaN(value)) ? null : values;
}

function parseChallengeXorSeed(html) {
  const text = String(html);
  const fnStart = text.indexOf("function a0i()");
  const bStart = text.indexOf("function b(");
  const rotateStart = text.indexOf("(function(a,c){");
  const rotateEnd = text.indexOf("),!(function", rotateStart);
  if (fnStart < 0 || bStart < 0 || bStart <= fnStart || rotateStart < 0 || rotateEnd < 0) {
    return "";
  }

  const helperCode = text.slice(fnStart, bStart);
  const rotateCode = `${text.slice(rotateStart, rotateEnd + 1)})`;
  try {
    const sandbox = { decodeURIComponent };
    createContext(sandbox);
    runInContext(helperCode, sandbox, { timeout: 100 });
    runInContext(rotateCode, sandbox, { timeout: 100 });
    const decoder = sandbox.a0j;
    if (typeof decoder !== "function") return "";
    const seed = decoder(0x115);
    return typeof seed === "string" && /^[0-9a-f]+$/i.test(seed) ? seed : "";
  } catch {
    return "";
  }
}

function solveNewApiAcwScV2(html) {
  const arg1 = parseChallengeArg1(html);
  const mapping = parseChallengeMapping(html);
  const xorSeed = parseChallengeXorSeed(html);
  if (!arg1 || !mapping || !xorSeed) return "";

  const reordered = [];
  for (let i = 0; i < arg1.length; i += 1) {
    const ch = arg1[i];
    for (let j = 0; j < mapping.length; j += 1) {
      if (mapping[j] === i + 1) reordered[j] = ch;
    }
  }

  const source = reordered.join("");
  let out = "";
  for (let i = 0; i < source.length && i < xorSeed.length; i += 2) {
    const left = Number.parseInt(source.slice(i, i + 2), 16);
    const right = Number.parseInt(xorSeed.slice(i, i + 2), 16);
    if (Number.isNaN(left) || Number.isNaN(right)) return "";
    out += (left ^ right).toString(16).padStart(2, "0");
  }
  return out;
}

function upsertCookie(cookieHeader, name, value) {
  const parts = String(cookieHeader || "").split(";").map((part) => part.trim()).filter(Boolean);
  let replaced = false;
  const next = parts.map((part) => {
    const eq = part.indexOf("=");
    if (eq < 0) return part;
    const key = part.slice(0, eq).trim();
    if (key !== name) return part;
    replaced = true;
    return `${name}=${value}`;
  });
  if (!replaced) next.push(`${name}=${value}`);
  return next.join("; ");
}

function collectSetCookieHeaders(headers) {
  const getSetCookie = headers?.getSetCookie;
  if (typeof getSetCookie === "function") return getSetCookie.call(headers) || [];
  const single = headers?.get?.("set-cookie");
  return single ? [single] : [];
}

function mergeSetCookiePairs(cookieHeader, setCookieHeaders) {
  let merged = cookieHeader || "";
  for (const raw of setCookieHeaders || []) {
    const firstPair = String(raw || "").split(";")[0]?.trim();
    if (!firstPair) continue;
    const eq = firstPair.indexOf("=");
    if (eq <= 0) continue;
    merged = upsertCookie(merged, firstPair.slice(0, eq).trim(), firstPair.slice(eq + 1));
  }
  return merged;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readTextIfExists(path) {
  if (!existsSync(path)) return "";
  return readFile(path, "utf8");
}

function stripJsonComments(input) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (inString) {
      out += ch;
      escaped = ch === "\\" ? !escaped : false;
      if (ch === "\"" && !escaped) inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

let agentConfigCache;
async function agentConfig() {
  if (agentConfigCache) return agentConfigCache;
  try {
    const raw = await readTextIfExists(AGENT_CONFIG_PATH);
    if (!raw.trim()) {
      agentConfigCache = {};
      return agentConfigCache;
    }
    const parsed = JSON.parse(stripJsonComments(raw.replace(/^\uFEFF/, "")));
    agentConfigCache = parsed.providerUsage || {};
  } catch {
    agentConfigCache = {};
  }
  return agentConfigCache;
}

function stripInlineComment(value) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const prev = value[i - 1];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    if (char === '"' && !inSingle && prev !== "\\") inDouble = !inDouble;
    if (char === "#" && !inSingle && !inDouble) return value.slice(0, i).trim();
  }
  return value.trim();
}

function parseTomlLite(source) {
  const root = {};
  let current = root;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const table = line.match(/^\[([^\]]+)\]$/);
    if (table) {
      current = root;
      for (const part of table[1].split(".")) {
        const key = part.replace(/^['"]|['"]$/g, "");
        current[key] ||= {};
        current = current[key];
      }
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const rawValue = stripInlineComment(line.slice(eq + 1));
    current[key] = parseTomlValue(rawValue);
  }
  return root;
}

function parseTomlValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function activeProvider(config) {
  const providerName = config.model_provider || "openai";
  const provider = config.model_providers?.[providerName] || {};
  return { providerName, provider };
}

function isOfficialBaseUrl(baseUrl) {
  if (!baseUrl) return true;
  const clean = baseUrl.replace(/\/+$/, "");
  return [
    "https://api.openai.com",
    "https://api.openai.com/v1",
    "https://api.anthropic.com",
    "https://api.anthropic.com/v1",
  ].includes(clean);
}

function cleanBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function serviceRoot(baseUrl) {
  const clean = cleanBaseUrl(baseUrl);
  return clean.endsWith("/v1") ? clean.slice(0, -3) : clean;
}

function usageRouteCacheKey(baseUrl) {
  try {
    const url = new URL(cleanBaseUrl(baseUrl));
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname
      .replace(/\/+$/, "")
      .replace(/\/api\/v1$/i, "")
      .replace(/\/v1$/i, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return serviceRoot(baseUrl);
  }
}

function joinUrl(baseUrl, path) {
  return `${cleanBaseUrl(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

function hostIncludes(baseUrl, value) {
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes(value);
  } catch {
    return false;
  }
}

async function providerUsageDays() {
  const config = await agentConfig();
  const value = Number(process.env.PROVIDER_USAGE_DAYS || config.days || DEFAULT_USAGE_DAYS);
  if (!Number.isInteger(value) || value <= 0 || value > MAX_USAGE_DAYS) return DEFAULT_USAGE_DAYS;
  return value;
}

async function subscriptionUrl(baseUrl) {
  const clean = baseUrl.replace(/\/+$/, "");
  const url = clean.endsWith("/v1") ? `${clean}/usage` : `${clean}/v1/usage`;
  return `${url}?days=${await providerUsageDays()}`;
}

async function usagePreset() {
  const config = await agentConfig();
  return String(process.env.PROVIDER_USAGE_PRESET || config.preset || "auto").toLowerCase();
}

async function panelUserId() {
  const config = await agentConfig();
  const raw = process.env.PROVIDER_USAGE_USER_ID || config.userId || "";
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function panelUserHeaders() {
  const userId = await panelUserId();
  if (!userId) return {};
  const value = String(userId);
  return {
    "New-API-User": value,
    "Veloera-User": value,
    "voapi-user": value,
    "User-id": value,
    "X-User-Id": value,
    "Rix-Api-User": value,
    "neo-api-user": value,
  };
}

async function requestJson(url, key, options = {}) {
  let cookieHeader = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.authKey || key}`,
        "user-agent": SHIELD_USER_AGENT,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });

    try {
      const body = await response.text();
      cookieHeader = mergeSetCookiePairs(cookieHeader, collectSetCookieHeaders(response.headers));
      let json = {};
      try {
        json = body ? JSON.parse(body) : {};
      } catch {
        const contentType = response.headers.get("content-type") || "";
        const acwScV2 = isShieldChallenge(contentType, body) ? solveNewApiAcwScV2(body) : "";
        await debugLog({
          source: options.name || "usage",
          url,
          status: response.status,
          contentType,
          shieldRetry: Boolean(acwScV2 && attempt === 0),
          bodyPreview: shortPreview(body),
        });
        if (acwScV2 && attempt === 0) {
          cookieHeader = upsertCookie(cookieHeader, "acw_sc__v2", acwScV2);
          continue;
        }
        throw new Error(`${options.name || "usage"} returned non-JSON (${response.status})`);
      }

      if (!response.ok) {
        const message = json?.error?.message || json?.message || response.statusText;
        await debugLog({
          source: options.name || "usage",
          url,
          status: response.status,
          message,
          bodyPreview: shortPreview(body),
        });
        throw new Error(`${options.name || "usage"} failed (${response.status} ${message})`);
      }

      return json;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`${options.name || "usage"} unavailable`);
}

async function readRouteCache() {
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

async function cachedUsageRoute(context) {
  const cache = await readRouteCache();
  const key = usageRouteCacheKey(context.baseUrl);
  const route = cache.routes[key];
  return route?.route && USAGE_ROUTES[route.route] ? route : null;
}

async function rememberUsageRoute(context, route, result) {
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

async function rememberUsageSnapshot(context, result) {
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

async function rememberRefreshState(context, patch) {
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

function apiKeyFor(auth, provider) {
  if (process.env.PROVIDER_USAGE_API_KEY) return process.env.PROVIDER_USAGE_API_KEY;
  if (process.env.SUB2API_API_KEY) return process.env.SUB2API_API_KEY;
  if (provider.env_key && process.env[provider.env_key]) return process.env[provider.env_key];
  if (auth.OPENAI_API_KEY) return auth.OPENAI_API_KEY;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  return "";
}

function apiKeyForClaude() {
  return (
    process.env.PROVIDER_USAGE_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY ||
    ""
  );
}

function providerLabel(providerName, provider) {
  return String(provider.name || providerName || "API").toUpperCase();
}

function pickNumber(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function formatMoney(value) {
  return `$${value.toFixed(value >= 100 ? 0 : 1)}`;
}

function formatMaybeMoney(value, unit = "USD") {
  if (unit === "USD" || unit === "$") return formatMoney(value);
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${unit}`;
}

function usageParts() {
  return ["API"];
}

async function formatNewApiQuota(value) {
  const scale = await newApiQuotaScale();
  if (Number.isFinite(scale) && scale > 0) return formatMoney(value / scale);
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

async function newApiQuotaScale() {
  const config = await agentConfig();
  const scale = Number(config.newApiQuotaScale || DEFAULT_NEW_API_QUOTA_SCALE);
  return Number.isFinite(scale) && scale > 0 ? scale : 0;
}

function usageRoot(data) {
  return data?.data && typeof data.data === "object" ? data.data : data;
}

function shortDate(value) {
  if (!value) return "";
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[2]}-${match[3]}` : "";
}

function hasSubscriptionLimits(root) {
  const sub = root?.subscription || {};
  return [
    "daily_limit_usd",
    "weekly_limit_usd",
    "monthly_limit_usd",
    "daily_usage_usd",
    "weekly_usage_usd",
    "monthly_usage_usd",
  ].some((key) => pickNumber(sub, [key]) !== undefined);
}

function isQuotaLimitedUsage(root) {
  return root?.mode === "quota_limited" || root?.quota;
}

function isSubscriptionUsage(root) {
  return hasSubscriptionLimits(root) || (root?.mode === "unrestricted" && root?.subscription);
}

function isWalletUsage(root) {
  const planName = String(root?.planName || "");
  return (
    (root?.mode === "unrestricted" && !isSubscriptionUsage(root)) ||
    planName.includes("钱包") ||
    planName.toLowerCase().includes("wallet") ||
    (pickNumber(root, ["balance"]) !== undefined && !hasSubscriptionLimits(root))
  );
}

function hasV1UsageFields(root) {
  return (
    hasSubscriptionLimits(root) ||
    pickNumber(root, [
      "balance",
      "remaining",
      "remain",
      "available",
      "hard_limit_usd",
      "hard_limit",
      "total_granted",
      "quota",
      "total_usage",
      "used",
      "usage",
    ]) !== undefined ||
    pickNumber(root?.quota, ["limit", "quota", "used", "quota_used", "remaining"]) !== undefined ||
    pickNumber(root?.usage?.today, ["actual_cost", "cost"]) !== undefined ||
    (Array.isArray(root?.daily_usage) && root.daily_usage.length > 0)
  );
}

async function formatQuota(label, data) {
  const root = usageRoot(data);
  const unit = root?.unit || "USD";
  const remaining = pickNumber(root, ["remaining"]);
  const hardLimit = pickNumber(root, ["hard_limit_usd", "hard_limit", "total_granted", "quota"]);
  const used = pickNumber(root, ["total_usage", "used", "usage"]);
  const balance = pickNumber(root, ["balance", "remaining", "remain", "available"]);

  if (isQuotaLimitedUsage(root)) return formatQuotaLimitedLine(label, root);
  if (isSubscriptionUsage(root)) return formatUsageLine(label, root);
  if (isWalletUsage(root)) return await formatWalletLine(label, root);
  if (remaining !== undefined) return formatUsageLine(label, root);
  if (balance !== undefined) return `API | balance ${formatMaybeMoney(balance, unit)}`;
  if (hardLimit !== undefined && used !== undefined) {
    return `API | remaining ${formatMaybeMoney(Math.max(0, hardLimit - used), unit)}`;
  }
  if (hardLimit !== undefined) return `API | total ${formatMaybeMoney(hardLimit, unit)}`;

  const keys = Object.keys(root || {}).slice(0, 4).join(", ");
  return keys ? `API | received (${keys})` : `API | checked ${unit}`;
}

async function formatNewApiTokenLine(label, data) {
  const root = usageRoot(data);
  const unlimited = root?.unlimited_quota === true || root?.unlimitedQuota === true;
  const quota = pickNumber(root, ["quota", "limit", "total_quota", "totalQuota"]);
  const used = pickNumber(root, ["used_quota", "usedQuota", "used"]);
  let remaining = pickNumber(root, ["remain_quota", "remainQuota", "remaining", "balance"]);
  if (remaining === undefined && quota !== undefined && used !== undefined) {
    remaining = Math.max(0, quota - used);
  }

  if (!unlimited && quota === undefined && used === undefined && remaining === undefined) {
    throw new Error("NewAPI token usage payload has no quota fields");
  }

  const parts = usageParts();
  if (unlimited) parts.push("unlimited");
  if (remaining !== undefined) parts.push(`balance ${await formatNewApiQuota(remaining)}`);
  if (used !== undefined && quota !== undefined) {
    parts.push(`used ${await formatNewApiQuota(used)}/${await formatNewApiQuota(quota)}`);
  } else if (used !== undefined) {
    parts.push(`used ${await formatNewApiQuota(used)}`);
  }
  return parts.join(" | ");
}

function formatOpenRouterLine(label, data) {
  const root = usageRoot(data);
  const limit = pickNumber(root, ["limit", "limit_remaining", "total_credits"]);
  const remaining = pickNumber(root, ["limit_remaining", "remaining_credits"]);
  const used = pickNumber(root, ["usage", "total_usage", "spend"]);
  const reset = root?.limit_reset || root?.reset_at ? shortDate(root.limit_reset || root.reset_at) : "";
  const parts = usageParts();

  if (remaining !== undefined) parts.push(`balance ${formatMoney(remaining)}`);
  if (used !== undefined && limit !== undefined && limit !== remaining) {
    parts.push(`used ${formatMoney(used)}/${formatMoney(limit)}`);
  } else if (used !== undefined) {
    parts.push(`used ${formatMoney(used)}`);
  }
  if (reset) parts.push(`Reset ${reset}`);

  if (parts.length === 1) throw new Error("OpenRouter payload has no usage fields");
  return parts.join(" | ");
}

function panelQuotaScale(kind) {
  return kind === "veloera" ? 1000000 : DEFAULT_NEW_API_QUOTA_SCALE;
}

function panelQuotaLooksRemaining(kind) {
  return ["new-api", "anyrouter", "agentrouter", "done-hub", "donehub"].includes(kind);
}

async function formatPanelUserSelfLine(label, data, kind) {
  const root = usageRoot(data);
  const scale = panelQuotaScale(kind);
  const quota = pickNumber(root, ["quota"]);
  const used = pickNumber(root, ["used_quota", "usedQuota"]);
  const todayIncome = pickNumber(root, ["today_income", "todayIncome"]);
  const todayUsed = pickNumber(root, ["today_quota_consumption", "todayQuotaConsumption"]);

  if (quota === undefined && used === undefined) {
    throw new Error("panel /api/user/self payload has no quota fields");
  }

  const quotaUsd = quota === undefined ? undefined : quota / scale;
  const usedUsd = used === undefined ? undefined : used / scale;
  const remainingUsd = panelQuotaLooksRemaining(kind)
    ? quotaUsd
    : (quotaUsd === undefined || usedUsd === undefined ? quotaUsd : Math.max(0, quotaUsd - usedUsd));
  const totalUsd = panelQuotaLooksRemaining(kind)
    ? (quotaUsd === undefined || usedUsd === undefined ? quotaUsd : quotaUsd + usedUsd)
    : quotaUsd;

  const parts = usageParts();
  if (remainingUsd !== undefined) parts.push(`balance ${formatMoney(remainingUsd)}`);
  if (usedUsd !== undefined && totalUsd !== undefined) {
    parts.push(`used ${formatMoney(usedUsd)}/${formatMoney(totalUsd)}`);
  } else if (usedUsd !== undefined) {
    parts.push(`used ${formatMoney(usedUsd)}`);
  }
  if (todayUsed !== undefined) parts.push(`today ${formatMoney(todayUsed / scale)}`);
  if (todayIncome !== undefined) parts.push(`income ${formatMoney(todayIncome / scale)}`);
  return parts.join(" | ");
}

function formatQuotaLimitedLine(label, root) {
  const quota = root?.quota || {};
  const limit = pickNumber(quota, ["limit", "quota"]);
  const used = pickNumber(quota, ["used", "quota_used"]);
  const remaining = pickNumber(quota, ["remaining"]) ?? pickNumber(root, ["remaining"]);
  const parts = usageParts();

  if (limit !== undefined && used !== undefined) {
    parts.push(`Q ${formatMoney(used)}/${formatMoney(limit)}`);
  } else if (remaining !== undefined) {
    parts.push(`remaining ${formatMoney(remaining)}`);
  }

  if (Array.isArray(root?.rate_limits) && root.rate_limits.length > 0) {
    const rateParts = root.rate_limits
      .map((entry) => {
        const window = entry?.window;
        const rateLimit = pickNumber(entry, ["limit"]);
        const rateUsed = pickNumber(entry, ["used"]);
        return window && rateLimit !== undefined && rateUsed !== undefined
          ? `${window} ${formatMoney(rateUsed)}/${formatMoney(rateLimit)}`
          : "";
      })
      .filter(Boolean);
    if (rateParts.length > 0) parts.push(rateParts.join(", "));
  }

  return parts.join(" | ");
}

async function formatWalletLine(label, root) {
  const balance = pickNumber(root, ["balance", "remaining", "remain", "available"]);
  const todayCost = pickNumber(root?.usage?.today, ["actual_cost", "cost"]);
  const recentUsage = Array.isArray(root?.daily_usage)
    ? root.daily_usage.reduce((sum, day) => sum + (pickNumber(day, ["actual_cost", "cost"]) || 0), 0)
    : undefined;

  const parts = usageParts();
  if (balance !== undefined) parts.push(`balance ${formatMoney(balance)}`);
  if (todayCost !== undefined) parts.push(`today ${formatMoney(todayCost)}`);
  if (recentUsage !== undefined && root.daily_usage.length > 0) {
    parts.push(`${await providerUsageDays()}d ${formatMoney(recentUsage)}`);
  }
  return parts.join(" | ");
}

function formatUsageLine(label, root) {
  const sub = root?.subscription || {};
  const dailyLimit = pickNumber(sub, ["daily_limit_usd"]);
  const dailyUsage = pickNumber(sub, ["daily_usage_usd"]);
  const weeklyLimit = pickNumber(sub, ["weekly_limit_usd"]);
  const weeklyUsage = pickNumber(sub, ["weekly_usage_usd"]);
  const monthlyLimit = pickNumber(sub, ["monthly_limit_usd"]);
  const monthlyUsage = pickNumber(sub, ["monthly_usage_usd"]);
  const expires = shortDate(sub.expires_at);

  const parts = usageParts();
  if (dailyLimit > 0 && dailyUsage !== undefined) parts.push(`D ${formatMoney(dailyUsage)}/${formatMoney(dailyLimit)}`);
  if (weeklyLimit > 0 && weeklyUsage !== undefined) parts.push(`W ${formatMoney(weeklyUsage)}/${formatMoney(weeklyLimit)}`);
  if (monthlyLimit > 0 && monthlyUsage !== undefined) parts.push(`M ${formatMoney(monthlyUsage)}/${formatMoney(monthlyLimit)}`);
  if (expires) parts.push(`Exp ${expires}`);
  return parts.join(" | ");
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

// NewAPI / OneAPI family, including AnyRouter/AgentRouter-style deployments:
// use the current API key as Bearer auth and query token usage from the service
// root rather than the /v1 OpenAI-compatible path.
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

async function orderedUsageRoutes(context) {
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

async function contextForCodex() {
  const auth = existsSync(AUTH_PATH) ? await readJson(AUTH_PATH) : {};
  const codexConfig = parseTomlLite(await readTextIfExists(CODEX_CONFIG_PATH));
  const { providerName, provider } = activeProvider(codexConfig);
  const baseUrl =
    process.env.PROVIDER_USAGE_BASE_URL ||
    process.env.SUB2API_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    provider.base_url ||
    "";
  const key = apiKeyFor(auth, provider);
  return {
    providerName,
    provider,
    baseUrl,
    key,
    label: providerLabel(providerName, provider),
  };
}

function contextForClaude() {
  const baseUrl =
    process.env.PROVIDER_USAGE_BASE_URL ||
    process.env.ANTHROPIC_BASE_URL ||
    "";
  return {
    providerName: "claude",
    provider: { name: "Claude" },
    baseUrl,
    key: apiKeyForClaude(),
    label: "Claude",
  };
}

async function usageContext(agent) {
  return agent === "claude" ? contextForClaude() : await contextForCodex();
}

async function refresh(agent = "codex") {
  const context = await usageContext(agent);

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
      if (agent === "claude") {
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
    if (agent === "claude") {
      await rememberRefreshState(context, {
        lastFailureAt: new Date().toISOString(),
        lastError: lastError.message,
      });
    }
    throw lastError;
  }
  return { skipped: true, text: "" };
}

async function main() {
  try {
    if (mode === "refresh") {
      await refresh(cli.agent);
    } else if (mode === "print" || mode === "print-or-refresh") {
      const result = await refresh(cli.agent);
      textOut(result?.text || "");
    } else if (mode === "hook") {
      const result = await refresh(cli.agent);
      hookOut(result?.text || "");
    } else {
      throw new Error(`unknown mode: ${mode}`);
    }
  } catch (error) {
    failSoft("Provider usage unavailable", error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
