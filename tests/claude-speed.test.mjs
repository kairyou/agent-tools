import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { claudeOutputSpeed } from "../capabilities/usage/lib/output-speed.mjs";

const STATUSLINE = fileURLToPath(new URL("../dist/statusline/claude-statusline.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../dist/usage/cli.mjs", import.meta.url));
const stamp = (seconds) => new Date(seconds * 1000).toISOString();
const user = (seconds) => ({ type: "user", timestamp: stamp(seconds) });
const assistant = (id, seconds, tokens = 100) => ({
  type: "assistant", timestamp: stamp(seconds),
  message: { id, usage: { input_tokens: 500, output_tokens: tokens } },
});

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "at-claude-speed-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const transcript = join(home, "session.jsonl");
  const cacheDir = join(home, "cache", "claude-output-speed");
  const cacheFile = join(cacheDir, `${createHash("sha256").update(resolve(transcript)).digest("hex")}.json`);
  const entries = [];
  const add = (...records) => {
    entries.push(...records);
    writeFileSync(transcript, entries.map(JSON.stringify).join("\n") + "\n");
  };
  const frame = (apiMs, usage = entries.findLast((entry) => entry.type === "assistant" && !entry.isSidechain)?.message.usage) => ({
    transcript_path: transcript,
    cost: { total_api_duration_ms: apiMs },
    context_window: { current_usage: usage },
  });
  const speed = (apiMs, usage) => claudeOutputSpeed(frame(apiMs, usage), { cacheDir });
  const cached = () => claudeOutputSpeed({ transcript_path: transcript }, { cacheDir });
  add();
  return { home, transcript, cacheDir, cacheFile, entries, add, frame, speed, cached };
}

test("Claude native API timing excludes hooks, survives repaints and is shared without a payload", (t) => {
  const f = fixture(t);
  assert.equal(f.speed(0, null), "");
  f.add(user(0), assistant("a", 10));
  assert.equal(f.speed(2000), "50.0 tok/s");
  assert.equal(f.speed(2000), "50.0 tok/s");
  assert.equal(f.cached(), "50.0 tok/s");
  f.add(user(20), assistant("b", 30));
  assert.equal(f.cached(), "10.0 tok/s", "a previous response's speed must not be reused");
  assert.equal(f.speed(6000), "25.0 tok/s");
  assert.equal(existsSync(join(f.home, "cache", "usage-snapshot.json")), false);
});

test("Claude pairs identical token counts by response ID and waits for the API counter", (t) => {
  const f = fixture(t);
  f.add(user(0), assistant("a", 10));
  assert.equal(f.speed(1000), "10.0 tok/s", "the first sample establishes a baseline");
  f.add(user(20), assistant("b", 30));
  assert.equal(f.speed(1000), "10.0 tok/s", "an unchanged API counter cannot complete a new response");
  assert.equal(f.speed(3000), "50.0 tok/s");
  f.add(user(40), assistant("c", 50));
  assert.equal(f.speed(7000), "25.0 tok/s", "identical usage still belongs to a different response");
});

test("Claude falls back after missed requests, then resumes native timing at a clean boundary", (t) => {
  const f = fixture(t);
  f.add(user(0), assistant("a", 10));
  f.speed(1000);
  f.add(user(20), assistant("b", 30), user(40), assistant("c", 50));
  assert.equal(f.speed(5000), "10.0 tok/s");
  f.add(user(60), assistant("d", 70));
  assert.equal(f.speed(7000), "50.0 tok/s");
});

test("Claude does not charge sidechains or agent activity to a main response", (t) => {
  for (const activity of [
    { ...assistant("child", 15, 1000), isSidechain: true },
    { type: "progress", uuid: "child-progress", timestamp: stamp(15), data: { type: "agent_progress" } },
  ]) {
    const f = fixture(t);
    f.add(user(0), assistant("a", 10));
    f.speed(1000);
    f.add(activity, user(20), assistant("b", 30));
    assert.equal(f.speed(4000), "10.0 tok/s");
  }
  const f = fixture(t);
  f.add(user(0), assistant("a", 10));
  f.speed(1000);
  f.add({ ...assistant("child", 15, 1000), isSidechain: true });
  assert.equal(f.speed(2000, assistant("a", 10).message.usage), "10.0 tok/s");
  f.add(user(20), assistant("b", 30));
  assert.equal(f.speed(4000), "50.0 tok/s", "a separately observed child increment advances the baseline");
});

