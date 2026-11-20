// Discovers the active relay endpoint and credentials for each agent.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJson, readTextIfExists } from "./config.mjs";
import { readZcodeSessionProvider } from "./zcode-session.mjs";

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

function apiKeyFor(auth, provider, env) {
  if (env.PROVIDER_USAGE_API_KEY) return env.PROVIDER_USAGE_API_KEY;
  if (env.SUB2API_API_KEY) return env.SUB2API_API_KEY;
  if (provider.env_key && env[provider.env_key]) return env[provider.env_key];
  if (provider.experimental_bearer_token) return provider.experimental_bearer_token;
  if (auth.OPENAI_API_KEY) return auth.OPENAI_API_KEY;
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY;
  return "";
}

function apiKeyForClaude(env) {
  return (
    env.PROVIDER_USAGE_API_KEY ||
    env.ANTHROPIC_AUTH_TOKEN ||
    env.ANTHROPIC_API_KEY ||
    ""
  );
}

function providerLabel(providerName, provider) {
  return String(provider.name || providerName || "API").toUpperCase();
}

async function contextForCodex({ env = process.env } = {}) {
  const home = env.CODEX_HOME || join(homedir(), ".codex");
  const authFile = join(home, "auth.json");
  const auth = existsSync(authFile) ? await readJson(authFile) : {};
  const codexConfig = parseTomlLite(await readTextIfExists(join(home, "config.toml")));
  const { providerName, provider } = activeProvider(codexConfig);
  const baseUrl =
    env.PROVIDER_USAGE_BASE_URL ||
    env.SUB2API_BASE_URL ||
    env.OPENAI_BASE_URL ||
    provider.base_url ||
    "";
  const key = apiKeyFor(auth, provider, env);
  return {
    providerName,
    provider,
    baseUrl,
    key,
    label: providerLabel(providerName, provider),
  };
}

function contextForClaude({ env = process.env } = {}) {
  const baseUrl =
    env.PROVIDER_USAGE_BASE_URL ||
    env.ANTHROPIC_BASE_URL ||
    "";
  return {
    providerName: "claude",
    provider: { name: "Claude" },
    baseUrl,
    key: apiKeyForClaude(env),
    label: "Claude",
  };
}

export async function usageContext(agent, options) {
  if (agent === "claude") return contextForClaude(options);
  if (agent === "codex") return await contextForCodex(options);
  if (agent === "zcode") return await contextForZcode(options);
  throw new Error(`Provider context requires the ${agent} native adapter`);
}

async function contextForZcode({ providerId } = {}) {
  const file = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || join(homedir(), ".zcode", "v2", "provider_config.json");
  const stored = existsSync(file) ? await readJson(file) : {};
  const config = stored.schemaVersion === 1 ? stored.config : null;
  const rules = config?.providerConfigRules?.providerRules;
  const providers = Array.isArray(rules) ? rules : [];
  // Order describes the list, not which provider the session selected.
  const providerName = providerId || (config && readZcodeSessionProvider()) || config?.defaultModelSelection?.providerId ||
    (providers.length === 1 ? providers[0]?.providerId : null) || "zcode";
  const rule = providers.find((entry) => entry?.providerId === providerName);
  const provider = rule?.config || {};
  return normalizeUsageContext({
    providerName,
    label: rule?.providerName || providerName,
    baseUrl: process.env.PROVIDER_USAGE_BASE_URL || provider.api?.baseUrl || "",
    key: process.env.PROVIDER_USAGE_API_KEY || process.env.SUB2API_API_KEY ||
      (provider.access?.type === "api-key" ? provider.access.apiKey : ""),
  });
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
