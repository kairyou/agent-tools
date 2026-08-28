import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
