#!/usr/bin/env node
// Records agent session activity into a work log.
//
// Wired as an agent hook (UserPromptSubmit / PreToolUse / PostToolUse / Stop).
// Claude Code and Codex run it directly from their hook config; OpenCode goes
// through the opencode-plugin.mjs adapter, which synthesizes these payloads.
// Configured via `log` in ~/.agent-tools/config.jsonc:
//   enabled   default true; false pauses recording without uninstalling
//   output    daily: a single markdown file; detailed: a directory of <date>.md
//   language  zh | en (detailed report headings; daily entries carry no chrome)
//   format    daily | detailed
//   projects  optional allowlist of directories; only sessions inside them are
//             recorded, and an entry may override format/output/language
//
// State and diff snapshots live in ~/.agent-tools/cache/log/ and only the
// current day is kept. Concurrent sessions share the day state without a lock,
// last-writer-wins: a simultaneous write from another session can drop that
// event's update, up to a whole turn with its outcome and file records.
// Accepted as best effort — the log is generated data, never user content.
// The opencode adapter serializes its own sends, so single-session events
// there never race each other.

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MIN_RESULT_SUMMARY_LENGTH = 24;
const DAILY_ITEM_MAX_CHARS = 160;

const INSTALL_ROOT = process.env.AGENT_TOOLS_HOME || path.join(os.homedir(), ".agent-tools");
const CACHE_ROOT = path.join(INSTALL_ROOT, "cache", "log");

async function main() {
  const rawInput = await readStdin();
  if (!rawInput.trim()) return;

  let hookInput;
  try {
    hookInput = JSON.parse(stripBom(rawInput));
  } catch (error) {
    console.error(`[agent-tools log] Failed to parse hook input: ${error.message}`);
    return;
  }

  const eventName = getEventName(hookInput);
  if (!["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].includes(eventName)) {
    return;
  }

  const config = await loadLogConfig();
  if (!config.enabled) return;
  const cwd = eventCwd(hookInput);
  const scope = matchScope(config, cwd);
  if (config.projects.length > 0 && !scope) return;
  const effective = scope || config;
  // Turns are grouped for rendering by their output target, not by project:
  // scopes that inherit the same output must land in the same file instead of
  // overwriting each other's entries.
  const scopeKey = `${effective.format}|${pathKey(effective.output)}`;

  const now = new Date();
  const day = formatLocalDate(now);
  const statePath = path.join(CACHE_ROOT, `${day}.state.json`);
  const snapshotsRoot = path.join(CACHE_ROOT, `${day}.snapshots`);

  await fs.mkdir(CACHE_ROOT, { recursive: true });
  await cleanupCache(day);

  const state = await loadState(statePath, day);
  await handleEvent(state, hookInput, { now, snapshotsRoot, effective, scopeKey });
  await writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);

  if (effective.format === "detailed") {
    const report = await renderDetailedReport(state, {
      snapshotsRoot,
      language: effective.language,
      scopeKey,
    });
    await fs.mkdir(effective.output, { recursive: true });
    await writeFileAtomic(path.join(effective.output, `${day}.md`), report);
  } else {
    await updateDailyFile(effective.output, day, buildDailyItems(state, scopeKey));
  }
}

function eventCwd(input) {
  return firstNonEmpty(input?.cwd, input?.workspace, input?.project_dir) || process.cwd();
}

// ---- Config. ----

async function loadLogConfig() {
  let parsed = {};
  try {
    const raw = await fs.readFile(path.join(INSTALL_ROOT, "config.jsonc"), "utf8");
    parsed = parseJsonc(stripBom(raw), [], { allowTrailingComma: true }) || {};
  } catch {
    // Missing or unreadable config falls back to defaults below.
  }
  const section = isPlainObject(parsed.log) ? parsed.log : {};
  const enabled = section.enabled !== false;
  const format = pickFormat(section.format, "daily");
  const language = pickLanguage(section.language, "zh");
  const output = pickOutput(section.output, format, defaultOutput(format));

  // Optional allowlist; entries may override format/language/output per project.
  const projects = [];
  if (Array.isArray(section.projects)) {
    for (const item of section.projects) {
      const entry = typeof item === "string" ? { path: item } : isPlainObject(item) ? item : null;
      if (!entry || typeof entry.path !== "string" || !entry.path.trim()) continue;
      const scopeFormat = pickFormat(entry.format, format);
      projects.push({
        path: path.resolve(expandHome(entry.path.trim())),
        format: scopeFormat,
        language: pickLanguage(entry.language, language),
        // An entry that switches format without naming an output cannot reuse
        // the top-level one (file vs directory), so it gets the built-in default.
        output: pickOutput(entry.output, scopeFormat, scopeFormat === format ? output : defaultOutput(scopeFormat)),
      });
    }
  }
  return { enabled, format, language, output, projects };
}

