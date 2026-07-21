#!/usr/bin/env node
// Agent usage runtime (agent-tools).
// Reads the active provider, probes known gateway usage endpoints, and prints a
// compact balance/quota message. Fails open when provider usage cannot be fetched.
//
// Entry shell: argument parsing, output modes, and the query orchestration.
// Everything else lives in ./lib (config, urls, http, cache, format, context,
// routes) and is bundled into dist/usage/core.mjs at build time.

import { pathToFileURL } from "node:url";
import { debugLog, usagePreset } from "./lib/config.mjs";
import { isOfficialBaseUrl } from "./lib/urls.mjs";
import {
  rememberUsageRoute,
  rememberUsageSnapshot,
  rememberRefreshState,
} from "./lib/cache.mjs";
import { orderedUsageRoutes } from "./lib/routes.mjs";
import { usageContext, normalizeUsageContext } from "./lib/context.mjs";

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

async function queryUsageContext(context, { agent = "external", rememberSnapshot = false } = {}) {
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

async function refresh(agent = "codex") {
  return await queryAgentProviderUsage(agent);
}

export async function queryAgentProviderUsage(agent = "codex") {
  return await queryUsageContext(await usageContext(agent), {
    agent,
    rememberSnapshot: agent === "claude",
  });
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
