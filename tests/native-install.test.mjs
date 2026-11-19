import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

const install = fileURLToPath(new URL("../scripts/install.mjs", import.meta.url));
function run(args, home) {
  const result = spawnSync(process.execPath, [install, ...args], {
    env: { ...process.env, AGENT_TOOLS_HOME: home }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test("ZCode usage leaves hooks alone and log preserves existing comments and opt-out", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-zcode-install-"));
  const home = join(temp, "runtime with spaces");
  const file = join(temp, "config.json");
  const skills = join(temp, "skills");
  const existing = { type: "process", command: "user-command", args: [] };
  const original = { mcp: { servers: { user: { command: "user-server" } } }, hooks: { enabled: false, events: { Stop: [{ hooks: [existing] }] } } };
  const source = JSON.stringify(original, null, 2)
    .replace('"enabled": false', '// Keep hooks disabled.\n    "enabled": false')
    .replace('"Stop": [', '"Stop": [ // Keep the user hook.');
  writeFileSync(file, source);
  const args = ["-a", "zcode", "--zcode-config", file, "--zcode-skills-dir", skills];
  run(["usage", "log", ...args, "--dry-run"], home);
  assert.equal(existsSync(home), false);
  assert.equal(readFileSync(file, "utf8"), source);
  run(["usage", ...args], home);
  assert.equal(readFileSync(file, "utf8"), source);
  assert.match(run(["log", ...args], home).stdout, /Enable hooks in ZCode/);
  const first = readFileSync(file, "utf8");
  run(["usage", "log", ...args], home);
  assert.equal(readFileSync(file, "utf8"), first);
  const config = parseJsonc(first);
  assert.equal(config.hooks.enabled, false);
  assert.deepEqual(config.mcp, original.mcp);
  assert.equal(config.hooks.events.Stop.length, 2);
  assert.match(first, /\/\/ Keep hooks disabled\./);
  assert.match(first, /\/\/ Keep the user hook\./);
  assert.ok(existsSync(join(home, "dist", "log", "zcode-hook.mjs")));
  const marketplace = join(home, "dist", "usage", "zcode-marketplace");
  const catalog = JSON.parse(readFileSync(join(marketplace, "marketplace.json"), "utf8"));
  const plugin = join(marketplace, catalog.plugins[0].source);
  const manifest = JSON.parse(readFileSync(join(plugin, ".zcode-plugin", "plugin.json"), "utf8"));
  assert.ok(existsSync(join(plugin, manifest.extension.main)));
  assert.match(readFileSync(join(skills, "at-usage", "SKILL.md"), "utf8"), /--agent zcode/);
  run(["usage", ...args, "--uninstall"], home);
  assert.equal(readFileSync(file, "utf8"), first);
  run(["log", ...args, "--uninstall"], home);
  const remaining = readFileSync(file, "utf8");
  assert.deepEqual(parseJsonc(remaining), original);
  assert.match(remaining, /\/\/ Keep hooks disabled\./);
  assert.match(remaining, /\/\/ Keep the user hook\./);
});

test("ZCode log enables fresh hooks and removes its own toggle on uninstall", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-zcode-log-toggle-"));
  const home = join(temp, "runtime");
  const file = join(temp, "config.json");
  const args = ["log", "-a", "zcode", "--zcode-config", file];
  run(args, home);
  assert.equal(JSON.parse(readFileSync(file)).hooks.enabled, true);
  run([...args, "--uninstall"], home);
  assert.deepEqual(JSON.parse(readFileSync(file)), {});
});

test("ZCode finds the CLI beside a custom desktop executable without touching a conflicting marketplace", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-zcode-market-"));
  const home = join(temp, "runtime");
  const witness = join(temp, "calls.txt");
  const desktop = join(temp, "custom ZCode");
  const launcher = process.platform === "darwin" ? join(desktop, "Contents", "MacOS", "ZCode") :
    join(desktop, process.platform === "win32" ? "ZCode.exe" : "zcode");
  const resourceDir = process.platform === "darwin" ? join(desktop, "Contents", "Resources", "glm") :
    join(desktop, "resources", "glm");
  mkdirSync(resourceDir, { recursive: true });
  if (process.platform === "darwin") mkdirSync(join(desktop, "Contents", "MacOS"));
  writeFileSync(launcher, "desktop launcher, not a CLI");
  const cli = join(resourceDir, "zcode.cjs");
  writeFileSync(cli, `
    require("node:fs").appendFileSync(${JSON.stringify(witness)}, process.argv.slice(2).join(" ") + "\\n");
    console.log(JSON.stringify([{ id: "agent-tools-local", source: { source: "directory", path: ${JSON.stringify(join(temp, "unrelated"))} } }]));
  `);
  const args = ["usage", "-a", "zcode", "--zcode-cli", launcher,
    "--zcode-config", join(temp, "config.json"), "--zcode-skills-dir", join(temp, "skills")];
  const preview = run([...args, "--dry-run"], home).stdout;
  assert.ok(preview.includes(`would install agent-tools-usage@agent-tools-local using ${realpathSync(cli)}`));
  assert.equal(existsSync(witness), false);
  for (const phase of [args, [...args, "--uninstall"]]) {
    assert.match(run(phase, home).stderr, /marketplace already points to another source/);
  }
  assert.equal(readFileSync(witness, "utf8"), "plugins marketplace list --json\nplugins marketplace list --json\n");
});

