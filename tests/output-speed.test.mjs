import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { codexOutputSpeed, formatOutputSpeed } from "../capabilities/usage/lib/output-speed.mjs";

const cli = new URL("../dist/usage/cli.mjs", import.meta.url);
const hook = new URL("../dist/usage/codex-hook.mjs", import.meta.url);
import { fileURLToPath } from "node:url";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "at-speed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = join(dir, "session.jsonl");
  const write = (entries) => writeFileSync(transcript, entries.map(JSON.stringify).join("\n") + "\n");
  const config = (enabled) => writeFileSync(join(dir, "config.jsonc"), JSON.stringify({ providerUsage: { outputSpeed: enabled } }));
  config(true);
  const env = {
    ...process.env, AGENT_TOOLS_HOME: dir, CODEX_HOME: dir,
    PROVIDER_USAGE_BASE_URL: "https://api.openai.com/v1", PROVIDER_USAGE_API_KEY: "fixture-key",
  };
  const run = (script, args, input = "") => {
    const result = spawnSync(process.execPath, [fileURLToPath(script), ...args], { env, input, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout.trim();
  };
  return { dir, transcript, write, config, env, run };
}

const event = (seconds, type, fields = {}) => ({
  type: "event_msg", timestamp: new Date(seconds * 1000).toISOString(), payload: { type, ...fields },
});
const count = (seconds, total, last) => event(seconds, "token_count", {
  info: { total_token_usage: { output_tokens: total }, last_token_usage: { output_tokens: last } },
});

test("Codex turn speed deduplicates token events and ignores previous-turn totals", (t) => {
  const f = fixture(t);
  f.write([count(0, 1000, 1000), event(10, "task_started"), count(12, 1020, 20), count(12, 1020, 20), count(14, 1040, 20), event(15, "task_complete")]);
  assert.equal(codexOutputSpeed(f.transcript), "8.0 tok/s");
  assert.equal(f.run(cli, ["--agent", "codex", "--transcript", f.transcript]), "8.0 tok/s");
  f.write([event(10, "task_started"), count(12, 1020, 20)]);
  assert.equal(codexOutputSpeed(f.transcript), "10.0 tok/s");
  f.write([count(12, 1020, 20)]);
  assert.equal(codexOutputSpeed(f.transcript), "");
  for (const tokens of [null, undefined, -1, "20", Infinity]) assert.equal(formatOutputSpeed(tokens, 1000), "");
  for (const time of [null, undefined, 0, -1, Infinity]) assert.equal(formatOutputSpeed(20, time), "");
});

test("Claude usage CLI shares statusline speed and honors the usage opt-in", (t) => {
  const f = fixture(t);
  f.write([
    { type: "user", timestamp: "2026-11-10T00:00:00Z" },
    { type: "assistant", timestamp: "2026-11-10T00:00:10Z", message: { id: "answer", usage: { output_tokens: 382 } } },
  ]);
  assert.equal(f.run(cli, ["--agent", "claude", "--transcript", f.transcript]), "38.2 tok/s");
  f.env.CLAUDE_CONFIG_DIR = join(f.dir, "claude");
  const project = join(f.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "session.jsonl"), [
    { type: "user", timestamp: "2026-11-10T00:00:00Z" },
    { type: "assistant", timestamp: "2026-11-10T00:00:02Z", message: { id: "project-answer", usage: { output_tokens: 20 } } },
  ].map(JSON.stringify).join("\n"));
  assert.equal(f.run(cli, ["--agent", "claude"]), "10.0 tok/s");
  assert.equal(f.run(cli, ["--agent", "claude", "--transcript", join(f.dir, "missing")]), "");
  f.config(false);
  assert.equal(f.run(cli, ["--agent", "claude", "--transcript", f.transcript]), "");
});

test("Codex wrapper forwards hook session context and CLI selects its thread", (t) => {
  const f = fixture(t);
  f.write([event(0, "task_started"), count(2, 20, 20), event(2, "task_complete")]);
  // Prevent unrelated background refreshes: this test only checks local display.
  mkdirSync(join(f.dir, "cache"));
  writeFileSync(join(f.dir, "cache", "usage-refresh-state.json"), JSON.stringify({ items: {
    "https://api.openai.com": { lastSuccessAt: new Date().toISOString() },
  } }));
  const payload = JSON.stringify({ transcript_path: f.transcript, session_id: "thread-a" });
  assert.equal(JSON.parse(f.run(hook, [], payload)).systemMessage, "10.0 tok/s");
  assert.equal(JSON.parse(f.run(hook, ["--silent"], payload)).systemMessage, undefined);
  const sessions = join(f.dir, "sessions", "2026", "11", "10");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-test-thread-a.jsonl"), [event(0, "task_started"), count(2, 20, 20), event(2, "task_complete")].map(JSON.stringify).join("\n"));
  f.env.CODEX_THREAD_ID = "thread-a";
  assert.equal(f.run(cli, ["--agent", "codex"]), "10.0 tok/s");
  f.env.CODEX_THREAD_ID = "thread-b";
  assert.equal(f.run(cli, ["--agent", "codex"]), "");
});
