import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function mockCodexVersion(home, version) {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(join(bin, "codex.cmd"), `@echo codex-cli ${version}\r\n`);
  } else {
    writeFileSync(join(bin, "codex"), `#!/bin/sh\necho codex-cli ${version}\n`, { mode: 0o755 });
  }
  return { PATH: bin };
}

for (const capability of ["usage", "log"]) test(`Pi ${capability} install, update, dry-run and uninstall preserve other extensions`, () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-pi-install-"));
  const home = join(temp, "runtime with spaces");
  const agentDir = join(temp, "pi agent");
  const env = { AGENT_TOOLS_HOME: home };
  const args = [capability, "-a", "pi", "--pi-agent-dir", agentDir];
  const stub = join(agentDir, "extensions", `agent-tools-${capability}.js`);
  runInstall([...args, "--dry-run"], env);
  assert.equal(existsSync(home), false);
  assert.equal(existsSync(agentDir), false);
  runInstall(args, env);
  const original = readFileSync(stub, "utf8");
  assert.ok(original.includes(`dist/${capability}/pi-extension.mjs`));
  assert.match(original, /runtime%20with%20spaces/);
  assert.ok(existsSync(join(home, "dist", capability, "pi-extension.mjs")));
  assert.ok(existsSync(join(home, "dist", capability, capability === "usage" ? "core.mjs" : "hook.mjs")));
  const other = join(agentDir, "extensions", "other.js");
  writeFileSync(other, "// user extension\n");
  runInstall(args, env);
  assert.equal(readFileSync(stub, "utf8"), original);
  runInstall([...args, "--uninstall", "--dry-run"], env);
  assert.ok(existsSync(stub));
  runInstall([...args, "--uninstall"], env);
  assert.equal(existsSync(stub), false);
  assert.equal(readFileSync(other, "utf8"), "// user extension\n");
  writeFileSync(stub, "// user-owned usage extension\n");
  const conflict = runInstallRaw(args, env);
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /unmanaged Pi extension/);
  runInstall([...args, "--uninstall"], env);
  assert.equal(readFileSync(stub, "utf8"), "// user-owned usage extension\n");
});

for (const [agent, settingsKey] of [["copilot", "COPILOT_HOME"], ["qwen", "QWEN_HOME"]]) {
  test(`${agent} usage installs a footer and preserves existing settings`, (t) => {
    const home = mkdtempSync(join(tmpdir(), `agent-tools-${agent}-`));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const runtime = join(home, "runtime with spaces");
    const settings = join(home, "settings.json");
    const env = { AGENT_TOOLS_HOME: runtime, [settingsKey]: home };
    const args = ["usage", "-a", agent];
    const original = agent === "copilot" ? { footer: { showBranch: false } } : { ui: { hideContextIndicator: true } };
    writeFileSync(settings, "// keep comment\n" + JSON.stringify(original, null, 2) + "\n");
    const read = () => readFileSync(settings, "utf8");
    const prior = read();
    runInstall([...args, "--dry-run"], env);
    assert.equal(read(), prior);
    assert.equal(existsSync(runtime), false);

    runInstall(args, env);
    const installed = read();
    assert.match(installed, /\/\/ keep comment/);
    const config = parseJsonc(installed);
    const owner = agent === "copilot" ? config : config.ui;
    assert.equal(owner.statusLine.type, "command");
    assert.ok(owner.statusLine.command.endsWith(`/dist/usage/${agent}-statusline.mjs"`));
    assert.ok(existsSync(join(runtime, "dist", "usage", `${agent}-statusline.mjs`)));
    runInstall(args, env);
    assert.equal(read(), installed);
    runInstall([...args, "--uninstall"], env);
    assert.deepEqual(parseJsonc(read()), original);
    assert.match(read(), /\/\/ keep comment/);

    owner.statusLine = agent === "copilot" ? { type: "command", command: "user-command" } : { type: "preset", items: ["git-branch"] };
    const customized = JSON.stringify(config, null, 2) + "\n";
    writeFileSync(settings, customized);
    runInstall(args, env);
    runInstall([...args, "--uninstall"], env);
    assert.equal(read(), customized);
  });
}

