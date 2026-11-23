#!/usr/bin/env node
// Agent usage runtime (agent-tools).
// Reads the active provider, probes known gateway usage endpoints, and prints a
// compact balance/quota message. Fails open when provider usage cannot be fetched.
//
// Entry shell: argument parsing, output modes, and the query orchestration.
// Everything else lives in ./lib (config, urls, http, cache, format, context,
// routes) and is bundled into dist/usage/core.mjs at build time.

import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  agentConfig,
  HOOK_SNAPSHOT_MAX_AGE_MS,
  REFRESH_INTERVAL_MS,
} from "./lib/config.mjs";
import { canRefreshUsage } from "./lib/cache.mjs";
import { usageContext } from "./lib/context.mjs";
import { cachedUsage, queryUsageContext } from "./lib/query.mjs";
import { agentOutputSpeed, withOutputSpeed } from "./lib/output-speed.mjs";

export { queryCachedProviderUsage, queryProviderUsage } from "./lib/query.mjs";

function parseArgs(argv) {
  const opts = { mode: "hook", agent: "codex", silent: false };
  let modeSet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--agent" && argv[i + 1]) {
      opts.agent = argv[++i];
    } else if (arg.startsWith("--agent=")) {
      opts.agent = arg.slice("--agent=".length);
    } else if (arg === "--silent") {
      opts.silent = true;
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

async function refresh(agent = "codex") {
  const context = await usageContext(agent);
  return await queryUsageContext(context, { agent, mode, rememberSnapshot: true, force: false });
}

export async function queryAgentProviderUsage(agent = "codex", { maxAgeMs = 0, ...session } = {}) {
  const speed = (await agentConfig()).outputSpeed === true ? agentOutputSpeed(agent, session) : "";
  try {
    const context = await usageContext(agent);
    if (maxAgeMs > 0) {
      const cached = await cachedUsage(context);
      if (cached && cached.ageMs < maxAgeMs) return { ...cached, text: withOutputSpeed(cached.text, speed), cached: true };
    }
    const result = await queryUsageContext(context, { agent, mode, rememberSnapshot: true, reuseSnapshot: true });
    return { ...result, text: withOutputSpeed(result.text, speed) };
  } catch (error) {
    if (speed) return { text: speed };
    throw error;
  }
}

function scheduleRefresh(agent) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "refresh", "--agent", agent], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

async function hook(agent, { silent = false } = {}) {
  let speed = "";
  if ((await agentConfig()).outputSpeed === true && !silent) {
    let input = {};
    try {
      let raw = "";
      for await (const chunk of process.stdin) raw += chunk;
      input = JSON.parse(raw || "{}") || {};
    } catch { /* Missing hook context simply hides speed. */ }
    speed = agentOutputSpeed(agent, {
      transcriptPath: input.transcript_path, cwd: input.cwd,
      sessionId: input.session_id || input.sessionId,
      turnId: input.turn_id || input.turnId,
    });
  }
  let context;
  try { context = await usageContext(agent); }
  catch (error) {
    if (speed) return hookOut(speed);
    throw error;
  }
  const cached = await cachedUsage(context);
  if (
    (!cached || cached.ageMs >= REFRESH_INTERVAL_MS) &&
    (await canRefreshUsage(context, REFRESH_INTERVAL_MS))
  ) {
    scheduleRefresh(agent);
  }
  hookOut(silent ? "" : withOutputSpeed(cached && cached.ageMs < HOOK_SNAPSHOT_MAX_AGE_MS ? cached.text : "", speed));
}

async function main() {
  try {
    if (mode === "refresh") {
      await refresh(cli.agent);
    } else if (mode === "print") {
      // Explicit request: query directly instead of going through the
      // background refresh throttle, which would print nothing.
      const result = await queryAgentProviderUsage(cli.agent);
      textOut(result?.text || "");
    } else if (mode === "hook") {
      await hook(cli.agent, { silent: cli.silent });
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
