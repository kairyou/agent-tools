import fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function formatOutputSpeed(tokens, durationMs) {
  if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(durationMs) || durationMs <= 0) return "";
  const speed = tokens * 1000 / durationMs;
  return Number.isFinite(speed) ? `${speed.toFixed(1)} tok/s` : "";
}

export function withOutputSpeed(text, speed) {
  return [text, speed].filter(Boolean).join(" | ");
}

function transcriptTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    // A repaint or hook must never scan an unbounded conversation history.
    const start = Math.max(0, size - 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
    if (start) lines.shift();
    return lines.flatMap((line) => {
      try { const entry = JSON.parse(line); return entry ? [entry] : []; } catch { return []; }
    });
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function codexOutputSpeed(file) {
  let start, total, baseline, lastTotal, end, result = "";
  for (const entry of transcriptTail(file)) {
    if (entry.type !== "event_msg") continue;
    const payload = entry.payload;
    if (!payload) continue;
    if (payload.type === "task_started") {
      start = Date.parse(entry.timestamp);
      baseline = lastTotal;
      total = 0;
      end = undefined;
    } else if (payload.type === "token_count") {
      const next = payload.info?.total_token_usage?.output_tokens;
      const last = payload.info?.last_token_usage?.output_tokens;
      if (!Number.isFinite(next) || next < 0 || next === lastTotal) continue;
      if (Number.isFinite(start)) {
        if (baseline === undefined && Number.isFinite(last) && last >= 0) baseline = next - last;
        total = baseline !== undefined && next >= baseline ? next - baseline : undefined;
        end = Date.parse(entry.timestamp);
      }
      lastTotal = next;
    } else if (payload.type === "task_complete") {
      // Completed-turn throughput includes model waits and tool execution.
      result = formatOutputSpeed(total, Date.parse(entry.timestamp) - start);
      start = undefined;
    } else if (payload.type === "turn_aborted") {
      start = undefined;
    }
  }
  return Number.isFinite(start) && end !== undefined ? formatOutputSpeed(total, end - start) : result;
}

export function agentOutputSpeed(agent, { transcriptPath, cwd = process.cwd(), sessionId = process.env.CODEX_THREAD_ID } = {}) {
  try {
    if (!transcriptPath && agent === "claude") {
      const project = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      transcriptPath = fs.readdirSync(project).filter((name) => name.endsWith(".jsonl"))
        .map((name) => ({ file: join(project, name), mtime: fs.statSync(join(project, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0]?.file;
    } else if (!transcriptPath && agent === "codex" && sessionId) {
      const root = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
      transcriptPath = fs.readdirSync(root, { recursive: true }).filter((name) => name.endsWith(`-${sessionId}.jsonl`))
        .map((name) => join(root, name))[0];
    }
    if (!transcriptPath) return "";
    return agent === "claude" ? claudeOutputSpeed({ transcript_path: transcriptPath }) :
      agent === "codex" ? codexOutputSpeed(transcriptPath) : "";
  } catch { return ""; }
}

export function claudeOutputSpeed(data) {
  if (typeof data?.transcript_path !== "string") return "";
  let requestStart;
  let response;
  for (const entry of transcriptTail(data.transcript_path)) {
    if (!entry || entry.isSidechain) continue;
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      requestStart = undefined;
      response = undefined;
      continue;
    }
    const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (entry.type === "user") {
      requestStart = Number.isFinite(timestamp) ? timestamp : undefined;
    } else if (entry.type === "assistant") {
      const id = entry.message?.id;
      const tokens = entry.message?.usage?.output_tokens;
      if (typeof id !== "string" || !id || !Number.isFinite(timestamp) ||
          !Number.isFinite(tokens) || tokens < 0) continue;
      if (response?.id === id) {
        // Streaming records repeat cumulative usage for the same response.
        response.tokens = Math.max(response.tokens, tokens);
        response.end = Math.max(response.end, timestamp);
      } else {
        response = { id, tokens, start: requestStart, end: timestamp };
        requestStart = undefined;
      }
    }
  }
  if (!response || !Number.isFinite(response.start)) return "";
  return formatOutputSpeed(response.tokens, response.end - response.start);
}
