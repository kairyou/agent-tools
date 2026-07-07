import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_SCRIPT = join(ROOT, "scripts", "install.mjs");

function runInstall(args, env) {
  const result = spawnSync(process.execPath, [INSTALL_SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test("installer wires and unwires Codex usage without removing guard", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tooling-install-"));
  const runtime = join(temp, "runtime");
  const hooksFile = join(temp, "hooks.json");
  const env = { AGENT_TOOLING_HOME: runtime };

  runInstall(["guard", "usage", "-a", "codex", "--codex-hooks", hooksFile], env);
  const installed = JSON.parse(readFileSync(hooksFile, "utf8"));

  assert.equal(installed.hooks.PreToolUse.length, 1);
  assert.match(installed.hooks.PreToolUse[0].hooks[0].command, /guard-command\.mjs/);
  assert.equal(installed.hooks.UserPromptSubmit.length, 1);
  assert.match(installed.hooks.UserPromptSubmit[0].hooks[0].command, /usage\.mjs" hook$/);
  assert.equal(installed.hooks.Stop.length, 1);

  runInstall(["usage", "-a", "codex", "--codex-hooks", hooksFile, "--uninstall"], env);
  const afterUninstall = JSON.parse(readFileSync(hooksFile, "utf8"));

  assert.equal(afterUninstall.hooks.PreToolUse.length, 1);
  assert.equal(afterUninstall.hooks.UserPromptSubmit, undefined);
  assert.equal(afterUninstall.hooks.Stop, undefined);
});
