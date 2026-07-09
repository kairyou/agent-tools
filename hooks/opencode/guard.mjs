// opencode plugin: blocks catastrophic shell commands (agent-tools guard).
//
// This is opencode's equivalent of the Claude/Codex PreToolUse guard. opencode
// has no declarative hook config — extensions are JS/TS plugins — so the shared
// deny-list lives in ../common/guard-rules.mjs and this thin plugin throws to
// block a matching `bash` command.
//
// Wiring: scripts/install.mjs copies this file plus the shared rules into the
// user runtime directory, then drops an opencode plugin stub that re-exports it.
//
// Docs: https://opencode.ai/docs/plugins
//
// Known gap: opencode's tool.execute.before does NOT intercept tool calls made
// by subagents spawned via the `task` tool (opencode issue #5894). This guard
// cannot cover those until opencode fixes it.

import { checkCommand } from "../common/guard-rules.mjs";

export const AgentToolsGuard = async () => ({
  "tool.execute.before": async (input, output) => {
    if (input?.tool !== "bash") return;
    const reason = checkCommand(output?.args?.command);
    if (reason) {
      throw new Error(`Blocked by agent-tools guard: ${reason}`);
    }
  },
});
