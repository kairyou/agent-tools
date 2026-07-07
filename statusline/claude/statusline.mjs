#!/usr/bin/env node
// Claude Code statusLine script (agent-tooling).
// Reads session JSON from stdin and prints one compact status line.
//
// Default:
//   ⎇ main | Opus 4.8 | 5h 7% ⟳2h54m | w 41% ⟳3d1h
//
// Customize with either:
//   node statusline.mjs --fields branch,model,fiveHour,week
//   AGENT_TOOLING_STATUSLINE_FIELDS=branch,model,context
//   ~/.agent-tooling/config.jsonc

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_FILE = join(SCRIPT_DIR, "..", "..", "config.jsonc");

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
    const raw = stripJsonComments(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function stripJsonComments(input) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
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
      while (i < input.length && input[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
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
  const rootConfig = readJsonFile(process.env.AGENT_TOOLING_CONFIG || DEFAULT_CONFIG_FILE);
  const fileConfig = rootConfig.statusline || {};
  const envFields = process.env.AGENT_TOOLING_STATUSLINE_FIELDS;
  const envSeparator = process.env.AGENT_TOOLING_STATUSLINE_SEPARATOR;

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
    return config.symbols.empty;
  }
  const pct = `${Math.round(window.used_percentage)}%`;
  const left = compactDuration(secondsUntil(window.resets_at));
  return left ? `${pct} ${config.symbols.reset}${left}` : pct;
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
    case "fiveHour":
      return `${config.symbols.fiveHour} ${usageWindow(data?.rate_limits?.five_hour, config)}`;
    case "week":
      return `${config.symbols.week} ${usageWindow(data?.rate_limits?.seven_day, config)}`;
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

function render(data, config) {
  return config.fields
    .map((field) => renderField(field, data, config))
    .filter(Boolean)
    .join(config.separator);
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
