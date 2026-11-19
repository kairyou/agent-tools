import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const name = "agent-tools-log";
export const inject = ["workingDirectory"];
const HOOK = fileURLToPath(new URL("./hook.mjs", import.meta.url));

function sendToRecorder(payload) {
  return new Promise((resolve) => {
    try {
      const child = spawn("node", [HOOK], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      child.on("error", resolve);
      child.on("close", resolve);
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(payload));
    } catch { resolve(); }
  });
}

function textContent(message) {
  return (message?.content || []).filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
}

export function createDshLogPlugin({ send = sendToRecorder } = {}) {
  return function apply(ctx) {
    let queue = Promise.resolve();
    const turns = new Map();
    const record = (session, event, fields = {}) => {
      const payload = {
        hook_event_name: event, session_id: `dsh:${session.id}`,
        cwd: ctx.workingDirectory.get(session), ...fields,
      };
      queue = queue.then(() => send(payload)).catch(() => {});
      return queue;
    };
    ctx.on("session/event", (session, event) => {
      if (event.type === "turn/start") turns.set(session.id, { started: false, outcome: "" });
      const turn = turns.get(session.id);
      if (!turn) return;
      if (event.type === "user/message" && event.data.source?.kind === "user") {
        const prompt = textContent(event.data);
        if (!prompt.trim()) return;
        turn.started = true;
        return record(session, "UserPromptSubmit", { prompt });
      }
      if (event.type === "assistant/message") {
        turn.outcome = event.data.interrupted ? "" : textContent(event.data.message);
      } else if (event.type === "turn/end") {
        turns.delete(session.id);
        if (turn.started) return record(session, "Stop", {
          last_assistant_message: event.data.reason?.kind === "completed" ? turn.outcome : "",
        });
      }
    });
    const toolPayloads = (exec) => {
      if (!exec.agent || !turns.get(exec.agent.session.id)?.started) return [];
      const args = exec.arguments || {};
      if (exec.name === "apply_patch" && typeof args.input === "string") {
        return [...new Set([...args.input.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)]
          .map((match) => match[1].trim()))].map((file_path) => ({ tool_name: "Edit", tool_input: { file_path } }));
      }
      if (exec.name === "str_replace_editor") {
        if (!["create", "str_replace", "insert"].includes(args.command)) return [];
        return [{ tool_name: args.command === "create" ? "Write" : "Edit", tool_input: {
          file_path: args.path, content: args.file_text, old_string: args.old_str, new_string: args.new_str,
        } }];
      }
      const toolName = { write: "Write", edit: "Edit", bash: "Bash" }[exec.name];
      return toolName ? [{ tool_name: toolName, tool_input: exec.arguments }] : [];
    };
    ctx.on("tools/pre-execute", async (exec, next) => {
      for (const payload of toolPayloads(exec)) {
        if (payload.tool_name !== "Bash") await record(exec.agent.session, "PreToolUse", payload);
      }
      return await next();
    });
    ctx.on("tools/post-execute", async (exec, result, next) => {
      const downstream = await next();
      if (!result.isError) for (const payload of toolPayloads(exec)) {
        await record(exec.agent.session, "PostToolUse", payload);
      }
      return downstream;
    });
    ctx.on("session/disposed", (session) => { turns.delete(session.id); });
    ctx.effect(() => async () => { await queue; turns.clear(); });
  };
}

export const apply = createDshLogPlugin();
