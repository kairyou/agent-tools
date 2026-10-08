import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchOfficialSnapshot } from "./official.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const UPSTREAM_DIR = path.join(ROOT, "tools", "claude-skill-sync", "upstream");
export const CURRENT_FILE = path.join(UPSTREAM_DIR, "current.json");
export const PENDING_FILE = path.join(UPSTREAM_DIR, "pending.json");
export const REPORT_FILE = path.join(UPSTREAM_DIR, "pending-report.md");
export const TEXT_NAMES = ["review", "output", "fixes", "simplify"];
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const fetchUpstream = fetchOfficialSnapshot;

export async function discoverLatestVersion() {
  const response = await fetch("https://registry.npmjs.org/@anthropic-ai/claude-code/latest");
  if (!response.ok) throw new Error(`Official npm discovery failed: ${response.status}`);
  const metadata = await response.json();
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version || "")) throw new Error("npm returned an invalid Claude Code version");
  return metadata.version;
}

export function compareSnapshots(current, pending) {
  return TEXT_NAMES.filter((name) => current?.texts?.[name]?.text !== pending.texts[name].text)
    .map((name) => ({ name, status: current?.texts?.[name] ? "changed" : "added",
      use: name === "simplify" ? "at-simplify" : "at-review" }));
}

export function renderReport(current, pending) {
  const changes = compareSnapshots(current, pending);
  return [
    "# Pending Claude skill upstream", "",
    `- Accepted Claude Code version: ${current?.claudeCodeVersion || "none"}`,
    `- Pending Claude Code version: ${pending.claudeCodeVersion}`,
    `- Official source: ${pending.source.package}@${pending.source.version}`,
    `- Package integrity: ${pending.source.integrity}`,
    `- Bundle SHA-256: ${pending.source.bundleSha256}`,
    `- Selection: ${JSON.stringify(pending.selection)}`, "",
    "## Selected content changes", "",
    ...(changes.length ? changes.map(({ name, status, use }) => `- ${name} (${status}) — ${use}`) : ["No selected content changed."]),
    "", "## Review", "",
    "Inspect the generated skill diff with `npm run claude-skills:apply -- --dry-run` before accepting it.", "",
  ].join("\n");
}

export function writePending(snapshot, directory = UPSTREAM_DIR) {
  fs.mkdirSync(directory, { recursive: true });
  const currentFile = path.join(directory, "current.json");
  const pendingFile = path.join(directory, "pending.json");
  const reportFile = path.join(directory, "pending-report.md");
  const current = fs.existsSync(currentFile) ? readJson(currentFile) : null;
  const changes = compareSnapshots(current, snapshot);
  if (current && !changes.length) {
    fs.rmSync(pendingFile, { force: true });
    fs.rmSync(reportFile, { force: true });
    return { changes, wrote: false };
  }
  fs.writeFileSync(pendingFile, stableJson(snapshot));
  fs.writeFileSync(reportFile, renderReport(current, snapshot));
  return { changes, wrote: true };
}