function pickFormat(value, fallback) {
  return value === "detailed" || value === "daily" ? value : fallback;
}

function pickLanguage(value, fallback) {
  return value === "en" || value === "zh" ? value : fallback;
}

function defaultOutput(format) {
  return path.join(INSTALL_ROOT, "logs", format === "detailed" ? "ai-log" : "ai-log.md");
}

function pickOutput(value, format, fallback) {
  return typeof value === "string" && value.trim()
    ? path.resolve(expandHome(value.trim()))
    : fallback;
}

function pathKey(value) {
  const normalized = normalizePath(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function matchScope(config, cwd) {
  const key = pathKey(cwd);
  let best = null;
  for (const entry of config.projects) {
    const entryKey = pathKey(entry.path);
    if (key !== entryKey && !key.startsWith(`${entryKey}/`)) continue;
    if (!best || entryKey.length > pathKey(best.path).length) best = entry;
  }
  return best;
}

// ---- Event handling. ----

async function handleEvent(state, input, context) {
  const timestamp = formatLocalDateTime(context.now);
  const eventName = getEventName(input);
  const sessionId = getSessionId(input);
  const session = ensureSession(state, sessionId, timestamp);
  session.last_time = timestamp;

  if (eventName === "UserPromptSubmit") {
    // Always start a turn, even for greetings: reusing the previous turn would
    // let this prompt's Stop overwrite the previous result summary. Trivial
    // turns are filtered at render time instead.
    session.turns.push(
      createTurn(session, timestamp, getPromptText(input), resolveProjectLabel(input), context.scopeKey)
    );
    return;
  }

  const turn = ensureCurrentTurn(session, timestamp, resolveProjectLabel(input), context.scopeKey);
  turn.last_time = timestamp;

  if (eventName === "PreToolUse") {
    // Baseline snapshots only feed the detailed report's diff column.
    if (context.effective.format === "detailed") {
      await captureBaselineSnapshot(turn, sessionId, input, {
        timestamp,
        snapshotsRoot: context.snapshotsRoot,
      });
    }
    return;
  }

  if (eventName === "Stop") {
    const summary = excerptMultiline(getOutcomeText(input), 900);
    if (summary) turn.result_summary = summary;
    return;
  }

  recordToolUse(turn, input, { timestamp });
}

function resolveProjectLabel(input) {
  const cwd = eventCwd(input);
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const root = result.status === 0 ? result.stdout.trim() : "";
  return path.basename(root || cwd);
}

async function cleanupCache(day) {
  let entries = [];
  try {
    entries = await fs.readdir(CACHE_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const isState = entry.isFile() && /^\d{4}-\d{2}-\d{2}\.state\.json$/.test(entry.name);
      const isSnapshots = entry.isDirectory() && /^\d{4}-\d{2}-\d{2}\.snapshots$/.test(entry.name);
      if ((!isState && !isSnapshots) || entry.name.startsWith(day)) return;
      try {
        await fs.rm(path.join(CACHE_ROOT, entry.name), { recursive: true, force: true });
      } catch {
        // Cache cleanup must never block logging.
      }
    })
  );
}

async function loadState(statePath, day) {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (
      isPlainObject(parsed) &&
      parsed.date === day &&
      isPlainObject(parsed.sessions)
    ) {
      return parsed;
    }
  } catch {
    // Fresh day or unreadable state; rebuild below.
  }
  return { date: day, sessions: {} };
}

function ensureSession(state, sessionId, timestamp) {
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = { first_time: timestamp, last_time: timestamp, turns: [] };
  }
  return state.sessions[sessionId];
}

function ensureCurrentTurn(session, timestamp, project, scopeKey) {
  if (!Array.isArray(session.turns)) session.turns = [];
  const currentTurn = session.turns[session.turns.length - 1];
  if (currentTurn) return currentTurn;
  const fallbackTurn = createTurn(session, timestamp, "", project, scopeKey);
  session.turns.push(fallbackTurn);
  return fallbackTurn;
}

