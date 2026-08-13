// OpenCode adapter for the log capability: translates plugin events into the
// hook payloads dist/log/hook.mjs consumes, so both agents share one recorder.
//
// Verified against a real OpenCode run: chat.message carries the user prompt,
// tool.execute.after carries absolute file paths in output.metadata.files, and
// the assistant's final text arrives as message.part.updated parts belonging
// to messages that message.updated announced as role=assistant.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "hook.mjs");

// Sends run strictly one after another: the hook does an unlocked
// read-modify-write on the day state, so parallel hook processes from the
// same adapter would drop each other's events.
let sendQueue = Promise.resolve();

function send(payload) {
  sendQueue = sendQueue.then(
    () =>
      new Promise((resolve) => {
        try {
          // OpenCode is a Bun single binary, so process.execPath points at
          // opencode.exe; the hook needs the node on PATH (required >= 22 anyway).
          const child = spawn("node", [HOOK], {
            stdio: ["pipe", "ignore", "ignore"],
            windowsHide: true,
          });
          child.on("error", () => resolve());
          child.on("exit", () => resolve());
          child.stdin.write(JSON.stringify(payload));
          child.stdin.end();
        } catch {
          // Logging must never break the session.
          resolve();
        }
      })
  );
}

export const AgentToolsLog = async ({ directory, project } = {}) => {
  const cwd = directory || project?.worktree || process.cwd();
  const assistantMessageIds = new Set();
  const lastAssistantText = new Map();

  return {
    "chat.message": async (_input, output) => {
      const message = output?.message;
      if (message?.role !== "user") return;
      const text = (output?.parts || [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
      if (!text.trim()) return;
      send({
        hook_event_name: "UserPromptSubmit",
        session_id: message.sessionID,
        cwd,
        prompt: text,
      });
    },
    "tool.execute.before": async (input, output) => {
      const tool = String(input?.tool || "");
      if (tool === "bash") return;
      const args = output?.args;
      if (!args || typeof args !== "object") return;
      // Forwarded so the hook can snapshot a baseline for the detailed diff;
      // tools whose args carry no file path (such as apply_patch) are simply
      // skipped there and their diff stays "unknown".
      send({
        hook_event_name: "PreToolUse",
        session_id: input?.sessionID,
        cwd,
        tool_name: tool === "write" ? "Write" : "Edit",
        tool_input: args,
      });
    },
    "tool.execute.after": async (input, output) => {
      const sessionId = input?.sessionID;
      const tool = String(input?.tool || "");
      if (tool === "bash") {
        send({
          hook_event_name: "PostToolUse",
          session_id: sessionId,
          cwd,
          tool_name: "Bash",
          tool_input: { command: String(input?.args?.command || "") },
        });
        return;
      }
      const files = output?.metadata?.files;
      if (!Array.isArray(files)) return;
      for (const file of files) {
        if (!file?.filePath) continue;
        send({
          hook_event_name: "PostToolUse",
          session_id: sessionId,
          cwd,
          tool_name: tool === "write" ? "Write" : "Edit",
          tool_input: { file_path: file.filePath },
        });
      }
    },
    event: async ({ event }) => {
      const type = event?.type;
      const properties = event?.properties || {};
      if (type === "message.updated") {
        if (properties.info?.role === "assistant") assistantMessageIds.add(properties.info.id);
        return;
      }
      if (type === "message.part.updated") {
        const part = properties.part;
        if (part?.type === "text" && assistantMessageIds.has(part.messageID)) {
          lastAssistantText.set(part.sessionID, String(part.text || ""));
        }
        return;
      }
      if (type === "session.idle") {
        send({
          hook_event_name: "Stop",
          session_id: properties.sessionID,
          cwd,
          last_assistant_message: lastAssistantText.get(properties.sessionID) || "",
        });
        // Cleared per turn: a cancelled or text-less next turn must not
        // inherit this turn's summary as its own result.
        lastAssistantText.delete(properties.sessionID);
        return;
      }
      if (type === "session.deleted") {
        lastAssistantText.delete(properties.sessionID);
      }
    },
  };
};