test("Claude rejects mismatched payload usage and API time outside the response span", (t) => {
  for (const [delta, usage] of [
    [2000, { input_tokens: 500, output_tokens: 999 }],
    [2000, { input_tokens: 999, output_tokens: 100 }],
    [2000, { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 1 }],
    [2000, null],
    [20000, { input_tokens: 500, output_tokens: 100 }],
  ]) {
    const f = fixture(t);
    f.add(user(0), assistant("a", 10));
    f.speed(1000);
    f.add(user(20), assistant("b", 30));
    assert.equal(f.speed(1000 + delta, usage), "10.0 tok/s");
  }
});

test("Claude resets native timing on counter resets and compaction without crossing sessions", (t) => {
  const f = fixture(t);
  f.speed(0, null);
  f.add(user(0), assistant("a", 10));
  assert.equal(f.speed(2000), "50.0 tok/s");
  assert.equal(f.speed(0), "10.0 tok/s");
  f.add(user(20), assistant("b", 30));
  assert.equal(f.speed(4000), "25.0 tok/s");
  f.add({ type: "system", subtype: "compact_boundary" });
  assert.equal(f.cached(), "");
  f.add(user(40), assistant("c", 50));
  assert.equal(f.speed(6000), "10.0 tok/s", "compaction invalidates the old pairing boundary");
  const other = fixture(t);
  other.add(user(0), assistant("b", 10));
  assert.equal(other.cached(), "10.0 tok/s", "even identical IDs are isolated by transcript path");
});

test("Claude deduplicates interleaved response blocks without switching back to an older reply", (t) => {
  const f = fixture(t);
  f.speed(0, null);
  f.add(user(0), assistant("a", 10));
  assert.equal(f.speed(2000), "50.0 tok/s");
  f.add(user(20), assistant("b", 21, 10));
  assert.equal(f.speed(2000), "10.0 tok/s");
  f.add(assistant("a", 22), assistant("b", 30));
  assert.equal(f.speed(4000), "50.0 tok/s");
  f.add(assistant("a", 31, 200));
  assert.equal(f.cached(), "50.0 tok/s");
});

test("Claude tolerates invalid counters, corrupt caches and unavailable cache storage", (t) => {
  const f = fixture(t);
  f.add(user(0), assistant("a", 10));
  f.speed(1000);
  writeFileSync(f.cacheFile, "{broken");
  assert.equal(f.speed(2000), "10.0 tok/s");
  f.add(user(20), assistant("b", 30));
  for (const counter of [-1, "4000", null, Infinity]) assert.equal(f.speed(counter), "10.0 tok/s");
  const blocked = join(f.home, "not-a-directory");
  writeFileSync(blocked, "fixture");
  assert.equal(claudeOutputSpeed(f.frame(4000), { cacheDir: blocked }), "10.0 tok/s");
});

test("Claude bundles share native speed for subscription and relay inputs, independently of quota display", (t) => {
  for (const baseUrl of ["https://api.anthropic.com", "https://relay.example.com"]) {
    const f = fixture(t);
    const config = join(f.home, "config.jsonc");
    writeFileSync(config, JSON.stringify({ providerUsage: { outputSpeed: true } }));
    const env = { ...process.env, AGENT_TOOLS_HOME: f.home, AGENT_TOOLS_USAGE_REFRESH: "0",
      ANTHROPIC_BASE_URL: baseUrl, PROVIDER_USAGE_BASE_URL: "", PROVIDER_USAGE_API_KEY: "fixture-key" };
    const render = (apiMs) => {
      const result = spawnSync(process.execPath, [STATUSLINE, "--fields", "outputSpeed"], {
        env, input: JSON.stringify(f.frame(apiMs)), encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      return result.stdout;
    };
    assert.equal(render(0), "");
    f.add(user(0), assistant("a", 10));
    assert.equal(render(2000), "50.0 tok/s");
    const result = spawnSync(process.execPath, [CLI, "--agent", "claude", "--transcript", f.transcript], {
      env: { ...env, PROVIDER_USAGE_BASE_URL: "https://api.anthropic.com" }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "50.0 tok/s");
    writeFileSync(config, JSON.stringify({ providerUsage: { outputSpeed: false } }));
    assert.equal(render(2000), "50.0 tok/s");
    assert.equal(existsSync(join(f.home, "cache", "usage-snapshot.json")), false);
  }
});