function createTurn(session, timestamp, requestText, project, scopeKey) {
  const turnIndex = Array.isArray(session.turns) ? session.turns.length + 1 : 1;
  return {
    turn_id: `turn-${turnIndex}-${simpleHash(`${timestamp}-${requestText}`).slice(0, 8)}`,
    first_time: timestamp,
    last_time: timestamp,
    project: project || "",
    scope: scopeKey || "",
    request_text: excerptMultiline(requestText || "", 1600),
    result_summary: "",
    bash_commands: 0,
    verification_commands: 0,
    files: {},
  };
}

function ensureTurnFile(turn, fileKey, relativePath, absolutePath, timestamp) {
  if (!turn.files[fileKey]) {
    turn.files[fileKey] = {
      rel: relativePath,
      abs: absolutePath,
      writes: 0,
      edits: 0,
      first_time: timestamp,
      last_time: timestamp,
      snapshot_kind: "",
    };
  }
  return turn.files[fileKey];
}

function recordToolUse(turn, input, context) {
  const toolName = getToolName(input);

  if (toolName === "Bash") {
    const kind = classifyCommand(getShellCommand(input));
    turn.bash_commands += 1;
    if (["test", "lint", "typecheck", "build", "format"].includes(kind)) {
      turn.verification_commands += 1;
    }
    return;
  }

  if (!["Write", "Edit", "MultiEdit"].includes(toolName)) return;

  const located = locateToolFile(input);
  if (!located) return;

  const turnFile = ensureTurnFile(turn, located.key, located.rel, located.abs, context.timestamp);
  turnFile.last_time = context.timestamp;
  if (!turnFile.snapshot_kind) turnFile.snapshot_kind = "unknown";

  if (toolName === "Write") turnFile.writes += 1;
  else turnFile.edits += 1;
}

function locateToolFile(input) {
  const rawPath = getToolFilePath(input);
  if (!rawPath) return null;
  const cwd = firstNonEmpty(input?.cwd, input?.workspace, input?.project_dir) || process.cwd();
  const abs = normalizePath(path.resolve(cwd, rawPath));
  const cwdNormalized = normalizePath(path.resolve(cwd));
  const rel = abs.toLowerCase().startsWith(`${cwdNormalized.toLowerCase()}/`)
    ? abs.slice(cwdNormalized.length + 1)
    : abs;
  const key = process.platform === "win32" ? abs.toLowerCase() : abs;
  return { key, rel, abs };
}

// ---- Baseline snapshots (detailed format only). ----

async function captureBaselineSnapshot(turn, sessionId, input, context) {
  const toolName = getToolName(input);
  if (!["Write", "Edit", "MultiEdit"].includes(toolName)) return;

  const located = locateToolFile(input);
  if (!located) return;

  const turnFile = ensureTurnFile(turn, located.key, located.rel, located.abs, context.timestamp);
  if (turnFile.snapshot_kind) return;

  turnFile.snapshot_kind = await createSnapshotFile(
    buildSnapshotKey(sessionId, turn.turn_id),
    located,
    context.snapshotsRoot
  );
}

async function createSnapshotFile(snapshotKey, located, snapshotsRoot) {
  let stats;
  try {
    stats = await fs.stat(located.abs);
  } catch (error) {
    return error?.code === "ENOENT" ? "missing" : "unknown";
  }
  if (!stats.isFile()) return "unknown";
  if (stats.size > MAX_SNAPSHOT_BYTES) return "large";

  let buffer;
  try {
    buffer = await fs.readFile(located.abs);
  } catch {
    return "unknown";
  }
  if (buffer.includes(0)) return "binary";

  const snapshotPath = getSnapshotPath(snapshotsRoot, snapshotKey, located);
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  await fs.writeFile(snapshotPath, buffer);
  return "text";
}

function getSnapshotPath(snapshotsRoot, snapshotKey, located) {
  return path.join(snapshotsRoot, sanitizeDirName(snapshotKey), `${simpleHash(located.key)}-${path.basename(located.abs)}`);
}

function buildSnapshotKey(sessionId, turnId) {
  return `${sessionId}-${turnId}`;
}

