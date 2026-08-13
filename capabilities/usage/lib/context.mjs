// Discovers the active relay endpoint and credentials for each agent.

import { existsSync } from "node:fs";
import {
  AUTH_PATH,
  CODEX_CONFIG_PATH,
  readJson,
  readTextIfExists,
} from "./config.mjs";

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

export async function usageContext(agent) {
  return agent === "claude" ? contextForClaude() : await contextForCodex();
}

export function normalizeUsageContext(input) {
  const providerName = String(input?.providerName || "provider");
  const provider = input?.provider && typeof input.provider === "object"
    ? input.provider
    : { name: providerName };
  return {
    providerName,
    provider,
    baseUrl: String(input?.baseUrl || ""),
    key: String(input?.key || ""),
    label: String(input?.label || provider.name || providerName),
  };
}
