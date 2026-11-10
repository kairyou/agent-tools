import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR } from "./config.mjs";

function displayPath(cwd) {
  const key = createHash("sha256").update(cwd).digest("hex");
  return join(CACHE_DIR, `opencode-display-${key}.json`);
}

// This is the last completed session's display for this project, not account quota.
export function rememberOpenCodeDisplay(cwd, text) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const path = displayPath(cwd);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ text }));
    renameSync(temp, path);
  } catch { /* The toast remains usable when the display cache cannot be written. */ }
}

export function readOpenCodeDisplay(cwd) {
  try { return JSON.parse(readFileSync(displayPath(cwd), "utf8")).text || ""; }
  catch { return null; }
}
