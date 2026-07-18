// Vision configuration loader. The single source of truth is
// ~/.agent-tools/config.jsonc (override root with AGENT_TOOLS_HOME). No
// implicit environment fallback: `apiKey` is either a literal string or an
// explicit `{ "env": "VARIABLE_NAME" }` secret reference declared in the file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { ERROR_CODES, VisionError } from "./errors.mjs";

export const PROVIDERS = Object.freeze(["openai-compatible", "anthropic-compatible"]);

export const CONFIG_DEFAULTS = Object.freeze({
  timeoutMs: 30000,
  maxImageBytes: 20 * 1024 * 1024,
  maxConcurrentRequests: 2,
  maxRequestsPerMinute: 30,
  // Sent to both providers (Anthropic requires max_tokens; OpenAI gateway
  // defaults are unpredictable). Lower it if your model caps output smaller.
  maxOutputTokens: 8192,
});

const CONFIG_TEMPLATE = `{
  "vision": {
    "provider": "openai-compatible",        // or "anthropic-compatible"
    "baseUrl": "https://gateway.example.com/v1",
    "model": "internal-vlm",
    "apiKey": { "env": "OPENAI_API_KEY" }   // or a literal string
  }
}`;

export function agentToolsHome(env = process.env) {
  return env.AGENT_TOOLS_HOME || path.join(os.homedir(), ".agent-tools");
}

export function configPath(env = process.env) {
  return path.join(agentToolsHome(env), "config.jsonc");
}

function configError(message) {
  return new VisionError(
    ERROR_CODES.CONFIG,
    `${message}\nAdd a "vision" block to ${configPath()} , for example:\n${CONFIG_TEMPLATE}`
  );
}

// Resolve `apiKey` per the secret reference rules. Returns the secret string,
// or null when the gateway does not require a key (field omitted).
export function resolveSecret(apiKey, env = process.env) {
  if (apiKey === undefined || apiKey === null) return null;
  if (typeof apiKey === "string") {
    if (apiKey.trim() === "") {
      throw new VisionError(ERROR_CODES.CONFIG, "vision.apiKey is an empty string; remove it or set a value.");
    }
    return apiKey;
  }
  if (typeof apiKey === "object" && typeof apiKey.env === "string" && apiKey.env.trim() !== "") {
    const name = apiKey.env;
    const value = env[name];
    if (value === undefined || value === "") {
      // Name the variable, never its (missing) value; no silent fallback.
      throw new VisionError(
        ERROR_CODES.CONFIG,
        `vision.apiKey references environment variable "${name}", which is not set or empty.`
      );
    }
    return value;
  }
  throw new VisionError(
    ERROR_CODES.CONFIG,
    'vision.apiKey must be a string or { "env": "VARIABLE_NAME" }.'
  );
}

function positiveInt(raw, name, fallback, { allowZero = false } = {}) {
  if (raw === undefined || raw === null) return fallback;
  if (!Number.isInteger(raw) || raw < 0 || (!allowZero && raw === 0)) {
    throw new VisionError(
      ERROR_CODES.CONFIG,
      `vision.${name} must be a positive integer${allowZero ? " (0 disables it)" : ""}.`
    );
  }
  return raw;
}

function normalizeBaseUrl(raw) {
  if (typeof raw !== "string") throw configError("vision.baseUrl must be an http(s) URL.");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw configError("vision.baseUrl must be an http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw configError("vision.baseUrl must be an http(s) URL.");
  }
  if (parsed.username || parsed.password) {
    throw configError("vision.baseUrl must not contain credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw configError("vision.baseUrl must not contain a query string or fragment.");
  }
  return parsed.toString().replace(/\/+$/, "");
}

// Load and validate the vision config. `file`/`env` are injectable for tests.
export function loadVisionConfig({ file, env = process.env } = {}) {
  const target = file || configPath(env);
  if (!fs.existsSync(target)) {
    throw configError(`Config file not found: ${target}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(target, "utf8").replace(/^﻿/, "");
  } catch (err) {
    throw configError(`Cannot read ${target}: ${err.message}`);
  }
  const errors = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !parsed || typeof parsed !== "object") {
    throw configError(`Cannot parse ${target} as JSONC.`);
  }
  const vision = parsed.vision;
  if (!vision || typeof vision !== "object") {
    throw configError(`Missing "vision" section in ${target}.`);
  }
  if (!PROVIDERS.includes(vision.provider)) {
    throw configError(
      `vision.provider must be one of: ${PROVIDERS.join(", ")} (got ${JSON.stringify(vision.provider ?? null)}).`
    );
  }
  const baseUrl = normalizeBaseUrl(vision.baseUrl);
  if (typeof vision.model !== "string" || vision.model.trim() === "") {
    throw configError("vision.model must be a non-empty string.");
  }

  return {
    provider: vision.provider,
    baseUrl,
    model: vision.model,
    apiKey: resolveSecret(vision.apiKey, env),
    timeoutMs: positiveInt(vision.timeoutMs, "timeoutMs", CONFIG_DEFAULTS.timeoutMs),
    maxImageBytes: positiveInt(vision.maxImageBytes, "maxImageBytes", CONFIG_DEFAULTS.maxImageBytes),
    maxConcurrentRequests: positiveInt(
      vision.maxConcurrentRequests,
      "maxConcurrentRequests",
      CONFIG_DEFAULTS.maxConcurrentRequests
    ),
    // 0 disables the rolling-window limit; concurrency has no disable switch.
    maxRequestsPerMinute: positiveInt(
      vision.maxRequestsPerMinute,
      "maxRequestsPerMinute",
      CONFIG_DEFAULTS.maxRequestsPerMinute,
      { allowZero: true }
    ),
    maxOutputTokens: positiveInt(vision.maxOutputTokens, "maxOutputTokens", CONFIG_DEFAULTS.maxOutputTokens),
  };
}
