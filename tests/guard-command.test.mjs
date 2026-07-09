import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { checkCommand } from "../hooks/common/guard-rules.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_SCRIPT = join(ROOT, "hooks", "common", "guard-command.mjs");

test("guard rules block catastrophic shell commands", () => {
  assert.equal(checkCommand("rm -rf /"), "recursive force-remove of a root/home path");
  assert.equal(
    checkCommand("Remove-Item -Recurse -Force C:\\"),
    "recursive force-remove of a Windows drive root or home"
  );
  assert.equal(checkCommand("format C:"), "formatting a Windows drive");
});

test("guard rules allow ordinary scoped commands", () => {
  assert.equal(checkCommand("rm -rf ./dist"), null);
  assert.equal(checkCommand("Remove-Item -Recurse -Force .\\dist"), null);
  assert.equal(checkCommand("git status --short"), null);
});

test("guard command emits a Codex/Claude deny payload when blocked", () => {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT], {
    input: JSON.stringify({ tool_input: { command: "rm -rf /" } }),
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(payload.hookSpecificOutput.permissionDecision, "deny");
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /Blocked by agent-tools guard/);
});

test("guard command fails open for malformed input", () => {
  const result = spawnSync(process.execPath, [GUARD_SCRIPT], {
    input: "{not json",
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});
