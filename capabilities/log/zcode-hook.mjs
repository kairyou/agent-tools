#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export function zcodeLogInput(input) {
  const event = input.hook_event_name || input.hookEventName;
  const sessionId = input.session_id || input.sessionId;
  if (!sessionId || !["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].includes(event)) return null;
  return {
    hook_event_name: event,
    session_id: `zcode:${sessionId}`,
    cwd: input.cwd,
    prompt: input.prompt,
    tool_name: input.tool_name || input.toolName,
    tool_input: input.tool_input || input.toolInput,
    last_assistant_message: input.last_assistant_message ?? input.responseText ?? input.responsePreview ?? "",
  };
}

async function main() {
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const payload = zcodeLogInput(JSON.parse(raw));
    if (!payload) return;
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./hook.mjs", import.meta.url))], {
        stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
      });
      child.on("error", resolve);
      child.on("close", resolve);
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(payload));
    });
  } catch { /* Logging must not interrupt a ZCode session. */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
