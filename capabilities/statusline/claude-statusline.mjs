#!/usr/bin/env node
// Claude Code statusLine script (agent-tools).
// Reads session JSON from stdin and prints one compact status line.
//
// Default:
//   ⎇ main | Opus 4.8 | 5h 7% ⟳2h54m | w 41% ⟳3d1h
//
// Customize with either:
//   node statusline.mjs --fields branch,model,fiveHour,week
//   AGENT_TOOLS_STATUSLINE_FIELDS=branch,model,context
//   ~/.agent-tools/config.jsonc

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_TOOLS_HOME = process.env.AGENT_TOOLS_HOME || join(SCRIPT_DIR, "..", "..");
const DEFAULT_CONFIG_FILE = join(AGENT_TOOLS_HOME, "config.jsonc");
const SNAPSHOT_FILE = join(AGENT_TOOLS_HOME, "cache", "usage-snapshot.json");
const REFRESH_STATE_FILE = join(AGENT_TOOLS_HOME, "cache", "usage-refresh-state.json");
// Cross-integration dependency: statusline renders provider usage via the
// usage integration's query engine (built artifact; see scripts/build.mjs).
const USAGE_RUNTIME = join(AGENT_TOOLS_HOME, "dist", "usage", "core.mjs");
const DEFAULT_SNAPSHOT_TTL_MS = 60_000;
const DEFAULT_REFRESH_COOLDOWN_MS = 30_000;
const DEFAULT_FAILURE_BACKOFF_MS = 120_000;

const DEFAULT_CONFIG = {
  fields: ["branch", "model", "fiveHour", "week"],
  separator: " | ",
  symbols: {
    branch: "⎇",
    reset: "⟳",
    empty: "–",
    fiveHour: "5h",
    week: "w",
    context: "ctx",
  },
};

const FIELD_ALIASES = {
  cwd: "directory",
  dir: "directory",
  five: "fiveHour",
  five_hour: "fiveHour",
  "5h": "fiveHour",
  sevenDay: "week",
  seven_day: "week",
  "7d": "week",
  weekly: "week",
  ctx: "context",
};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function readJsonFile(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    if (!raw.trim()) return {};
    const errors = [];
    const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });
    return errors.length === 0 && parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fields" && argv[i + 1]) {
      opts.fields = argv[++i];
    } else if (arg.startsWith("--fields=")) {
      opts.fields = arg.slice("--fields=".length);
    } else if (arg === "--separator" && argv[i + 1]) {
      opts.separator = argv[++i];
    } else if (arg.startsWith("--separator=")) {
      opts.separator = arg.slice("--separator=".length);
    }
  }
  return opts;
}

function splitFields(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeField(field) {
  return FIELD_ALIASES[field] || field;
}

function mergeConfig(cli) {
  const rootConfig = readJsonFile(DEFAULT_CONFIG_FILE);
  const fileConfig = rootConfig.statusline || {};
  const envFields = process.env.AGENT_TOOLS_STATUSLINE_FIELDS;
  const envSeparator = process.env.AGENT_TOOLS_STATUSLINE_SEPARATOR;

  const config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    symbols: { ...DEFAULT_CONFIG.symbols, ...(fileConfig.symbols || {}) },
  };

  const fields =
    splitFields(cli.fields) ||
    splitFields(envFields) ||
    splitFields(fileConfig.fields) ||
    DEFAULT_CONFIG.fields;

  config.fields = fields.map(normalizeField);
  if (typeof envSeparator === "string") config.separator = envSeparator;
  if (typeof cli.separator === "string") config.separator = cli.separator;
  return config;
}

function gitBranch(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return out && out !== "HEAD" ? out : "";
  } catch {
    return "";
  }
}

