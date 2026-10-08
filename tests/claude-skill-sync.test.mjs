import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { CURRENT_FILE, ROOT, readJson, sha256, compareSnapshots, discoverLatestVersion, writePending } from "../tools/claude-skill-sync/lib.mjs";
import { renderSkills } from "../tools/claude-skill-sync/render.mjs";
import { SKILLS } from "../tools/claude-skill-sync/manifest.mjs";

test("official snapshot reproduces both installable skills offline", () => {
  const snapshot = readJson(CURRENT_FILE);
  assert.equal(snapshot.source.version, snapshot.claudeCodeVersion);
  assert.equal(snapshot.source.package, "@anthropic-ai/claude-code-linux-x64");
  for (const [name, text] of Object.entries(renderSkills(snapshot))) {
    assert.equal(fs.readFileSync(path.join(ROOT, SKILLS[name].target), "utf8"), text);
  }
});

test("portable output and opt-in fixes retain their behavior", () => {
  const review = renderSkills(readJson(CURRENT_FILE))["at-review"];
  assert.match(review, /main agent's final answer is a Markdown report/);
  assert.match(review, /Only when `--json` was explicitly passed/);
  assert.match(review, /Only apply anything when `--fix` was passed/);
  assert.match(review, /AGENTS\.md or CLAUDE\.md/);
  assert.match(review, /host-specific findings-reporting/);
  assert.match(review, /perform each angle/);
  assert.doesNotMatch(review, /ReportFindings|\$\{/);
});

test("hosted review target guidance stays read-only and supports private-host fallbacks", () => {
  const reference = fs.readFileSync(
    path.join(ROOT, "skills/workflow/at-review/references/review-targets.md"),
    "utf8"
  );
  assert.match(reference, /GitHub commonly exposes/);
  assert.match(reference, /GitLab commonly exposes/);
  assert.match(reference, /pasted\s+private URL does not grant access/);
  assert.match(reference, /Do not comment, approve, merge/);
  assert.match(reference, /Do not run checkout commands/);
  assert.match(reference, /Do not guess that the default branch/);
});


test("official prose changes trigger review and reach generated skills", () => {
  const current = readJson(CURRENT_FILE);
  for (const name of ["review", "fixes", "simplify"]) {
    const pending = structuredClone(current);
    pending.texts[name].text += "\n\nNew upstream instruction.";
    pending.texts[name].sha256 = sha256(pending.texts[name].text);
    assert.deepEqual(compareSnapshots(current, pending).map((entry) => entry.name), [name]);
    assert.match(renderSkills(pending)[name === "simplify" ? "at-simplify" : "at-review"], /New upstream instruction/);
  }
  const pending = structuredClone(current);
  const output = current.texts.output.text;
  pending.texts.output.text += "\nNew output instruction.";
  pending.texts.review.text = pending.texts.review.text.replace(output, pending.texts.output.text);
  for (const name of ["review", "output"]) pending.texts[name].sha256 = sha256(pending.texts[name].text);
  assert.match(renderSkills(pending)["at-review"], /New output instruction/);
});

test("unchanged content does not create version-only updates", () => {
  const current = readJson(CURRENT_FILE);
  const pending = structuredClone(current);
  pending.claudeCodeVersion = pending.source.version = "9.9.9";
  pending.source.bundleSha256 = "changed";
  assert.deepEqual(compareSnapshots(current, pending), []);
});

test("a successful unchanged fetch removes an older candidate without changing the accepted snapshot", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "skill-pending-test-"));
  try {
    const current = readJson(CURRENT_FILE);
    const accepted = JSON.stringify(current);
    fs.writeFileSync(path.join(directory, "current.json"), accepted);
    const changed = structuredClone(current);
    changed.texts.review.text += " changed";
    changed.texts.review.sha256 = sha256(changed.texts.review.text);
    assert.equal(writePending(changed, directory).wrote, true);
    assert.ok(fs.existsSync(path.join(directory, "pending.json")));
    assert.equal(writePending(current, directory).wrote, false);
    assert.ok(!fs.existsSync(path.join(directory, "pending.json")));
    assert.ok(!fs.existsSync(path.join(directory, "pending-report.md")));
    assert.equal(fs.readFileSync(path.join(directory, "current.json"), "utf8"), accepted);
  } finally {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(!path.isAbsolute(relative) && relative.startsWith("skill-pending-test-") && !relative.includes(path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid content and ambiguous output cannot generate a candidate", () => {
  for (const mutate of [
    (s) => { s.source.version = "0.0.0"; },
    (s) => { delete s.texts.fixes; },
    (s) => { s.texts.review.text += "unverified"; },
    (s) => { s.texts.review.text += s.texts.output.text; s.texts.review.sha256 = sha256(s.texts.review.text); },
  ]) {
    const snapshot = readJson(CURRENT_FILE); mutate(snapshot);
    assert.throws(() => renderSkills(snapshot), /mismatch|Invalid official content|exactly once/);
  }
});

test("version discovery uses npm directly and rejects invalid metadata", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), "https://registry.npmjs.org/@anthropic-ai/claude-code/latest");
      return new Response(JSON.stringify({ version: "9.9.9" }));
    };
    assert.equal(await discoverLatestVersion(), "9.9.9");
    globalThis.fetch = async () => new Response(JSON.stringify({ version: "invalid" }));
    await assert.rejects(discoverLatestVersion, /invalid Claude Code version/);
  } finally { globalThis.fetch = originalFetch; }
});
