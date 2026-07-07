#!/usr/bin/env node
// Cross-agent PreToolUse guard for Claude Code and Codex: blocks a small set of
// catastrophic shell commands. Rules live in ./guard-rules.mjs (shared with the
// opencode plugin); this file is just the stdin/stdout CLI wiring.
//
// Both agents share the same PreToolUse contract: read a JSON event on stdin,
// and to block, print
//   { "hookSpecificOutput": { "hookEventName": "PreToolUse",
//       "permissionDecision": "deny", "permissionDecisionReason": "..." } }
// on stdout (exit 0). To allow, print nothing and exit 0.
//
// Docs: https://code.claude.com/docs/en/hooks
//       https://developers.openai.com/codex/hooks
//
// Fails OPEN: any parsing/logic error allows the command, so a bug here never
// bricks the agent.

import { checkCommand } from "./guard-rules.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function deny(reason, command) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Blocked by agent-tooling guard: ${reason}. ` +
          `Command: ${String(command).trim().slice(0, 200)}`,
      },
    })
  );
}

async function main() {
  let data = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) data = JSON.parse(raw);
  } catch {
    return; // fail open
  }
  const command = data?.tool_input?.command;
  const reason = checkCommand(command);
  if (reason) deny(reason, command);
}

main();
