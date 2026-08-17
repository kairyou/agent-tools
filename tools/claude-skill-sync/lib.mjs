import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_PROMPT_IDS, SKILLS, UPSTREAM_REPOSITORY } from "./manifest.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TOOL_DIR = path.join(ROOT, "tools", "claude-skill-sync");
export const UPSTREAM_DIR = path.join(TOOL_DIR, "upstream");
export const CURRENT_FILE = path.join(UPSTREAM_DIR, "current.json");
export const PENDING_FILE = path.join(UPSTREAM_DIR, "pending.json");
export const REPORT_FILE = path.join(UPSTREAM_DIR, "pending-report.md");

const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;

class HttpError extends Error {
  constructor(url, response) {
    super(`GET ${url} failed: ${response.status} ${response.statusText}`);
    this.name = "HttpError";
    this.status = response.status;
  }
}

export class MirrorPendingError extends Error {
  constructor(version) {
    super(`Piebald has not published prompts for Claude Code ${version} yet`);
    this.name = "MirrorPendingError";
    this.version = version;
  }
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function decodeSourceEscapes(value) {
  const text = String(value);
  let result = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (["`", '"', "'", "$"].includes(next)) {
        result += next;
        i++;
      } else if (next === "\\") {
        result += "\\";
        i++;
      } else {
        result += text[i];
      }
    } else {
      result += text[i];
    }
  }
  return result;
}

export function reconstructPrompt(prompt) {
  let result = "";
  for (let i = 0; i < prompt.pieces.length; i++) {
    result += prompt.pieces[i];
    if (i < prompt.pieces.length - 1) {
      const identifier = prompt.identifierMap[String(prompt.identifiers[i])];
      if (!identifier) throw new Error(`Missing identifier mapping in ${prompt.id}`);
      result += identifier;
    }
  }
  return decodeSourceEscapes(result);
}

function requestHeaders() {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "agent-tools" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new HttpError(url, response);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_UPSTREAM_BYTES) throw new Error(`Upstream response is too large: ${declaredLength} bytes`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_UPSTREAM_BYTES) throw new Error("Upstream response exceeded the size limit");
  return text;
}

export async function discoverLatestVersion() {
  const metadata = JSON.parse(
    await fetchText("https://registry.npmjs.org/@anthropic-ai/claude-code/latest")
  );
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version || "")) {
    throw new Error("npm returned an invalid Claude Code version");
  }
  return metadata.version;
}

export function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

async function fetchMainCommit() {
  return JSON.parse(
    await fetchText(`https://api.github.com/repos/${UPSTREAM_REPOSITORY}/commits/main`, {
      headers: requestHeaders(),
    })
  );
}

export async function discoverLatestMirrorVersion(maxVersion) {
  const commit = await fetchMainCommit();
  const entries = JSON.parse(
    await fetchText(
      `https://api.github.com/repos/${UPSTREAM_REPOSITORY}/contents/data/prompts?ref=${commit.sha}`,
      { headers: requestHeaders() }
    )
  );
  if (!Array.isArray(entries)) throw new Error("Piebald prompt directory returned an invalid response");
  const versions = entries
    .map(({ name }) => /^prompts-(\d+\.\d+\.\d+)\.json$/.exec(name)?.[1])
    .filter((version) => version && compareVersions(version, maxVersion) <= 0)
    .sort(compareVersions);
  const version = versions.at(-1);
  return version ? { version, commit: commit.sha } : null;
}

async function assertPublishedVersion(version) {
  const metadata = JSON.parse(
    await fetchText(`https://registry.npmjs.org/@anthropic-ai/claude-code/${version}`)
  );
  if (metadata.version !== version) throw new Error(`Claude Code ${version} is not published on npm`);
}

export async function fetchUpstream(version, options = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version: ${version}`);
  await assertPublishedVersion(version);
  const commit = options.commit ? { sha: options.commit } : await fetchMainCommit();
  const sourceUrl = `https://raw.githubusercontent.com/${UPSTREAM_REPOSITORY}/${commit.sha}/data/prompts/prompts-${version}.json`;
  let sourceText;
  try {
    sourceText = await fetchText(sourceUrl);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) throw new MirrorPendingError(version);
    throw error;
  }
  const source = JSON.parse(sourceText);
  if (source.version !== version || !Array.isArray(source.prompts)) {
    throw new Error(`Unexpected upstream schema for Claude Code ${version}`);
  }
  const byId = new Map(source.prompts.map((prompt) => [prompt.id, prompt]));
  const missing = ALL_PROMPT_IDS.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`Upstream is missing required prompt IDs:\n${missing.join("\n")}`);
  const prompts = ALL_PROMPT_IDS.map((id) => byId.get(id));
  return {
    schemaVersion: 1,
    claudeCodeVersion: version,
    source: {
      repository: UPSTREAM_REPOSITORY,
      commit: commit.sha,
      path: `data/prompts/prompts-${version}.json`,
      sha256: sha256(sourceText),
    },
    prompts,
  };
}

export function promptMap(snapshot) {
  return new Map(snapshot.prompts.map((prompt) => [prompt.id, prompt]));
}

function promptDigest(prompt) {
  return sha256(stableJson(prompt));
}

export function compareSnapshots(current, pending) {
  const before = current ? promptMap(current) : new Map();
  return pending.prompts
    .filter((prompt) => promptDigest(before.get(prompt.id)) !== promptDigest(prompt))
    .map((prompt) => ({
      id: prompt.id,
      name: prompt.name,
      promptVersion: prompt.version,
      status: before.has(prompt.id) ? "changed" : "added",
      use: Object.entries(SKILLS)
        .filter(([, skill]) => skill.includedPromptIds.includes(prompt.id))
        .map(([name]) => name),
    }));
}

export function renderReport(current, pending) {
  const changes = compareSnapshots(current, pending);
  const from = current?.claudeCodeVersion || "none";
  const lines = [
    "# Pending Claude skill upstream",
    "",
    `- Accepted Claude Code version: ${from}`,
    `- Pending Claude Code version: ${pending.claudeCodeVersion}`,
    `- Source: ${pending.source.repository}@${pending.source.commit}`,
    `- Source SHA-256: ${pending.source.sha256}`,
    "",
    "## Selected prompt changes",
    "",
  ];
  if (!changes.length) lines.push("No selected prompt changed.");
  for (const change of changes) {
    lines.push(
      `- ${change.id} (${change.status}, source ${change.promptVersion}) — included by ${change.use.join(", ")}`
    );
  }
  lines.push(
    "",
    "## Local-locked composition",
    "",
    "Piebald exposes Reuse and Simplification as runtime interpolation values, not standalone prompt objects.",
    "Their exact text is hash-locked in the local renderer and must be checked against a real rendered prompt when it changes.",
    "",
    "## Manual next step",
    "",
    "Run `npm run claude-skills:apply -- --dry-run`, inspect the generated skill diff, then run with `--write`.",
    ""
  );
  return lines.join("\n");
}

export function writePending(snapshot) {
  fs.mkdirSync(UPSTREAM_DIR, { recursive: true });
  const current = fs.existsSync(CURRENT_FILE) ? readJson(CURRENT_FILE) : null;
  const changes = compareSnapshots(current, snapshot);
  if (current && changes.length === 0) return { changes, wrote: false };
  fs.writeFileSync(PENDING_FILE, stableJson(snapshot));
  fs.writeFileSync(REPORT_FILE, renderReport(current, snapshot));
  return { changes, wrote: true };
}
