// Paths, constants, config.jsonc access, and debug logging shared by the
// usage runtime modules.

import { readFile, writeFile, mkdir, open, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseJsonc } from "jsonc-parser";

export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
export const AGENT_TOOLS_HOME = process.env.AGENT_TOOLS_HOME || join(homedir(), ".agent-tools");
export const AUTH_PATH = join(CODEX_HOME, "auth.json");
export const CODEX_CONFIG_PATH = join(CODEX_HOME, "config.toml");
export const AGENT_CONFIG_PATH = join(AGENT_TOOLS_HOME, "config.jsonc");
export const DEBUG_PATH = join(AGENT_TOOLS_HOME, "logs", "usage-debug.log");
export const ROUTE_CACHE_PATH = join(AGENT_TOOLS_HOME, "cache", "usage-routes.json");
export const SNAPSHOT_PATH = join(AGENT_TOOLS_HOME, "cache", "usage-snapshot.json");
export const REFRESH_STATE_PATH = join(AGENT_TOOLS_HOME, "cache", "usage-refresh-state.json");
export const DEFAULT_USAGE_DAYS = 30;
export const MAX_USAGE_DAYS = 90;
export const DEFAULT_NEW_API_QUOTA_SCALE = 500000;

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readTextIfExists(path) {
  if (!existsSync(path)) return "";
  return readFile(path, "utf8");
}

let agentConfigCache;
export async function agentConfig() {
  if (agentConfigCache) return agentConfigCache;
  try {
    const raw = await readTextIfExists(AGENT_CONFIG_PATH);
    if (!raw.trim()) {
      agentConfigCache = {};
      return agentConfigCache;
    }
    const errors = [];
    const parsed = parseJsonc(raw.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
    agentConfigCache = (errors.length === 0 && parsed?.providerUsage) || {};
  } catch {
    agentConfigCache = {};
  }
  return agentConfigCache;
}

const DEBUG_LOG_MAX_BYTES = 256 * 1024;
const DEBUG_LOG_KEEP_BYTES = 128 * 1024;

async function rotateDebugLogIfNeeded() {
  try {
    const { size } = await stat(DEBUG_PATH);
    if (size <= DEBUG_LOG_MAX_BYTES) return;
    const handle = await open(DEBUG_PATH, "r");
    try {
      const buffer = Buffer.alloc(DEBUG_LOG_KEEP_BYTES);
      await handle.read(buffer, 0, DEBUG_LOG_KEEP_BYTES, size - DEBUG_LOG_KEEP_BYTES);
      await writeFile(DEBUG_PATH, buffer.toString("utf8").replace(/^[^\n]*\n?/, ""));
    } finally {
      await handle.close();
    }
  } catch {
    // Rotation is best-effort; appending must not fail because of it.
  }
}

export async function debugLog(event) {
  const config = await agentConfig();
  if (process.env.PROVIDER_USAGE_DEBUG !== "1" && config.debug !== true) return;
  await mkdir(dirname(DEBUG_PATH), { recursive: true });
  await rotateDebugLogIfNeeded();
  const line = JSON.stringify({
    at: new Date().toISOString(),
    ...event,
  });
  await writeFile(DEBUG_PATH, `${line}\n`, { flag: "a" });
}

export async function providerUsageDays() {
  const config = await agentConfig();
  const value = Number(process.env.PROVIDER_USAGE_DAYS || config.days || DEFAULT_USAGE_DAYS);
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_USAGE_DAYS;
  return Math.min(value, MAX_USAGE_DAYS);
}

export async function usagePreset() {
  const config = await agentConfig();
  return String(process.env.PROVIDER_USAGE_PRESET || config.preset || "auto").toLowerCase();
}

// Passive callers (the codex hook fires per prompt; several sessions may run
// at once) reuse a fresh snapshot instead of hitting the gateway every time.
// Same knob the statusline uses; 0 disables.
export function snapshotTtlMs() {
  const raw = Number(process.env.AGENT_TOOLS_USAGE_SNAPSHOT_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
}

export async function newApiQuotaScale() {
  const config = await agentConfig();
  const scale = Number(config.newApiQuotaScale || DEFAULT_NEW_API_QUOTA_SCALE);
  return Number.isFinite(scale) && scale > 0 ? scale : 0;
}
