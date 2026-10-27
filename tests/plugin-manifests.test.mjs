import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGE = json("package.json");
const SKILL_DIRS = [
  "skills/workflow/at-commit",
  "skills/workflow/at-daily-log",
  "skills/workflow/at-review",
  "skills/workflow/at-self-eval",
  "skills/workflow/at-simplify",
  "skills/systems/at-zentao",
];

function json(file) {
  return JSON.parse(readFileSync(resolve(ROOT, file), "utf8"));
}

test("plugin manifests track the package version", () => {
  for (const file of [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".zcode-plugin/plugin.json",
  ]) {
    const manifest = json(file);
    assert.equal(manifest.name, "agent-tools", file);
    assert.equal(manifest.version, PACKAGE.version, file);
  }
});

test("npm version commits and tags synchronized plugin manifests", () => {
  const cwd = mkdtempSync(join(tmpdir(), "at-version-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Release Test",
    GIT_AUTHOR_EMAIL: "release@example.test",
    GIT_COMMITTER_NAME: "Release Test",
    GIT_COMMITTER_EMAIL: "release@example.test",
  };
  function run(command, args) {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    return result.stdout;
  }
  mkdirSync(join(cwd, "scripts"));
  copyFileSync(join(ROOT, "scripts", "sync-plugin-version.mjs"), join(cwd, "scripts", "sync-plugin-version.mjs"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({
    name: "release-test", version: "1.0.0", type: "module", scripts: { version: PACKAGE.scripts.version },
  }));
  const files = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".zcode-plugin/plugin.json"];
  for (const file of files) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), JSON.stringify({ name: "agent-tools", version: "1.0.0" }));
  }
  run("git", ["init"]);
  run("git", ["add", "."]);
  run("git", ["commit", "-m", "chore: initialize release fixture"]);
  const npmCli = process.env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  run(process.execPath, [npmCli, "version", "minor", "--tag-version-prefix=v"]);
  assert.equal(run("git", ["status", "--porcelain"]).trim(), "");
  for (const file of files) {
    assert.equal(JSON.parse(run("git", ["show", `v1.1.0:${file}`])).version, "1.1.0", file);
  }
});

test("Claude and ZCode manifests expose every standalone skill", () => {
  for (const file of [".claude-plugin/plugin.json", ".zcode-plugin/plugin.json"]) {
    const skills = json(file).skills.map((entry) => entry.replace(/^\.\//, ""));
    assert.deepEqual(skills, SKILL_DIRS, file);
    for (const skill of skills) {
      const document = readFileSync(resolve(ROOT, skill, "SKILL.md"), "utf8");
      assert.match(document, /^---\r?\nname: [a-z0-9-]+\r?\ndescription: .+/s, skill);
    }
  }
});
