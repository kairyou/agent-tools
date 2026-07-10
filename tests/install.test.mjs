import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

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

function runInstallRaw(args, env) {
  return spawnSync(process.execPath, [INSTALL_SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("installer wires and unwires Codex usage without removing unrelated hooks", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-install-"));
  const runtime = join(temp, "runtime");
  const hooksFile = join(temp, "hooks.json");
  const env = { AGENT_TOOLS_HOME: runtime };
  const existingHook = {
    matcher: "^Bash$",
    hooks: [{ type: "command", command: "node user-hook.mjs" }],
  };
  writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [existingHook] } }));

  runInstall(["usage", "-a", "codex", "--codex-hooks", hooksFile], env);
  const installed = JSON.parse(readFileSync(hooksFile, "utf8"));

  assert.equal(installed.hooks.PreToolUse.length, 1);
  assert.deepEqual(installed.hooks.PreToolUse[0], existingHook);
  assert.equal(installed.hooks.UserPromptSubmit.length, 1);
  assert.match(installed.hooks.UserPromptSubmit[0].hooks[0].command, /\/hooks\/codex\/usage-hook\.mjs"$/);
  assert.equal(installed.hooks.Stop.length, 1);

  runInstall(["usage", "-a", "codex", "--codex-hooks", hooksFile, "--uninstall"], env);
  const afterUninstall = JSON.parse(readFileSync(hooksFile, "utf8"));

  assert.equal(afterUninstall.hooks.PreToolUse.length, 1);
  assert.deepEqual(afterUninstall.hooks.PreToolUse[0], existingHook);
  assert.equal(afterUninstall.hooks.UserPromptSubmit, undefined);
  assert.equal(afterUninstall.hooks.Stop, undefined);
});

test("installer rejects Claude usage as a standalone capability", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-install-"));
  const result = runInstallRaw(["usage", "-a", "claude", "--dry-run"], {
    AGENT_TOOLS_HOME: join(temp, "runtime"),
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unsupported capability\/agent combination: usage -a claude/);
  assert.match(result.stderr, /statusline -a claude/);
  assert.equal(result.stdout, "");
});

test("installer wires and unwires opencode usage plugins while preserving TUI config", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-install-"));
  const runtime = join(temp, "runtime");
  const configDir = join(temp, "opencode");
  const tuiFile = join(configDir, "tui.json");
  const env = { AGENT_TOOLS_HOME: runtime };
  mkdirSync(configDir, { recursive: true });
  writeFileSync(tuiFile, '// keep this comment\n{\n  "theme": "system",\n  "plugin": ["other-plugin"]\n}\n');

  runInstall(["usage", "-a", "opencode", "--opencode-config-dir", configDir], env);

  const stub = join(configDir, "plugins", "agent-tools-usage.js");
  const installedText = readFileSync(tuiFile, "utf8");
  const installed = parseJsonc(installedText);
  assert.equal(existsSync(stub), true);
  assert.match(readFileSync(stub, "utf8"), /plugins\/opencode\/usage-plugin\.mjs/);
  assert.equal(existsSync(join(runtime, "plugins", "opencode", "usage-plugin.mjs")), true);
  assert.equal(existsSync(join(runtime, "plugins", "opencode", "usage-tui.mjs")), true);
  assert.match(installedText, /keep this comment/);
  assert.equal(installed.theme, "system");
  assert.equal(installed.plugin[0], "other-plugin");
  assert.match(installed.plugin[1], /plugins\/opencode\/usage-tui\.mjs$/);

  runInstall([
    "usage",
    "-a",
    "opencode",
    "--opencode-config-dir",
    configDir,
    "--uninstall",
  ], env);

  const afterText = readFileSync(tuiFile, "utf8");
  const after = parseJsonc(afterText);
  assert.equal(existsSync(stub), false);
  assert.match(afterText, /keep this comment/);
  assert.deepEqual(after.plugin, ["other-plugin"]);
  assert.equal(after.theme, "system");
});
