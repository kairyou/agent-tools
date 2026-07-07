#!/usr/bin/env node
// Claude Code statusLine script (agent-tooling).
// Reads the session JSON from stdin and prints a single compact status line.
// Docs: https://code.claude.com/docs/en/statusline
//
// Referenced from settings.json as:  { "statusLine": { "type": "command",
//   "command": "node <path-to-this-file>" } }
// Kept dependency-free so it runs the same on Windows / macOS / Linux.

import { execFileSync } from "node:child_process";
import { basename } from "node:path";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
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

function render(data) {
  const model = data?.model?.display_name || data?.model?.id || "claude";
  const dir = data?.workspace?.current_dir || data?.cwd || process.cwd() || "";
  const projectDir = data?.workspace?.project_dir || dir;
  const dirName = dir ? basename(dir) : "";
  const branch = gitBranch(projectDir);
  const pct = data?.context_window?.used_percentage;

  const parts = [`[${model}]`];
  if (dirName) parts.push(dirName);
  if (branch) parts.push(`(${branch})`);
  if (typeof pct === "number") parts.push(`ctx ${Math.round(pct)}%`);
  return parts.join(" ");
}

async function main() {
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    raw = "";
  }
  let data = {};
  if (raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = {};
    }
  }
  process.stdout.write(render(data));
}

main();
