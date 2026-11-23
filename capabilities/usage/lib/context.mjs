// Discovers the active relay endpoint and credentials for each agent.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { readJson, readTextIfExists } from "./config.mjs";
import { readZcodeSessionProvider } from "./zcode-session.mjs";

function parseCodexConfig(source) {
  try {
    return getStaticTOMLValue(parseTOML(source.replace(/^\uFEFF/, "")));
  } catch {
    return {};
  }
}

function activeProvider(config) {
  const providerName = config.model_provider || "openai";
  const providers = config.model_providers ?? {};
  const provider = Object.hasOwn(providers, providerName) ? providers[providerName] : {};
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

async function contextForCodex({ env = process.env, providerId } = {}) {
  const home = env.CODEX_HOME || join(homedir(), ".codex");
  const authFile = join(home, "auth.json");
  const auth = existsSync(authFile) ? await readJson(authFile) : {};
  const codexConfig = parseCodexConfig(await readTextIfExists(join(home, "config.toml")));
  if (providerId) {
    const providers = codexConfig.model_providers ?? {};
    const provider = Object.hasOwn(providers, providerId) ? providers[providerId] : {};
    const builtIn = providerId === "openai" && !Object.hasOwn(providers, providerId);
    // Explicit usage overrides follow the default provider. Other sessions keep their own credentials.
    const overrides = providerId === (codexConfig.model_provider || "openai") ? env : {};
    return {
      providerName: providerId, provider, label: providerLabel(providerId, provider),
      baseUrl: overrides.PROVIDER_USAGE_BASE_URL || overrides.SUB2API_BASE_URL ||
        (builtIn ? env.OPENAI_BASE_URL : provider.base_url) || "",
      key: overrides.PROVIDER_USAGE_API_KEY || overrides.SUB2API_API_KEY ||
        (builtIn ? auth.OPENAI_API_KEY || env.OPENAI_API_KEY :
          (provider.env_key && env[provider.env_key]) || provider.experimental_bearer_token) || "",
    };
  }
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
