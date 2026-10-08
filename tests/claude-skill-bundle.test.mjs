import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { extractOfficialSkills } from "../tools/claude-skill-sync/bundle.mjs";
import { fetchOfficialSnapshot, OFFICIAL_PACKAGE } from "../tools/claude-skill-sync/official.mjs";

const fixture = fs.readFileSync(new URL("./fixtures/claude-skill-bundle.txt", import.meta.url), "utf8")
  .replace("// MODULE", "\0");
const extract = (text = fixture) => extractOfficialSkills(Buffer.from(text));
const digest = (value, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(value).digest(encoding);

test("official command graph selects high effort, Agent, JSON, and fixes without runtime execution", () => {
  const result = extract();
  assert.deepEqual(result.selection, { effort: "high", agentAvailable: true, hostReporting: false, maxFindings: 10 });
  assert.match(result.texts.review.text, /High review via the Agent tool/);
  assert.match(result.texts.output.text, /10 findings/);
  assert.match(result.texts.fixes.text, /Summarize fixes/);
  assert.match(result.texts.simplify.text, /Reuse original/);
  assert.doesNotMatch(JSON.stringify(result.texts), /Wrong|Runtime must not execute/);
});

test("renamed symbols, moved modules, and changed fragment prose need no metadata mirror", () => {
  let changed = fixture;
  for (const name of ["reuse", "simplification", "altitude", "high", "route", "reviewCommand", "Agent", "agentCheck", "hostCheck"]) {
    changed = changed.replaceAll(new RegExp(`\\b${name}\\b`, "g"), `renamed_${name}`);
  }
  // The selected effort label is an interface value, not a minified identifier.
  changed = changed.replaceAll('"renamed_high"', '"high"');
  changed = changed.replaceAll("/bundle/runtime.js", "/other/renamed-chunk.js")
    .replaceAll("Reuse original", "Entirely rewritten reuse guidance")
    .replaceAll("Altitude original", "Entirely rewritten altitude guidance");
  const result = extract(changed);
  for (const name of ["review", "simplify"]) {
    assert.match(result.texts[name].text, /Entirely rewritten reuse guidance/);
    assert.match(result.texts[name].text, /Entirely rewritten altitude guidance/);
  }
});

test("unknown selected code, missing commands and ambiguous imports fail closed", () => {
  for (const changed of [
    fixture.replace('reuse="Reuse original"', 'reuse=process.env.SECRET'),
    fixture.replace('reuse="Reuse original"', 'reuse=(()=>globalThis)()'),
    fixture.replace('reuse="Reuse original"', 'reuse=new Function("return 1")()'),
    fixture.replace('const cleanup=', 'reuse="changed later";const cleanup='),
    fixture.replace('reviewName="code-review"', 'reviewName="other-command"'),
    `${fixture}\0${fixture.split("\0")[0]}`,
  ]) assert.throws(() => extract(changed));
});

test("unsupported old package layout produces an explicit extraction error", () => {
  assert.throws(() => extract("old monolithic binary layout"), /No embedded JavaScript modules/);
});

test("official download validates version and integrity and records provenance", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "official-test-"));
  const originalFetch = globalThis.fetch;
  try {
    fs.mkdirSync(path.join(directory, "package"));
    fs.writeFileSync(path.join(directory, "package", "claude"), fixture);
    execFileSync("tar", ["-czf", "fixture.tgz", "package/claude"], { cwd: directory, windowsHide: true });
    const archive = fs.readFileSync(path.join(directory, "fixture.tgz"));
    const metadata = { name: OFFICIAL_PACKAGE, version: "9.9.9", dist: {
      tarball: "https://registry.npmjs.org/fixture.tgz", integrity: `sha512-${digest(archive, "sha512", "base64")}`,
    } };
    globalThis.fetch = async (url) => {
      assert.equal(new URL(url).hostname, "registry.npmjs.org");
      return String(url).endsWith(".tgz") ? new Response(archive) : new Response(JSON.stringify(metadata));
    };
    const snapshot = await fetchOfficialSnapshot("9.9.9");
    assert.equal(snapshot.source.version, snapshot.claudeCodeVersion);
    assert.equal(snapshot.source.bundleSha256, digest(fixture));
    assert.equal(snapshot.texts.review.sha256, digest(snapshot.texts.review.text));
    metadata.version = "9.9.8";
    await assert.rejects(() => fetchOfficialSnapshot("9.9.9"), /version mismatch/);
    metadata.version = "9.9.9";
    metadata.dist.integrity = `sha512-${digest("wrong", "sha512", "base64")}`;
    await assert.rejects(() => fetchOfficialSnapshot("9.9.9"), /integrity mismatch/);
  } finally {
    globalThis.fetch = originalFetch;
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(!path.isAbsolute(relative) && relative.startsWith("official-test-") && !relative.includes(path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
