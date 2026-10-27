// Translate Pi's session events into the shared log recorder's hook contract.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("./hook.mjs", import.meta.url));

function sendToRecorder(payload) {
  return new Promise((resolve) => {
    try {
      const child = spawn("node", [HOOK], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      child.on("error", resolve);
      child.on("close", resolve);
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(payload));
    } catch {
      resolve();
    }
  });
}

function textContent(message) {
  if (typeof message?.content === "string") return message.content;
  return (message?.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function createPiLogExtension({ send = sendToRecorder } = {}) {
  return function agentToolsLog(pi) {
    let queue = Promise.resolve();
    let turn = null;

    function record(event, fields = {}) {
      const payload = {
        hook_event_name: event,
        session_id: turn.sessionId,
        cwd: turn.cwd,
        ...fields,
      };
      // Await baseline snapshots before Pi mutates files. Serialize all other
      // events too so the recorder sees prompts, tools and outcomes in order.
      queue = queue.then(() => send(payload)).catch(() => {});
      return queue;
    }

    function currentTurn(ctx) {
      return turn?.sessionId === `pi:${ctx.sessionManager.getSessionId()}`;
    }

    pi.on("session_start", async () => {
      turn = null;
      await queue;
    });
    pi.on("message_start", async (event, ctx) => {
      if (event.message.role === "user") {
        if (currentTurn(ctx) && turn.outcome) {
          await record("Stop", { last_assistant_message: turn.outcome });
        }
        turn = {
          sessionId: `pi:${ctx.sessionManager.getSessionId()}`,
          cwd: ctx.cwd,
          outcome: "",
        };
        await record("UserPromptSubmit", { prompt: textContent(event.message) });
      } else if (event.message.role === "assistant" && currentTurn(ctx)) {
        turn.outcome = "";
      }
    });
    pi.on("message_end", (event, ctx) => {
      if (currentTurn(ctx) && event.message.role === "assistant") {
        turn.outcome = event.message.stopReason === "stop" ? textContent(event.message) : "";
      }
    });
    pi.on("tool_call", async (event, ctx) => {
      if (!currentTurn(ctx) || !["write", "edit"].includes(event.toolName)) return;
      await record("PreToolUse", {
        tool_name: event.toolName === "write" ? "Write" : "Edit",
        tool_input: event.input,
      });
    });
    pi.on("tool_result", async (event, ctx) => {
      if (!currentTurn(ctx) || event.isError) return;
      const toolName = { write: "Write", edit: "Edit", bash: "Bash", powershell: "Bash" }[event.toolName];
      if (!toolName) return;
      await record("PostToolUse", { tool_name: toolName, tool_input: event.input });
    });
    pi.on("agent_settled", async (event, ctx) => {
      if (!currentTurn(ctx)) return;
      await record("Stop", { last_assistant_message: event.aborted ? "" : turn.outcome });
      turn = null;
    });
    pi.on("session_shutdown", async () => {
      // Do not turn a partial response into a completed outcome on exit/reload.
      turn = null;
      await queue;
    });
  };
}

export default createPiLogExtension();