test("DSH native usage and log rows preserve unrelated Cordis composition and each other", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-dsh-install-"));
  const home = join(temp, "runtime with spaces");
  const dsh = join(temp, "dsh");
  mkdirSync(dsh);
  const file = join(dsh, "cordis.patch.yml");
  const original = "- insert:\n    - id: user-plugin\n      name: user-plugin\n";
  writeFileSync(file, original);
  const args = ["-a", "dsh", "--dsh-home", dsh];
  run(["usage", "log", ...args, "--dry-run"], home);
  assert.equal(existsSync(home), false);
  assert.equal(readFileSync(file, "utf8"), original);
  run(["usage", "log", ...args], home);
  const first = readFileSync(file, "utf8");
  run(["usage", "log", ...args], home);
  assert.equal(readFileSync(file, "utf8"), first);
  assert.match(first, /agent-tools-usage/);
  assert.match(first, /agent-tools-log/);
  assert.match(first, /runtime%20with%20spaces/);
  assert.ok(existsSync(join(home, "dist", "usage", "dsh-plugin.mjs")));
  const usageDir = join(home, "dist", "usage");
  const manifest = JSON.parse(readFileSync(join(usageDir, "package.json"), "utf8"));
  assert.equal(manifest.dsh.client.platform, "web");
  assert.ok(existsSync(join(usageDir, manifest.exports["./client"])));
  assert.ok(existsSync(join(home, "dist", "log", "dsh-plugin.mjs")));
  assert.equal(existsSync(join(dsh, "skills", "at-usage")), false);
  run(["usage", ...args, "--uninstall"], home);
  const remaining = readFileSync(file, "utf8");
  assert.doesNotMatch(remaining, /agent-tools-usage/);
  assert.match(remaining, /agent-tools-log/);
  run(["log", ...args, "--uninstall"], home);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("DSH installs all capabilities together into a fresh or commented empty patch", () => {
  for (const initial of [null, "# Personal overrides\n[]\n"]) {
    const temp = mkdtempSync(join(tmpdir(), "agent-tools-dsh-fresh-"));
    const home = join(temp, "runtime");
    const dsh = join(temp, "dsh");
    const file = join(dsh, "cordis.patch.yml");
    if (initial) { mkdirSync(dsh); writeFileSync(file, initial); }
    const args = ["usage", "log", "vision", "-a", "dsh", "--dsh-home", dsh];
    run(args, home);
    const patch = readFileSync(file, "utf8");
    for (const capability of ["usage", "log", "vision"]) assert.ok(patch.includes(`id: agent-tools-${capability}`));
    assert.doesNotMatch(patch, /^\[\]/m);
    if (initial) assert.ok(patch.includes("# Personal overrides"));
    run(args, home);
    assert.equal(readFileSync(file, "utf8"), patch);
  }
});
