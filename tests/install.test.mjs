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
  const skillsDir = join(temp, "skills");
  const env = { AGENT_TOOLS_HOME: runtime };
  const existingHook = {
    matcher: "^Bash$",
    hooks: [{ type: "command", command: "node user-hook.mjs" }],
  };
  writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [existingHook] } }));

  // A stale packaged route (removed from the repo) must not survive install.
  const staleRoute = join(runtime, "dist", "usage", "routes", "stale.mjs");
  mkdirSync(join(runtime, "dist", "usage", "routes"), { recursive: true });
  writeFileSync(staleRoute, "export async function run() {}\n");

  const args = [
    "usage",
    "-a",
    "codex",
    "--codex-hooks",
    hooksFile,
    "--codex-skills-dir",
    skillsDir,
  ];
  runInstall(args, env);
  assert.equal(existsSync(staleRoute), false);
  const installed = JSON.parse(readFileSync(hooksFile, "utf8"));

  assert.equal(installed.hooks.PreToolUse.length, 1);
  assert.deepEqual(installed.hooks.PreToolUse[0], existingHook);
  assert.equal(installed.hooks.UserPromptSubmit.length, 1);
  assert.match(installed.hooks.UserPromptSubmit[0].hooks[0].command, /\/dist\/usage\/codex-hook\.mjs" --silent$/);
  assert.equal(installed.hooks.UserPromptSubmit[0].hooks[0].statusMessage, undefined);
  assert.equal(installed.hooks.Stop.length, 1);
  assert.match(installed.hooks.Stop[0].hooks[0].command, /\/dist\/usage\/codex-hook\.mjs"$/);
  assert.equal(installed.hooks.Stop[0].hooks[0].statusMessage, undefined);
  const skillFile = join(skillsDir, "at-usage", "SKILL.md");
  const skill = readFileSync(skillFile, "utf8");
  assert.match(skill, /dist\/usage\/cli\.mjs" --agent codex/);
  assert.doesNotMatch(skill, /\{\{USAGE_/);
  assert.equal(existsSync(join(runtime, "dist", "usage", "cli.mjs")), true);

  runInstall([...args, "--uninstall"], env);
  const afterUninstall = JSON.parse(readFileSync(hooksFile, "utf8"));

  assert.equal(afterUninstall.hooks.PreToolUse.length, 1);
  assert.deepEqual(afterUninstall.hooks.PreToolUse[0], existingHook);
  assert.equal(afterUninstall.hooks.UserPromptSubmit, undefined);
  assert.equal(afterUninstall.hooks.Stop, undefined);
  assert.equal(existsSync(join(skillsDir, "at-usage")), false);
});

test("installer installs Claude usage as a managed local skill", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-install-"));
  const runtime = join(temp, "runtime with spaces");
  const skillsDir = join(temp, "skills");
  const args = ["usage", "-a", "claude", "--claude-skills-dir", skillsDir];
  const env = { AGENT_TOOLS_HOME: runtime };

  runInstall(args, env);
  const skillDir = join(skillsDir, "at-usage");
  const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  assert.match(skill, /node "[^"]*runtime with spaces\/dist\/usage\/cli\.mjs" --agent claude/);
  assert.match(skill, /Never run `npx`/);
  assert.equal(existsSync(join(skillDir, ".agent-tools-managed.json")), false);
  const state = JSON.parse(readFileSync(join(runtime, "install-state.json"), "utf8"));
  const managed = Object.values(state.artifacts);
  assert.equal(managed.length, 1);
  assert.equal(managed[0].capability, "usage");
  assert.match(managed[0].sha256, /^[a-f0-9]{64}$/);
  // Records which release wrote this layout, for diagnosing a later upgrade.
  const { version: packageVersion } = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8")
  );
  assert.equal(state.packageVersion, packageVersion);

  runInstall([...args, "--uninstall"], env);
  assert.equal(existsSync(skillDir), false);
  assert.equal(existsSync(join(runtime, "install-state.json")), false);
});

test("usage install refuses to overwrite an unmanaged skill", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-install-"));
  const skillsDir = join(temp, "skills");
  const skillDir = join(skillsDir, "at-usage");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "user-owned\n");

  const result = runInstallRaw(
    ["usage", "-a", "claude", "--claude-skills-dir", skillsDir],
    { AGENT_TOOLS_HOME: join(temp, "runtime") }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to overwrite existing unowned skill directory/);
  assert.equal(readFileSync(join(skillDir, "SKILL.md"), "utf8"), "user-owned\n");
});

test("usage install preserves a managed skill modified by the user", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-install-"));
  const runtime = join(temp, "runtime");
  const skillsDir = join(temp, "skills");
  const skillFile = join(skillsDir, "at-usage", "SKILL.md");
  const args = ["usage", "-a", "claude", "--claude-skills-dir", skillsDir];
  const env = { AGENT_TOOLS_HOME: runtime };
  runInstall(args, env);
  writeFileSync(skillFile, "user customization\n");

  const update = runInstallRaw(args, env);
  assert.equal(update.status, 1);
  assert.match(update.stderr, /Refusing to overwrite modified managed skill directory/);
  assert.equal(readFileSync(skillFile, "utf8"), "user customization\n");

  runInstall([...args, "--uninstall"], env);
  assert.equal(readFileSync(skillFile, "utf8"), "user customization\n");
  assert.equal(existsSync(join(runtime, "install-state.json")), false);
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
  assert.match(readFileSync(stub, "utf8"), /dist\/usage\/opencode-plugin\.mjs/);
  assert.equal(existsSync(join(runtime, "dist", "usage", "opencode-plugin.mjs")), true);
  assert.equal(existsSync(join(runtime, "dist", "usage", "opencode-tui.mjs")), true);
  assert.equal(existsSync(join(runtime, "dist", "usage", "cli.mjs")), true);
  assert.match(installedText, /keep this comment/);
  assert.equal(installed.theme, "system");
  assert.equal(installed.plugin[0], "other-plugin");
  assert.match(installed.plugin[1], /dist\/usage\/opencode-tui\.mjs$/);

  // Reinstall over a runtime config that uses comments and trailing commas:
  // user values, inline comments, and key order must survive; missing default
  // keys are added surgically.
  writeFileSync(
    join(runtime, "config.jsonc"),
    '// keep\n{\n  "custom": true,\n  "providerUsage": { "preset": "sub2api", }, // my relay\n}\n'
  );
  runInstall(["usage", "-a", "opencode", "--opencode-config-dir", configDir], env);
  const mergedCfg = readFileSync(join(runtime, "config.jsonc"), "utf8");
  assert.match(mergedCfg, /^\/\/ keep/);
  assert.match(mergedCfg, /"custom": true/);
  assert.match(mergedCfg, /"preset": "sub2api"/);
  assert.match(mergedCfg, /\/\/ my relay/);
  assert.match(mergedCfg, /"days": 30/);

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