function secondsUntil(unixSeconds) {
  if (!unixSeconds) return null;
  const seconds = Number(unixSeconds) - Math.floor(Date.now() / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
}

function compactDuration(totalSeconds) {
  if (totalSeconds == null) return "";
  if (totalSeconds <= 0) return "0m";
  let seconds = totalSeconds;
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  if (days) return `${days}d${hours}h`;
  if (hours) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function usageWindow(window, config) {
  if (!window || typeof window.used_percentage !== "number") {
    return "";
  }
  const pct = `${Math.round(window.used_percentage)}%`;
  const left = compactDuration(secondsUntil(window.resets_at));
  return left ? `${pct} ${config.symbols.reset}${left}` : pct;
}

function showMissingUsageWindow() {
  const baseUrl = activeRelayBaseUrl();
  return !baseUrl || isOfficialBaseUrl(baseUrl);
}

function shortModelName(name) {
  if (!name) return "";
  return String(name)
    .replace(/^Claude\s+/i, "")
    .replace(/\s*\[1m\]\s*$/i, "")
    .trim();
}

function renderField(field, data, config) {
  const dir = data?.workspace?.current_dir || data?.cwd || process.cwd() || "";
  const projectDir = data?.workspace?.project_dir || dir;
  switch (field) {
    case "branch": {
      const branch = gitBranch(projectDir);
      return branch ? `${config.symbols.branch} ${branch}` : "";
    }
    case "model":
      return shortModelName(data?.model?.display_name || data?.model?.id || "");
    case "fiveHour": {
      const value = usageWindow(data?.rate_limits?.five_hour, config);
      return value || showMissingUsageWindow()
        ? `${config.symbols.fiveHour} ${value || config.symbols.empty}`
        : "";
    }
    case "week": {
      const value = usageWindow(data?.rate_limits?.seven_day, config);
      return value || showMissingUsageWindow()
        ? `${config.symbols.week} ${value || config.symbols.empty}`
        : "";
    }
    case "context": {
      const pct = data?.context_window?.used_percentage;
      return typeof pct === "number" ? `${config.symbols.context} ${Math.round(pct)}%` : "";
    }
    case "directory":
      return dir ? basename(dir) : "";
    default:
      return "";
  }
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function cleanBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function isOfficialBaseUrl(baseUrl) {
  if (!baseUrl) return true;
  const clean = cleanBaseUrl(baseUrl);
  return [
    "https://api.anthropic.com",
    "https://api.anthropic.com/v1",
    "https://api.openai.com",
    "https://api.openai.com/v1",
  ].includes(clean);
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
    return cleanBaseUrl(baseUrl).endsWith("/v1") ? cleanBaseUrl(baseUrl).slice(0, -3) : cleanBaseUrl(baseUrl);
  }
}

function readJsonFileRaw(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function activeRelayBaseUrl() {
  return process.env.PROVIDER_USAGE_BASE_URL || process.env.ANTHROPIC_BASE_URL || "";
}

function hasClaudeUsageToken() {
  return Boolean(
    process.env.PROVIDER_USAGE_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.ANTHROPIC_API_KEY
  );
}

function snapshotForBaseUrl(baseUrl) {
  const snapshot = readJsonFileRaw(SNAPSHOT_FILE);
  const key = usageRouteCacheKey(baseUrl);
  const item = snapshot?.items?.[key];
  return item?.text ? item : null;
}

function refreshStateForBaseUrl(baseUrl) {
  const state = readJsonFileRaw(REFRESH_STATE_FILE);
  return state?.items?.[usageRouteCacheKey(baseUrl)] || {};
}

function ageMs(isoDate) {
  const time = Date.parse(isoDate || "");
  return Number.isFinite(time) ? Date.now() - time : Number.POSITIVE_INFINITY;
}

function writeRefreshAttempt(baseUrl) {
  try {
    const state = readJsonFileRaw(REFRESH_STATE_FILE);
    const key = usageRouteCacheKey(baseUrl);
    state.version = 1;
    state.items = state.items && typeof state.items === "object" ? state.items : {};
    state.items[key] = {
      ...(state.items[key] || {}),
      baseUrl,
      lastAttemptAt: new Date().toISOString(),
    };
    fs.mkdirSync(dirname(REFRESH_STATE_FILE), { recursive: true });
    fs.writeFileSync(REFRESH_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // Statusline must stay non-blocking and fail-open.
  }
}

function shouldRefreshUsage(baseUrl, snapshot) {
  if (process.env.AGENT_TOOLS_USAGE_REFRESH === "0") return false;
  if (!baseUrl || isOfficialBaseUrl(baseUrl)) return false;
  if (!hasClaudeUsageToken()) return false;
  if (!fs.existsSync(USAGE_RUNTIME)) return false;

  const ttlMs = numberFromEnv("AGENT_TOOLS_USAGE_SNAPSHOT_TTL_MS", DEFAULT_SNAPSHOT_TTL_MS);
  const cooldownMs = numberFromEnv("AGENT_TOOLS_USAGE_REFRESH_COOLDOWN_MS", DEFAULT_REFRESH_COOLDOWN_MS);
  const failureBackoffMs = numberFromEnv("AGENT_TOOLS_USAGE_FAILURE_BACKOFF_MS", DEFAULT_FAILURE_BACKOFF_MS);
  const state = refreshStateForBaseUrl(baseUrl);

  if (ageMs(state.lastAttemptAt) < cooldownMs) return false;
  if (state.lastError && ageMs(state.lastFailureAt) < failureBackoffMs) return false;
  return !snapshot || ageMs(snapshot.updatedAt) >= ttlMs;
}

function refreshUsageInBackground(baseUrl) {
  if (!shouldRefreshUsage(baseUrl, snapshotForBaseUrl(baseUrl))) return;
  writeRefreshAttempt(baseUrl);
  try {
    const child = spawn(process.execPath, [USAGE_RUNTIME, "refresh", "--agent", "claude"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Statusline must never surface provider usage refresh errors.
  }
}

function providerUsageStatus() {
  const baseUrl = activeRelayBaseUrl();
  if (!baseUrl || isOfficialBaseUrl(baseUrl)) return "";
  const snapshot = snapshotForBaseUrl(baseUrl);
  if (shouldRefreshUsage(baseUrl, snapshot)) refreshUsageInBackground(baseUrl);
  return snapshot?.text || "";
}

function render(data, config) {
  const fields = config.fields
    .map((field) => renderField(field, data, config))
    .filter(Boolean);
  const providerUsage = providerUsageStatus();
  if (providerUsage) fields.push(providerUsage);
  return fields.join(config.separator);
}

async function main() {
  const config = mergeConfig(parseArgs(process.argv.slice(2)));
  let data = {};
  try {
    const raw = await readStdin();
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  process.stdout.write(render(data, config));
}

main();