function sanitizeDirName(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${normalized || "session"}-${simpleHash(value).slice(0, 8)}`;
}

// ---- Daily format: one file, one dated entry per day, marker-guarded. The
// markers use the `log:` namespace (the capability name); at-daily-log stamps
// `daily-log:` markers, so a shared output file never collides. ----

function buildDailyItems(state, scopeKey) {
  const items = [];
  for (const session of orderedSessions(state)) {
    for (const turn of session.turns || []) {
      if (String(turn.scope || "") !== scopeKey) continue;
      const text = dailyItemText(turn);
      if (!text) continue;
      items.push({ first_time: turn.first_time, project: turn.project || "", text });
    }
  }
  items.sort((a, b) => String(a.first_time).localeCompare(String(b.first_time)));
  return items;
}

function dailyItemText(turn) {
  const request = String(turn.request_text || "");
  const outcome = String(turn.result_summary || "");
  if (!hasSubstantiveTurn(request, outcome) || isTrivialTurn(request, outcome)) return "";
  const source = outcome || request;
  const firstLine = source
    .split("\n")
    .map((line) => line.replace(/^[#>*\-\s`]+/, "").trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  return firstLine.length > DAILY_ITEM_MAX_CHARS
    ? `${firstLine.slice(0, DAILY_ITEM_MAX_CHARS - 3)}...`
    : firstLine;
}

async function updateDailyFile(outputFile, day, items) {
  if (items.length === 0) return;

  const lines = items.map(
    (item, index) => `  ${index + 1}. ${item.project ? `${item.project}: ` : ""}${item.text}`
  );
  const block = [`<!-- log:${day}:start -->`, ...lines, `<!-- log:${day}:end -->`];

  let current = "";
  try {
    current = await fs.readFile(outputFile, "utf8");
  } catch {
    // First write creates the file.
  }
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const fileLines = current ? current.split(/\r?\n/) : [];

  const startMarker = `<!-- log:${day}:start -->`;
  const endMarker = `<!-- log:${day}:end -->`;
  const startIndex = fileLines.findIndex((line) => line.trim() === startMarker);
  const endIndex = fileLines.findIndex((line) => line.trim() === endMarker);

  let nextLines;
  if (startIndex !== -1 && endIndex > startIndex) {
    nextLines = [...fileLines.slice(0, startIndex), ...block, ...fileLines.slice(endIndex + 1)];
  } else if (startIndex !== -1 || endIndex !== -1) {
    // Unpaired markers: refuse to guess an edit range in an unattended run.
    console.error(`[agent-tools log] Unpaired markers for ${day} in ${outputFile}; skipped.`);
    return;
  } else {
    nextLines = insertDatedBlock(fileLines, day, block);
  }

  const text = nextLines.join(eol).replace(/(\r?\n)*$/, eol);
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await writeFileAtomic(outputFile, text);
}

