#!/usr/bin/env node
// Codex usage hook wrapper.
// Keeps hook failures actionable: infrastructure errors are logged and the hook
// still exits 0 with a short message instead of surfacing only "exit code 1".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_TOOLS_HOME = process.env.AGENT_TOOLS_HOME || path.resolve(SCRIPT_DIR, "..", "..");
const USAGE_SCRIPT = path.join(AGENT_TOOLS_HOME, "lib", "usage.mjs");
const LOG_PATH = path.join(AGENT_TOOLS_HOME, "logs", "usage-hook.log");
const TIMEOUT_MS = Number(process.env.AGENT_TOOLS_USAGE_HOOK_TIMEOUT_MS || 4500);
const MAX_LOG_BYTES = Number(process.env.AGENT_TOOLS_USAGE_HOOK_LOG_BYTES || 256 * 1024);
const KEEP_LOG_BYTES = 128 * 1024;

function hookOut(message) {
  const payload = { continue: true };
  if (message) payload.systemMessage = message;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function preview(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function logFailure(event) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    rotateLogIfNeeded();
    fs.appendFileSync(
      LOG_PATH,
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`
    );
  } catch {
    // Nothing else to do; the wrapper must fail open.
  }
}

function rotateLogIfNeeded() {
  const maxBytes = Number.isFinite(MAX_LOG_BYTES) && MAX_LOG_BYTES > 0 ? MAX_LOG_BYTES : 256 * 1024;
  if (!fs.existsSync(LOG_PATH)) return;
  const stat = fs.statSync(LOG_PATH);
  if (stat.size <= maxBytes) return;
  const keepBytes = Math.min(KEEP_LOG_BYTES, Math.floor(maxBytes / 2));
  const fd = fs.openSync(LOG_PATH, "r");
  try {
    const buffer = Buffer.alloc(keepBytes);
    fs.readSync(fd, buffer, 0, keepBytes, Math.max(0, stat.size - keepBytes));
    fs.writeFileSync(
      LOG_PATH,
      `${JSON.stringify({ at: new Date().toISOString(), reason: "log rotated", previousBytes: stat.size })}\n` +
        buffer.toString("utf8").replace(/^[^\n]*\n?/, "")
    );
  } finally {
    fs.closeSync(fd);
  }
}

function failureMessage() {
  return `API usage hook failed; see ${LOG_PATH.replace(/\\/g, "/")}`;
}

function parseHookJson(stdout) {
  const text = stdout.trim();
  if (!text) return { continue: true };
  return JSON.parse(text);
}

async function runUsageScript() {
  if (!fs.existsSync(USAGE_SCRIPT)) {
    logFailure({ reason: "missing usage script", usageScript: USAGE_SCRIPT });
    hookOut(failureMessage());
    return;
  }

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [USAGE_SCRIPT, "hook", "--agent", "codex"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ status: null, signal: "timeout", stdout, stderr });
    }, Number.isFinite(TIMEOUT_MS) && TIMEOUT_MS > 0 ? TIMEOUT_MS : 4500);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status: null, error, stdout, stderr });
    });
    child.on("exit", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });

  if (result.status !== 0) {
    logFailure({
      reason: "usage script exited non-zero",
      status: result.status,
      signal: result.signal || "",
      error: result.error?.message || "",
      stdout: preview(result.stdout),
      stderr: preview(result.stderr),
      usageScript: USAGE_SCRIPT,
      node: process.version,
      platform: `${process.platform} ${os.release()}`,
    });
    hookOut(failureMessage());
    return;
  }

  try {
    const payload = parseHookJson(result.stdout);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch (error) {
    logFailure({
      reason: "usage script returned invalid hook JSON",
      error: error.message,
      stdout: preview(result.stdout),
      stderr: preview(result.stderr),
      usageScript: USAGE_SCRIPT,
    });
    hookOut(failureMessage());
  }
}

try {
  await runUsageScript();
} catch (error) {
  logFailure({
    reason: "wrapper exception",
    error: error?.stack || error?.message || String(error),
    usageScript: USAGE_SCRIPT,
  });
  hookOut(failureMessage());
}
