import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { zcodeOutputSpeed } from "../capabilities/usage/lib/output-speed.mjs";
import { zcodeSessionDbPath } from "../capabilities/usage/lib/zcode-session.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "at-zcode-speed-"));
  const file = join(home, "db.sqlite");
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, query_source TEXT,
      status TEXT, started_at INTEGER, first_token_at INTEGER, completed_at INTEGER,
      output_tokens INTEGER, retry_count INTEGER, tool_call_count INTEGER, cancelled_by_user INTEGER
    );
    CREATE INDEX model_usage_session_turn_idx ON model_usage(session_id, turn_id);
  `);
  // Column names and meanings follow ZCode v3.18.2's model_usage schema and
  // core/runtime/methods/usage-observability.ts, not transcript timestamps.
  const defaults = {
    id: "response", session_id: "session-a", turn_id: "turn-a", query_source: "main_turn",
    status: "completed", started_at: 1000, first_token_at: 9000, completed_at: 11000,
    output_tokens: 100, retry_count: 0, tool_call_count: 0, cancelled_by_user: 0,
  };
  function record(fields = {}) {
    const row = { ...defaults, ...fields };
    const columns = Object.keys(row);
    db.prepare(`INSERT OR REPLACE INTO model_usage (${columns}) VALUES (${columns.map(() => "?")})`).run(...Object.values(row));
  }
  const speed = (sessionId = "session-a", turnId) => zcodeOutputSpeed({ dbPath: file, sessionId, turnId });
  return { home, file, db, record, speed };
}

test("ZCode reads committed WAL usage for the exact session, excluding initial wait and auxiliary requests", (t) => {
  const f = fixture(t);
  f.record();
  f.record({ id: "other-session", session_id: "session-b", output_tokens: 500 });
  for (const query_source of ["compact", "session_title", "goal_completion_verification", "subagent"]) {
    f.record({ id: query_source, query_source, started_at: 20000, first_token_at: 21000, completed_at: 22000 });
  }
  assert.equal(f.speed(), "50.0 tok/s");
  assert.equal(f.speed("session-b"), "250.0 tok/s");
  assert.equal(f.speed("session-a", "turn-a"), "50.0 tok/s");
  assert.equal(f.speed("session-a", "another-turn"), "");
  assert.equal(f.speed("' OR 1=1 --"), "");
  assert.equal(f.speed(""), "");
  f.db.exec("BEGIN IMMEDIATE");
  f.record({ id: "uncommitted", started_at: 30000, first_token_at: 31000, completed_at: 32000 });
  assert.equal(f.speed(), "50.0 tok/s");
  f.db.exec("ROLLBACK");
});

test("ZCode hides an unusable latest response instead of returning an earlier speed", (t) => {
  const f = fixture(t);
  f.record({ id: "previous", started_at: 0 });
  for (const invalid of [
    { status: "error" }, { status: "cancelled" }, { cancelled_by_user: 1 },
    { retry_count: 1 }, { tool_call_count: 1 }, { first_token_at: null },
    { first_token_at: 0 }, { completed_at: 9000 }, { completed_at: null },
    { output_tokens: null }, { output_tokens: 0 }, { output_tokens: -1 }, { output_tokens: 1.5 },
  ]) {
    f.record(invalid);
    assert.equal(f.speed(), "", JSON.stringify(invalid));
  }
  f.record();
  assert.equal(f.speed(), "50.0 tok/s");
});

test("ZCode missing, incompatible or locked databases fail open without creating or migrating data", (t) => {
  const home = mkdtempSync(join(tmpdir(), "at-zcode-missing-"));
  const file = join(home, "missing.sqlite");
  assert.equal(zcodeOutputSpeed({ dbPath: file, sessionId: "session-a" }), "");
  assert.equal(existsSync(file), false);
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec("CREATE TABLE unrelated(value TEXT)");
  assert.equal(zcodeOutputSpeed({ dbPath: file, sessionId: "session-a" }), "");
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name), ["unrelated"]);
  db.exec("BEGIN EXCLUSIVE");
  assert.equal(zcodeOutputSpeed({ dbPath: file, sessionId: "session-a" }), "");
  db.exec("ROLLBACK");
});

test("ZCode database discovery follows native user, project and environment configuration", () => {
  const home = mkdtempSync(join(tmpdir(), "at-zcode-paths-"));
  const cwd = join(home, "project", "child");
  mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
  mkdirSync(join(home, "project", ".git"), { recursive: true });
  mkdirSync(join(cwd, ".zcode"), { recursive: true });
  const options = { home, cwd, env: {} };
  assert.equal(zcodeSessionDbPath(options), join(home, ".zcode", "cli", "db", "db.sqlite"));
  writeFileSync(join(home, ".zcode", "cli", "config.json"), JSON.stringify({ storage: { sessionDbPath: "~/user.sqlite" } }));
  assert.equal(zcodeSessionDbPath(options), join(home, "user.sqlite"));
  writeFileSync(join(dirname(cwd), "zcode.json"), JSON.stringify({ storage: { sessionDbPath: "root.sqlite" } }));
  assert.equal(zcodeSessionDbPath(options), join(cwd, "root.sqlite"));
  writeFileSync(join(cwd, ".zcode", "config.json"), JSON.stringify({ storage: { sessionDbPath: "child.sqlite" } }));
  assert.equal(zcodeSessionDbPath(options), join(cwd, "child.sqlite"));
  assert.equal(zcodeSessionDbPath({ ...options, env: { ZCODE_SESSION_DB: "alias.sqlite", ZCODE_SESSION_DB_PATH: "env.sqlite" } }), join(cwd, "env.sqlite"));
});

test("ZCode installed CLI and hooks display scoped speed independently of gateway usage", (t) => {
  const f = fixture(t);
  f.record();
  f.record({ id: "other-session", session_id: "session-b", turn_id: "turn-b", output_tokens: 500 });
  const config = (enabled) => writeFileSync(join(f.home, "config.jsonc"), JSON.stringify({ providerUsage: { outputSpeed: enabled } }));
  config(true);
  const env = {
    ...process.env, AGENT_TOOLS_HOME: f.home, ZCODE_SESSION_DB_PATH: f.file, ZCODE_SESSION_DB: f.file,
    ZCODE_SESSION_ID: "session-a", ZCODE_PROJECT_DIR: f.home,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(f.home, "missing-provider.json"),
    PROVIDER_USAGE_BASE_URL: "https://api.openai.com/v1", PROVIDER_USAGE_API_KEY: "fixture-key",
  };
  const run = (script, args, input = "") => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL(`../dist/usage/${script}.mjs`, import.meta.url)), ...args], { env, input, encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    return child.stdout.trim();
  };
  assert.equal(run("cli", ["--agent", "zcode"]), "50.0 tok/s");
  const stop = { hookEventName: "Stop", sessionId: "session-b", turnId: "turn-b", cwd: f.home };
  assert.equal(JSON.parse(run("core", ["hook", "--agent", "zcode"], JSON.stringify(stop))).systemMessage, "250.0 tok/s");
  assert.equal(JSON.parse(run("core", ["hook", "--agent", "zcode"], JSON.stringify({ ...stop, turnId: "new-turn" }))).systemMessage, undefined);
  config(false);
  assert.equal(run("cli", ["--agent", "zcode"]), "");
  assert.equal(JSON.parse(run("core", ["hook", "--agent", "zcode"], JSON.stringify(stop))).systemMessage, undefined);
  assert.equal(existsSync(join(f.home, "cache", "usage-snapshot.json")), false);
});