function insertDatedBlock(fileLines, day, block) {
  const dateLineRe = /^\+ (\d{4}-\d{2}-\d{2})\s*$/;
  const dates = [];
  for (let i = 0; i < fileLines.length; i += 1) {
    const match = fileLines[i].match(dateLineRe);
    if (match) dates.push({ index: i, date: match[1] });
  }

  const existing = dates.find((entry) => entry.date === day);
  if (existing) {
    // Date line exists without markers (user-written): append the block below
    // that date's lines. The dated section ends at the next date line or the
    // next heading (notes and todo lists after the entries stay untouched).
    const boundaryRe = /^(\+ \d{4}-\d{2}-\d{2}\s*$|#{1,6}\s)/;
    let insertAt = fileLines.length;
    for (let i = existing.index + 1; i < fileLines.length; i += 1) {
      if (boundaryRe.test(fileLines[i])) {
        insertAt = i;
        break;
      }
    }
    while (insertAt - 1 > existing.index && fileLines[insertAt - 1].trim() === "") insertAt -= 1;
    const trailing = fileLines.slice(insertAt);
    const inserted = [...block];
    if (trailing.length > 0 && trailing[0].trim() !== "") inserted.push("");
    return [...fileLines.slice(0, insertAt), ...inserted, ...trailing];
  }

  // Insert a new date at its date-order position; ascending when ambiguous.
  const ascending = dates.length < 2 || dates[0].date <= dates[dates.length - 1].date;
  let insertAt = fileLines.length;
  for (const entry of dates) {
    if (ascending ? entry.date > day : entry.date < day) {
      insertAt = entry.index;
      break;
    }
  }
  const dated = [`+ ${day}`, ...block];
  const before = fileLines.slice(0, insertAt);
  const after = fileLines.slice(insertAt);
  if (before.length > 0 && before[before.length - 1].trim() !== "") before.push("");
  if (after.length > 0 && after[0].trim() !== "") dated.push("");
  return [...before, ...dated, ...after];
}

// ---- Detailed format: one report file per day. ----

const STRINGS = {
  zh: {
    title: (date) => `# AI 日报 - ${date}`,
    updated: (time) => `更新时间: ${time}`,
    overview: "## 今日概览",
    prompts: (n) => `- 请求次数: ${n}`,
    turns: (n) => `- 有效记录数: ${n}`,
    changedFiles: (n) => `- 变更文件数: ${n}`,
    fileOps: (n) => `- 代码操作次数: ${n}`,
    lineChanges: (added, deleted) => `- 总行变更: +${added}/-${deleted}`,
    sessions: "## 会话记录",
    none: "- 无",
    request: "Request",
    outcome: "Outcome",
    changes: "Changes",
    fileLine: (file) => `- ${file.rel} | 变更 ${file.diff} | 操作 ${file.writes + file.edits} 次`,
    noPrompt: "未记录 prompt",
  },
  en: {
    title: (date) => `# AI Log - ${date}`,
    updated: (time) => `Updated: ${time}`,
    overview: "## Overview",
    prompts: (n) => `- Prompts: ${n}`,
    turns: (n) => `- Recorded turns: ${n}`,
    changedFiles: (n) => `- Changed files: ${n}`,
    fileOps: (n) => `- File operations: ${n}`,
    lineChanges: (added, deleted) => `- Line changes: +${added}/-${deleted}`,
    sessions: "## Sessions",
    none: "- none",
    request: "Request",
    outcome: "Outcome",
    changes: "Changes",
    fileLine: (file) => `- ${file.rel} | diff ${file.diff} | ${file.writes + file.edits} ops`,
    noPrompt: "no prompt recorded",
  },
};

async function renderDetailedReport(state, context) {
  const t = STRINGS[context.language] || STRINGS.zh;
  const scopeTurns = collectScopeTurns(state, context.scopeKey);
  const turnEntries = await buildTurnEntries(state, context);
  const changedFiles = new Set(
    turnEntries.flatMap((entry) => entry.files.map((file) => file.rel))
  );
  const fileOps = scopeTurns.reduce(
    (sum, turn) =>
      sum +
      Object.values(turn.files || {}).reduce((s, f) => s + (f.writes || 0) + (f.edits || 0), 0),
    0
  );
  const lineChanges = summarizeLineChanges(turnEntries);

  const lines = [
    t.title(state.date),
    "",
    t.updated(latestSessionTime(state) || "unknown"),
    "",
    t.overview,
    "",
    t.prompts(scopeTurns.length),
    t.turns(turnEntries.length),
    t.changedFiles(changedFiles.size),
    t.fileOps(fileOps),
    t.lineChanges(lineChanges.added, lineChanges.deleted),
    "",
    t.sessions,
    "",
  ];

  if (turnEntries.length === 0) {
    lines.push(t.none);
  } else {
    turnEntries.forEach((entry, index) => {
      lines.push(`- Time: ${entry.first_time} -> ${entry.last_time}`);
      if (entry.project) lines.push(`- Project: ${entry.project}`);
      const requestText = entry.request_text || t.noPrompt;
      const requestFence = fenceFor(requestText);
      lines.push("", t.request, "", `${requestFence}text`, requestText, requestFence);
      if (entry.result_summary) {
        const outcomeFence = fenceFor(entry.result_summary);
        lines.push("", t.outcome, "", `${outcomeFence}text`, entry.result_summary, outcomeFence);
      }
      lines.push("", t.changes, "");
      if (entry.files.length === 0) {
        lines.push(t.none);
      } else {
        for (const file of entry.files) lines.push(t.fileLine(file));
      }
      if (index < turnEntries.length - 1) lines.push("", "---", "");
    });
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function latestSessionTime(state) {
  let latest = "";
  for (const session of Object.values(state.sessions)) {
    if (String(session.last_time || "") > latest) latest = String(session.last_time);
  }
  return latest;
}

function orderedSessions(state) {
  return Object.values(state.sessions).sort((a, b) =>
    String(a.first_time || "").localeCompare(String(b.first_time || ""))
  );
}

function collectScopeTurns(state, scopeKey) {
  const turns = [];
  for (const session of orderedSessions(state)) {
    for (const turn of session.turns || []) {
      if (String(turn.scope || "") === scopeKey) turns.push(turn);
    }
  }
  return turns;
}

async function buildTurnEntries(state, context) {
  const entries = [];
  for (const session of orderedSessions(state)) {
    const sessionId = Object.keys(state.sessions).find((key) => state.sessions[key] === session);
    for (const turn of session.turns || []) {
      if (String(turn.scope || "") !== context.scopeKey) continue;
      const files = await buildTurnFileEntries(sessionId, turn, context);
      const requestText = String(turn.request_text || "");
      const resultSummary = String(turn.result_summary || "");
      if (
        files.length === 0 &&
        (!hasSubstantiveTurn(requestText, resultSummary) || isTrivialTurn(requestText, resultSummary))
      ) {
        continue;
      }
      entries.push({
        first_time: turn.first_time,
        last_time: turn.last_time,
        project: turn.project || "",
        request_text: requestText,
        result_summary: resultSummary,
        files,
      });
    }
  }
  entries.sort((a, b) => String(a.first_time || "").localeCompare(String(b.first_time || "")));
  return entries;
}

async function buildTurnFileEntries(sessionId, turn, context) {
  const entries = [];
  const orderedFiles = Object.values(turn.files || {})
    .filter((item) => (item?.writes || 0) + (item?.edits || 0) > 0)
    .sort((a, b) => b.writes + b.edits - (a.writes + a.edits));

  for (const item of orderedFiles) {
    entries.push({
      rel: item.rel,
      writes: item.writes || 0,
      edits: item.edits || 0,
      diff: await getTurnDiffLabel(sessionId, turn.turn_id, item, context),
    });
  }
  return entries;
}

// A code fence longer than any backtick run inside the content, so embedded
// fenced samples cannot terminate the block early.
function fenceFor(text) {
  const runs = String(text).match(/`{3,}/g);
  const length = runs ? Math.max(...runs.map((run) => run.length)) + 1 : 3;
  return "`".repeat(length);
}

// The diff compares the turn's baseline snapshot against the file as it is
// NOW, so when several turns touch one file (a common case) earlier turns
// absorb later changes and the day total double-counts them. Accepted
// approximation, and the docs call it that; exact per-turn numbers would need
// an end-of-turn snapshot per file on top of the baseline one.
async function getTurnDiffLabel(sessionId, turnId, turnFile, context) {
  const baselineKind = turnFile.snapshot_kind || "unknown";
  if (["binary", "large", "unknown"].includes(baselineKind)) return baselineKind;

  const currentExists = await pathExists(turnFile.abs);
  const emptyFilePath = await ensureEmptyFile(context.snapshotsRoot);
  const leftPath =
    baselineKind === "text"
      ? getSnapshotPath(context.snapshotsRoot, buildSnapshotKey(sessionId, turnId), {
          key: process.platform === "win32" ? turnFile.abs.toLowerCase() : turnFile.abs,
          abs: turnFile.abs,
        })
      : emptyFilePath;
  const rightPath = currentExists ? turnFile.abs : emptyFilePath;

  const result = spawnSync(
    "git",
    ["diff", "--no-index", "--numstat", "--no-ext-diff", "--no-textconv", "--", leftPath, rightPath],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.error || ![0, 1].includes(result.status ?? -1)) return "unknown";

  const line = (result.stdout || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  if (!line) return "+0/-0";
  const [added, deleted] = line.split("\t");
  if (added === "-" || deleted === "-") return "binary";
  return `+${Number(added || 0)}/-${Number(deleted || 0)}`;
}

function summarizeLineChanges(turnEntries) {
  const total = { added: 0, deleted: 0 };
  for (const entry of turnEntries) {
    for (const file of entry.files || []) {
      const match = String(file.diff || "").match(/^\+(\d+)\/-(\d+)$/);
      if (!match) continue;
      total.added += Number(match[1]);
      total.deleted += Number(match[2]);
    }
  }
  return total;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureEmptyFile(snapshotsRoot) {
  const emptyFilePath = path.join(snapshotsRoot, ".empty");
  try {
    await fs.access(emptyFilePath);
  } catch {
    await fs.mkdir(snapshotsRoot, { recursive: true });
    await fs.writeFile(emptyFilePath, "", "utf8");
  }
  return emptyFilePath;
}

// ---- Turn filtering. ----

function hasSubstantiveTurn(requestText, resultSummary) {
  const request = String(requestText || "").trim();
  const outcome = String(resultSummary || "").trim();
  if (outcome.length >= MIN_RESULT_SUMMARY_LENGTH) return true;
  if (request.length >= 32) return true;
  if (/\n/.test(request) && request.length >= 16) return true;
  return false;
}

function isTrivialTurn(requestText, resultSummary) {
  const request = normalizeConversationText(requestText);
  const outcome = normalizeConversationText(resultSummary);
  if (!request && !outcome) return true;

  const shortGreetingPattern =
    /^(hi|hello|hey|yo|test|testing|ping|pong|ok|okay|thanks|thank you|thx|你好|嗨|哈喽|在吗|测试|试试|好的|收到)$/;
  if (shortGreetingPattern.test(request) && outcome.length <= 40) return true;

  if (
    request.length <= 12 &&
    outcome.length <= 40 &&
    !/[一-龥a-z0-9].*[一-龥a-z0-9].*[一-龥a-z0-9]/i.test(request)
  ) {
    return true;
  }
  return false;
}

function normalizeConversationText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\r\n/g, "\n")
    .replace(/[`#>*_-]+/g, " ")
    .replace(/[.!?,，。！？]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyCommand(command) {
  const value = (command || "").toLowerCase();
  if (!value.trim()) return "other";
  if (/(^|\s)(pnpm|npm|yarn|bun|pytest|vitest|jest)\b/.test(value) || /\btest\b/.test(value)) return "test";
  if (/\blint\b/.test(value)) return "lint";
  if (/\btypecheck\b|\btsc\b/.test(value)) return "typecheck";
  if (/\bbuild\b/.test(value)) return "build";
  if (/\bformat\b|\bprettier\b|\bbiome\b/.test(value)) return "format";
  if (/\bgit\b/.test(value)) return "git";
  return "other";
}

// ---- Hook input accessors. ----

function getEventName(input) {
  return firstNonEmpty(input?.hook_event_name, input?.event_name, input?.event, input?.type);
}

function getSessionId(input) {
  return String(firstNonEmpty(input?.session_id, input?.sessionId, input?.conversation_id) || "unknown");
}

function getPromptText(input) {
  return firstNonEmpty(input?.prompt, input?.user_prompt, input?.message, input?.text);
}

function getOutcomeText(input) {
  return firstNonEmpty(
    input?.last_assistant_message,
    input?.assistant_message,
    input?.response,
    input?.output,
    input?.result
  );
}

function getToolName(input) {
  return firstNonEmpty(input?.tool_name, input?.toolName, input?.tool?.name, input?.name);
}

function getToolInput(input) {
  return firstPlainObject(input?.tool_input, input?.toolInput, input?.input, input?.arguments);
}

function getToolFilePath(input) {
  const toolInput = getToolInput(input);
  return firstNonEmpty(toolInput.file_path, toolInput.filePath, toolInput.path, toolInput.target_file);
}

function getShellCommand(input) {
  const toolInput = getToolInput(input);
  return firstNonEmpty(toolInput.command, toolInput.cmd, toolInput.script);
}

// ---- Small helpers. ----

async function writeFileAtomic(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, text, "utf8");
  await fs.rename(temp, file);
}

function excerptMultiline(text, limit) {
  const value = String(text || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || "";
}

function firstPlainObject(...values) {
  return values.find((value) => isPlainObject(value)) || {};
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function stripBom(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}

function simpleHash(input) {
  let hash = 0;
  const text = String(input || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLocalDateTime(date) {
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  const seconds = `${date.getSeconds()}`.padStart(2, "0");
  return `${formatLocalDate(date)} ${hours}:${minutes}:${seconds}`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((error) => {
  console.error(`[agent-tools log] ${error.stack || error.message}`);
  process.exit(0);
});