test("Codex usage follows the CLI version while preserving other hooks", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-tools-codex-statusline-"));
  const runtime = join(home, "runtime");
  const config = join(home, "config.toml");
  const hooks = join(home, "hooks.json");
  const original = '[tui]\nstatus_line = ["model", "context-remaining"]\n\n[model_providers.relay]\nenv_key = "RELAY_KEY"\n';
  const external = { hooks: [{ type: "command", command: "user-hook" }] };
  writeFileSync(config, original);
  writeFileSync(hooks, JSON.stringify({ hooks: { Stop: [external] } }));
  const args = ["usage", "-a", "codex", "--codex-config", config, "--codex-skills-dir", join(home, "skills")];
  const env = { AGENT_TOOLS_HOME: runtime, ...mockCodexVersion(home, "0.170.0") };
  runInstall(args, env);
  assert.equal(JSON.parse(readFileSync(hooks, "utf8")).hooks.Stop.length, 2);

  mockCodexVersion(home, "0.171.0");
  runInstall([...args, "--dry-run"], env);
  assert.equal(readFileSync(config, "utf8"), original);
  runInstall(args, env);
  const registered = readFileSync(config, "utf8");
  assert.match(registered, /^features\.tui_extensions_statusline = true$/m);
  assert.match(registered, /^\[tui\]\nstatus_line_provider = \{ server = "agent-tools-codex-statusline", tool = "statusline" \}\nstatus_line = \["model", "context-remaining"\]$/m);
  assert.ok(registered.includes('[model_providers.relay]\nenv_key = "RELAY_KEY"\n'));
  assert.match(registered, /\[mcp_servers\.agent-tools-codex-statusline\]/);
  assert.match(registered, /^env_vars = \["OPENAI_BASE_URL","OPENAI_API_KEY","PROVIDER_USAGE_BASE_URL","PROVIDER_USAGE_API_KEY","SUB2API_BASE_URL","SUB2API_API_KEY","RELAY_KEY"\]$/m);
  assert.ok(existsSync(join(runtime, "dist", "statusline", "codex-statusline.mjs")));
  assert.deepEqual(JSON.parse(readFileSync(hooks, "utf8")).hooks, { Stop: [external] });
  runInstall(args, env);
  assert.equal(readFileSync(config, "utf8"), registered);

  mockCodexVersion(home, "0.170.0");
  runInstall(args, env);
  assert.equal(readFileSync(config, "utf8").trimEnd(), original.trimEnd());
  assert.equal(JSON.parse(readFileSync(hooks, "utf8")).hooks.Stop.length, 2);
  mockCodexVersion(home, "0.172.0");
  runInstall(args, env);
  assert.match(readFileSync(config, "utf8"), /\[mcp_servers\.agent-tools-codex-statusline\]/);
  runInstall([...args, "--uninstall"], env);
  assert.equal(readFileSync(config, "utf8").trimEnd(), original.trimEnd());
  assert.deepEqual(JSON.parse(readFileSync(hooks, "utf8")).hooks, { Stop: [external] });
});

test("Codex preserves the native footer if it contains unsupported fields", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-tools-codex-statusline-fields-"));
  const config = join(home, "config.toml");
  const hooks = join(home, "hooks.json");
  const env = { AGENT_TOOLS_HOME: join(home, "runtime"), ...mockCodexVersion(home, "0.171.0") };
  const args = ["usage", "-a", "codex", "--codex-config", config, "--codex-skills-dir", join(home, "skills")];
  const original = '[tui]\nstatus_line = ["model", "total-input-tokens", "pull-request-number"] # keep\n';
  writeFileSync(config, original);
  runInstall(args, env);
  assert.equal(readFileSync(config, "utf8"), original);
  assert.equal(JSON.parse(readFileSync(hooks, "utf8")).hooks.Stop.length, 1);

  writeFileSync(config, original.replace(', "pull-request-number"', ""));
  runInstall(args, env);
  const installed = readFileSync(config, "utf8");
  assert.match(installed, /status_line_provider = \{ server = "agent-tools-codex-statusline"/);
  assert.equal(existsSync(hooks), false);

  // A subsequent install must also preserve fields selected after enabling our footer.
  writeFileSync(config, installed.replace('"total-input-tokens"]', '"total-input-tokens", "pull-request-number"]'));
  runInstall(args, env);
  assert.equal(readFileSync(config, "utf8").trimEnd(), original.trimEnd());
  assert.equal(JSON.parse(readFileSync(hooks, "utf8")).hooks.Stop.length, 1);
});

for (const [label, original, installed] of [
  ["inline tables",
    'features = { tui_extensions_statusline = false, other = true } # flags\ntui = { status_line_provider = "default", status_line = ["model"] } # display\n',
    'features = { tui_extensions_statusline = true, other = true } # flags\ntui = { status_line_provider = { server = "agent-tools-codex-statusline", tool = "statusline" }, status_line = ["model"] } # display\n'],
  ["named tables",
    '[features]\ntui_extensions_statusline = false # user setting\n\n[tui]\nstatus_line_provider = "default" # keep this comment\n',
    '[features]\ntui_extensions_statusline = true # user setting\n\n[tui]\nstatus_line_provider = { server = "agent-tools-codex-statusline", tool = "statusline" } # keep this comment\n'],
]) test(`Codex status line install restores preferences in ${label} and preserves later provider choices`, () => {
  const home = mkdtempSync(join(tmpdir(), "agent-tools-codex-statusline-config-"));
  const config = join(home, "config.toml");
  const env = { AGENT_TOOLS_HOME: join(home, "runtime"), ...mockCodexVersion(home, "0.171.0") };
  const args = ["usage", "-a", "codex", "--codex-config", config, "--codex-skills-dir", join(home, "skills")];
  writeFileSync(config, original);
  runInstall(args, env);
  const configured = readFileSync(config, "utf8");
  assert.ok(configured.startsWith(installed), configured);
  runInstall(args, env);
  runInstall([...args, "--uninstall"], env);
  assert.equal(readFileSync(config, "utf8").trimEnd(), original.trimEnd());

  runInstall(args, env);
  const changed = readFileSync(config, "utf8").replace('server = "agent-tools-codex-statusline"', 'server = "another-provider"');
  writeFileSync(config, changed);
  runInstall([...args, "--uninstall"], env);
  const after = readFileSync(config, "utf8");
  assert.equal(after.trimEnd(), installed.replace('server = "agent-tools-codex-statusline"', 'server = "another-provider"').trimEnd());
  runInstall(args, env);
  assert.equal(readFileSync(config, "utf8"), after);
  assert.equal(JSON.parse(readFileSync(join(home, "hooks.json"), "utf8")).hooks.Stop.length, 1);
});

test("installer wires and unwires Codex usage without removing unrelated hooks", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-install-"));
  const runtime = join(temp, "runtime");
  const hooksFile = join(temp, "hooks.json");
  const skillsDir = join(temp, "skills");
  const env = { AGENT_TOOLS_HOME: runtime, PATH: temp };
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
  assert.equal(existsSync(join(temp, "config.toml")), false);
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
