import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  CURRENT_FILE,
  MirrorPendingError,
  ROOT,
  compareVersions,
  compareSnapshots,
  discoverLatestMirrorVersion,
  fetchUpstream,
  readJson,
  reconstructPrompt,
} from "../tools/claude-skill-sync/lib.mjs";
import { SKILLS } from "../tools/claude-skill-sync/manifest.mjs";
import { renderSkills } from "../tools/claude-skill-sync/render.mjs";

test("reconstructPrompt restores extracted source escapes and expressions", () => {
  const prompt = {
    id: "example",
    pieces: ["Use \\`tool\\` with ${", "(10)}"],
    identifiers: [0],
    identifierMap: { 0: "OUTPUT_FORMAT_FN" },
  };
  assert.equal(reconstructPrompt(prompt), "Use `tool` with ${OUTPUT_FORMAT_FN(10)}");
});

test("missing versioned prompt JSON is classified as mirror pending", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("registry.npmjs.org")) {
      return new Response(JSON.stringify({ version: "9.9.9" }));
    }
    if (String(url).includes("api.github.com")) {
      return new Response(JSON.stringify({ sha: "abc123" }));
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };
  try {
    await assert.rejects(() => fetchUpstream("9.9.9"), MirrorPendingError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mirror discovery selects the newest version not newer than npm", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/commits/main")) {
      return new Response(JSON.stringify({ sha: "abc123" }));
    }
    return new Response(
      JSON.stringify([
        { name: "prompts-2.1.222.json" },
        { name: "prompts-2.1.223.json" },
        { name: "prompts-2.1.225.json" },
        { name: "README.md" },
      ])
    );
  };
  try {
    assert.deepEqual(await discoverLatestMirrorVersion("2.1.224"), {
      version: "2.1.223",
      commit: "abc123",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("semantic version comparison is numeric", () => {
  assert.ok(compareVersions("2.1.100", "2.1.99") > 0);
  assert.equal(compareVersions("2.1.223", "2.1.223"), 0);
});

test("accepted Claude prompt snapshot reproduces the installable skills", () => {
  const snapshot = readJson(CURRENT_FILE);
  const generated = renderSkills(snapshot);
  for (const [name, content] of Object.entries(generated)) {
    assert.equal(fs.readFileSync(path.join(ROOT, SKILLS[name].target), "utf8"), content);
  }
});

test("portable review excludes monitored Claude-only routing", () => {
  const review = renderSkills(readJson(CURRENT_FILE))["at-review"];
  assert.match(review, /host-specific findings-reporting tool/);
  assert.match(review, /main agent's final answer is a Markdown report/);
  assert.match(review, /1\. High\|Medium\|Low: summary/);
  assert.match(review, /Only when `--json` was explicitly passed/);
  assert.ok(review.indexOf("Markdown report") < review.indexOf("### JSON mode"));
  assert.match(review, /"failure_scenario": "concrete inputs\/state → wrong output\/crash"/);
  assert.match(review, /AGENTS\.md or CLAUDE\.md/);
  assert.match(review, /Only apply anything when `--fix` was passed/);
  assert.doesNotMatch(review, /GitHub comment|workflow-backed|publish an artifact|ReportFindings/);
  assert.doesNotMatch(review, /Agent tool is not available|single-pass inline/);
});

test("manifest targets stay inside the two workflow skill directories", () => {
  assert.deepEqual(
    Object.values(SKILLS).map(({ target }) => target).sort(),
    [
      "skills/workflow/at-review/SKILL.md",
      "skills/workflow/at-simplify/SKILL.md",
    ]
  );
});

test("snapshot comparison reports monitored prompt changes", () => {
  const current = readJson(CURRENT_FILE);
  const pending = structuredClone(current);
  const monitored = pending.prompts.find(
    ({ id }) => id === "agent-prompt-code-review-part-8-github-comment-posting"
  );
  monitored.pieces[0] += " changed";
  const changes = compareSnapshots(current, pending);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].use, []);
  assert.deepEqual(changes[0].monitoredBy, ["at-review"]);
});

test("renderer fails closed when an expected patch anchor changes", () => {
  const snapshot = readJson(CURRENT_FILE);
  const changed = structuredClone(snapshot);
  const root = changed.prompts.find(
    ({ id }) => id === "agent-prompt-code-review-part-7-high-effort-mode"
  );
  root.pieces = root.pieces.map((piece) => piece.replace("via the ${", "through the ${"));
  assert.throws(() => renderSkills(changed), /at-review\/agent-tool expected 2 matches/);
});
