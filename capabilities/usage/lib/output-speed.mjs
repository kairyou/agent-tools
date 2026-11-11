import fs from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
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
  let inputTime, response, lastTotal, lastResponseId, turnId, result = "";
  function finish(tokens, end) {
    result = formatOutputSpeed(tokens, end - response?.start);
    inputTime = Math.max(inputTime ?? -Infinity, end);
    response = undefined;
  }
  for (const entry of transcriptTail(file)) {
    const payload = entry.payload;
    if (!payload) continue;
    const timestamp = Date.parse(entry.timestamp);
    if (entry.type === "response_item") {
      if ((payload.type === "message" && payload.role === "user") ||
          payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        // Tool results are inputs to the next request, never model output time.
        inputTime = timestamp;
      } else if ((payload.type === "message" && payload.role === "assistant") ||
          ["reasoning", "function_call", "custom_tool_call", "web_search_call"].includes(payload.type)) {
        response ??= { start: inputTime };
        response.end = timestamp;
      }
      continue;
    }
    if (entry.type === "token_usage_record") {
      if (turnId && payload.turn_id && payload.turn_id !== turnId) continue;
      if (payload.response_id && payload.response_id === lastResponseId) continue;
      // Written when the API response finishes, before tool results. A later
      // token_count event can arrive only after a long-running tool completes.
      finish(payload.usage?.output_tokens, timestamp);
      lastResponseId = payload.response_id;
      continue;
    }
    if (entry.type !== "event_msg") continue;
    if (payload.type === "task_started") {
      inputTime = timestamp;
      turnId = payload.turn_id;
      response = undefined;
    } else if (payload.type === "user_message") {
      inputTime = timestamp;
    } else if (payload.type === "token_count") {
      const next = payload.info?.total_token_usage?.output_tokens;
      const last = payload.info?.last_token_usage?.output_tokens;
      if (!Number.isFinite(next) || next < 0 || next === lastTotal) continue;
      const tokens = last !== undefined ? last :
        lastTotal !== undefined && next >= lastTotal ? next - lastTotal : undefined;
      lastTotal = next;
      if (response) finish(tokens, response.end);
    } else if (payload.type === "turn_aborted") {
      inputTime = response = undefined;
      result = "";
    }
  }
  return result;
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

function claudeResponses(file) {
  let requestStart;
  let response;
  const responses = new Map();
  const ids = new Set();
  for (const entry of transcriptTail(file)) {
    if (entry.type === "progress" && entry.data?.type === "agent_progress") {
      ids.add(`agent-progress:${entry.uuid || entry.timestamp}`);
    }
    if (entry.type === "assistant" && typeof entry.message?.id === "string" && entry.message.id) {
      // Sidechain responses also consume cumulative API time. Keep their IDs
      // for pairing checks, without using their tokens for the main display.
      ids.add(entry.message.id);
    }
    if (entry.isSidechain) continue;
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      requestStart = undefined;
      response = undefined;
      responses.clear();
      ids.clear();
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
      const previous = responses.get(id);
      if (previous) {
        // Content blocks may repeat an older response between newer records.
        if (tokens >= previous.tokens) previous.usage = entry.message.usage;
        previous.tokens = Math.max(previous.tokens, tokens);
        previous.end = Math.max(previous.end, timestamp);
      } else {
        response = { id, tokens, start: requestStart, end: timestamp, usage: entry.message.usage };
        responses.set(id, response);
        requestStart = undefined;
      }
    }
  }
  return { response, ids: [...ids] };
}

function matchesClaudeUsage(response, usage) {
  return Number.isFinite(usage?.output_tokens) && usage.output_tokens === response.tokens &&
    ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
      .every((key) => (usage[key] ?? 0) === (response.usage[key] ?? 0));
}

function claudeApiSpeed(data, { response, ids }, cacheDir) {
  const key = createHash("sha256").update(resolve(data.transcript_path)).digest("hex");
  const file = join(cacheDir, `${key}.json`);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isFinite(state?.apiMs) || state.apiMs < 0 ||
        !(state.lastSeenId === null || typeof state.lastSeenId === "string")) state = undefined;
  } catch { /* No baseline yet, or an unreadable cache. */ }

  const apiMs = data.cost?.total_api_duration_ms;
  if (apiMs !== undefined && (!Number.isFinite(apiMs) || apiMs < 0)) return "";
  if (Number.isFinite(apiMs) && apiMs >= 0) {
    let next;
    if (!state || apiMs < state.apiMs) {
      next = { apiMs, lastSeenId: ids.at(-1) ?? null, measured: null };
    } else if (apiMs > state.apiMs) {
      const index = ids.indexOf(state.lastSeenId);
      const added = index >= 0 ? ids.slice(index + 1) :
        state.lastSeenId === null && state.apiMs === 0 ? ids : [];
      const deltaMs = apiMs - state.apiMs;
      const wallMs = response?.end - response?.start;
      let measured = state.measured;
      // A missed repaint can span several requests, compaction, or subagents.
      // Only pair one new response with matching payload usage. API time beyond
      // its whole transcript span also belongs to more than this request.
      if (response && added.length === 1 && added[0] === response.id &&
          matchesClaudeUsage(response, data.context_window?.current_usage) &&
          (!Number.isFinite(wallMs) || (wallMs > 0 && deltaMs <= wallMs))) {
        measured = { id: response.id, tokens: response.tokens, durationMs: deltaMs };
      }
      next = { apiMs, lastSeenId: ids.at(-1) ?? null, measured };
    }
    if (next) {
      state = next;
      const temp = `${file}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
        fs.renameSync(temp, file);
      } catch { /* A read-only cache must not interrupt the status line. */ }
      finally {
        try { fs.unlinkSync(temp); } catch { /* Already renamed or never created. */ }
      }
    }
  }
  const measured = state?.measured;
  return response && measured?.id === response.id && measured.tokens === response.tokens
    ? formatOutputSpeed(measured.tokens, measured.durationMs) : "";
}

export function claudeOutputSpeed(data, { cacheDir = join(
  process.env.AGENT_TOOLS_HOME || join(homedir(), ".agent-tools"), "cache", "claude-output-speed"
) } = {}) {
  if (typeof data?.transcript_path !== "string" || !data.transcript_path) return "";
  const parsed = claudeResponses(data.transcript_path);
  const native = claudeApiSpeed(data, parsed, cacheDir);
  return native || (parsed.response
    ? formatOutputSpeed(parsed.response.tokens, parsed.response.end - parsed.response.start) : "");
}
