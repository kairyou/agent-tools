#!/usr/bin/env node
// Codex provider usage hook (agent-tooling).
// Reads the active Codex provider from ~/.codex/config.toml, calls a compatible
// /v1/usage endpoint, and prints a compact balance/quota message as a Codex hook
// systemMessage. Fails open when provider usage cannot be fetched.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const AGENT_TOOLING_HOME = process.env.AGENT_TOOLING_HOME || join(homedir(), ".agent-tooling");
const AUTH_PATH = join(CODEX_HOME, "auth.json");
const CODEX_CONFIG_PATH = join(CODEX_HOME, "config.toml");
const AGENT_CONFIG_PATH = process.env.AGENT_TOOLING_CONFIG || join(AGENT_TOOLING_HOME, "config.jsonc");
const DEBUG_PATH = join(AGENT_TOOLING_HOME, "logs", "provider-usage-debug.log");
const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_USAGE_DAYS = 30;
const MAX_USAGE_DAYS = 90;

const mode = process.argv[2] || "hook";

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
  if (mode === "hook" || mode === "stop") hookOut();
  else if (mode !== "refresh") textOut(`${message}${detail}`);
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
  return clean === "https://api.openai.com" || clean === "https://api.openai.com/v1";
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

function apiKeyFor(auth, provider) {
  if (process.env.PROVIDER_USAGE_API_KEY) return process.env.PROVIDER_USAGE_API_KEY;
  if (process.env.SUB2API_API_KEY) return process.env.SUB2API_API_KEY;
  if (provider.env_key && process.env[provider.env_key]) return process.env[provider.env_key];
  if (auth.OPENAI_API_KEY) return auth.OPENAI_API_KEY;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  return "";
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

function formatQuota(label, data) {
  const root = usageRoot(data);
  const unit = root?.unit || "USD";
  const remaining = pickNumber(root, ["remaining"]);
  const hardLimit = pickNumber(root, ["hard_limit_usd", "hard_limit", "total_granted", "quota"]);
  const used = pickNumber(root, ["total_usage", "used", "usage"]);
  const balance = pickNumber(root, ["balance", "remaining", "remain", "available"]);

  if (isQuotaLimitedUsage(root)) return formatQuotaLimitedLine(label, root);
  if (isSubscriptionUsage(root)) return formatUsageLine(label, root);
  if (isWalletUsage(root)) return formatWalletLine(label, root);
  if (remaining !== undefined) return formatUsageLine(label, root);
  if (balance !== undefined) return `${label} quota ${formatMoney(balance)} left`;
  if (hardLimit !== undefined && used !== undefined) {
    return `${label} quota ${formatMoney(Math.max(0, hardLimit - used))} left`;
  }
  if (hardLimit !== undefined) return `${label} quota ${formatMoney(hardLimit)} total`;

  const keys = Object.keys(root || {}).slice(0, 4).join(", ");
  return keys ? `${label} quota received (${keys})` : `${label} quota checked (${unit})`;
}

function formatQuotaLimitedLine(label, root) {
  const quota = root?.quota || {};
  const limit = pickNumber(quota, ["limit", "quota"]);
  const used = pickNumber(quota, ["used", "quota_used"]);
  const remaining = pickNumber(quota, ["remaining"]) ?? pickNumber(root, ["remaining"]);
  const parts = [`[额度] ${label} key`];

  if (limit !== undefined && used !== undefined) {
    parts.push(`Q ${formatMoney(used)}/${formatMoney(limit)}`);
  } else if (remaining !== undefined) {
    parts.push(`剩余 ${formatMoney(remaining)}`);
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
  const title = root?.planName || label || "API";
  const balance = pickNumber(root, ["balance", "remaining", "remain", "available"]);
  const todayCost = pickNumber(root?.usage?.today, ["actual_cost", "cost"]);
  const recentUsage = Array.isArray(root?.daily_usage)
    ? root.daily_usage.reduce((sum, day) => sum + (pickNumber(day, ["actual_cost", "cost"]) || 0), 0)
    : undefined;

  const parts = [`[额度] ${title}`];
  if (balance !== undefined) parts.push(`余额 ${formatMoney(balance)}`);
  if (todayCost !== undefined) parts.push(`今日 ${formatMoney(todayCost)}`);
  if (recentUsage !== undefined && root.daily_usage.length > 0) {
    parts.push(`近${await providerUsageDays()}天 ${formatMoney(recentUsage)}`);
  }
  return parts.join(" | ");
}

function formatUsageLine(label, root) {
  const plan = root?.planName || "";
  const sub = root?.subscription || {};
  const dailyLimit = pickNumber(sub, ["daily_limit_usd"]);
  const dailyUsage = pickNumber(sub, ["daily_usage_usd"]);
  const weeklyLimit = pickNumber(sub, ["weekly_limit_usd"]);
  const weeklyUsage = pickNumber(sub, ["weekly_usage_usd"]);
  const monthlyLimit = pickNumber(sub, ["monthly_limit_usd"]);
  const monthlyUsage = pickNumber(sub, ["monthly_usage_usd"]);
  const expires = shortDate(sub.expires_at);

  const title = plan || label || "API";
  const parts = [`[额度] ${title}`];
  if (dailyLimit > 0 && dailyUsage !== undefined) parts.push(`D ${formatMoney(dailyUsage)}/${formatMoney(dailyLimit)}`);
  if (weeklyLimit > 0 && weeklyUsage !== undefined) parts.push(`W ${formatMoney(weeklyUsage)}/${formatMoney(weeklyLimit)}`);
  if (monthlyLimit > 0 && monthlyUsage !== undefined) parts.push(`M ${formatMoney(monthlyUsage)}/${formatMoney(monthlyLimit)}`);
  if (expires) parts.push(`Exp ${expires}`);
  return parts.join(" | ");
}

async function warningForUsage(text, raw) {
  const config = await agentConfig();
  const root = usageRoot(raw);
  const remaining = pickNumber(root, ["remaining"]);
  const quotaRemaining = pickNumber(root?.quota, ["remaining"]);
  const balance = pickNumber(root, ["balance", "remaining", "remain", "available"]);
  const sub = root?.subscription || {};
  const dailyLimit = pickNumber(sub, ["daily_limit_usd"]);
  const dailyUsage = pickNumber(sub, ["daily_usage_usd"]);
  const weeklyLimit = pickNumber(sub, ["weekly_limit_usd"]);
  const weeklyUsage = pickNumber(sub, ["weekly_usage_usd"]);
  const monthlyLimit = pickNumber(sub, ["monthly_limit_usd"]);
  const monthlyUsage = pickNumber(sub, ["monthly_usage_usd"]);
  const lowBalanceUsd = Number(process.env.PROVIDER_USAGE_LOW_BALANCE_USD || config.lowBalanceUsd || "10");

  if (isQuotaLimitedUsage(root) && quotaRemaining !== undefined && quotaRemaining <= lowBalanceUsd) {
    return `API key quota low: ${text}`;
  }
  if (isWalletUsage(root) && balance !== undefined && balance <= lowBalanceUsd) {
    return `API wallet balance low: ${text}`;
  }
  if (isSubscriptionUsage(root) && remaining !== undefined && remaining >= 0 && remaining <= lowBalanceUsd) {
    return `API quota low: ${text}`;
  }
  if (dailyLimit > 0 && dailyUsage / dailyLimit >= 0.9) return `API daily quota high: ${text}`;
  if (weeklyLimit > 0 && weeklyUsage / weeklyLimit >= 0.9) return `API weekly quota high: ${text}`;
  if (monthlyLimit > 0 && monthlyUsage / monthlyLimit >= 0.9) return `API monthly quota high: ${text}`;
  return "";
}

async function refresh() {
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

  await debugLog({
    mode,
    providerName,
    baseUrl,
    providerEnvKey: provider.env_key || "",
    hasProviderUsageKey: Boolean(process.env.PROVIDER_USAGE_API_KEY),
    hasSub2apiKey: Boolean(process.env.SUB2API_API_KEY),
    hasProviderEnvKey: Boolean(provider.env_key && process.env[provider.env_key]),
    hasAuthOpenaiKey: Boolean(auth.OPENAI_API_KEY),
    hasEnvOpenaiKey: Boolean(process.env.OPENAI_API_KEY),
  });

  if (!key || isOfficialBaseUrl(baseUrl)) {
    return { skipped: true, text: "" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(await subscriptionUrl(baseUrl), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
    });

    const body = await response.text();
    let json = {};
    try {
      json = body ? JSON.parse(body) : {};
    } catch {
      throw new Error(`usage endpoint returned non-JSON (${response.status})`);
    }

    if (!response.ok) {
      const message = json?.error?.message || json?.message || response.statusText;
      throw new Error(`usage endpoint failed (${response.status} ${message})`);
    }

    const label = providerLabel(providerName, provider);
    const text = await formatQuota(label, json);
    return {
      updatedAt: new Date().toISOString(),
      baseUrl,
      provider: providerName,
      text,
      raw: json,
    };
  } finally {
    clearTimeout(timeout);
  }
}

try {
  if (mode === "refresh") {
    await refresh();
  } else if (mode === "print" || mode === "print-or-refresh") {
    const result = await refresh();
    textOut(result?.text || "");
  } else if (mode === "hook") {
    const result = await refresh();
    hookOut(result?.text || "");
  } else if (mode === "stop") {
    const result = await refresh();
    const warning = result?.text ? await warningForUsage(result.text, result.raw) : "";
    hookOut(warning);
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} catch (error) {
  failSoft("Provider usage unavailable", error);
}
