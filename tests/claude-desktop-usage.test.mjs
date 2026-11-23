import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import crossSpawn from "cross-spawn";

const install = fileURLToPath(new URL("../scripts/install.mjs", import.meta.url));
const run = promisify(execFile);

test("Claude's native hook loader accepts session ID lookup and PID fallback", (t) => {
  const command = crossSpawn.sync("claude", ["plugin", "test", "--help"], { encoding: "utf8", timeout: 5_000 });
  if (command.status !== 0 || !command.stdout?.includes("Run a mod's tests")) {
    return t.skip("Claude Code with plugin test is unavailable");
  }
  const root = mkdtempSync(join(tmpdir(), "agent-tools-claude-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const env = {
    ...process.env, AGENT_TOOLS_HOME: join(root, "runtime"), CLAUDE_CONFIG_DIR: join(root, "claude"),
    TEMP: root, TMP: root, TMPDIR: root,
  };
  execFileSync(process.execPath, [install, "usage", "-a", "claude"], { env });
  const plugin = join(env.CLAUDE_CONFIG_DIR, "skills", "agent-tools-desktop-usage");
  mkdirSync(join(plugin, "tests"));
  copyFileSync(new URL("./fixtures/claude-desktop-mod.test.ts", import.meta.url), join(plugin, "tests", "desktop.test.ts"));
  const result = crossSpawn.sync("claude", ["plugin", "test", plugin], { env, cwd: root, encoding: "utf8", timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("Claude Desktop usage renders scoped gateway data and measures only main model requests", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-tools-claude-desktop-"));
  const runtime = join(root, "runtime with spaces");
  const skills = join(root, "skills");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const gateway = createServer((req, res) => {
    const match = /^\/(a|b)\/v1\/usage\?days=30$/.exec(req.url);
    const key = req.headers.authorization;
    requests.push([req.url, key]);
    if (!match || key !== `Bearer ${match[1]}`) return res.writeHead(404).end();
    res.end(JSON.stringify({ balance: match[1] === "a" ? 21 : 42 }));
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  execFileSync(process.execPath, [install, "usage", "-a", "claude", "--claude-skills-dir", skills], {
    env: { ...process.env, AGENT_TOOLS_HOME: runtime },
  });
  writeFileSync(join(runtime, "config.jsonc"), JSON.stringify({ providerUsage: { preset: "sub2api", outputSpeed: true } }));
  const { register } = await import(pathToFileURL(join(skills, "agent-tools-desktop-usage", "hooks", "register.js")));

  function start(baseUrl, key, { sessionApi, gatewayUnavailable = false } = {}) {
    const hooks = [];
    register((name, matcher, handle) => hooks.push({ name, matcher: handle ? matcher : {}, handle: handle ?? matcher }));
    let ms = 0;
    let opened;
    let cancelled = false;
    const settings = Promise.withResolvers();
    const gateway = Promise.withResolvers();
    const elements = Object.fromEntries(["Box", "Text", "Button"].map((name) => [name, (props) => ({ name, ...props })]));
    const api = {
      session: sessionApi,
      clock: {
        now: async () => ms,
        every: () => ({ cancel() { cancelled = true; } }),
      },
      process: { async run([exe, script, ...args], opts) {
        const settingsOnly = args[0] === "--settings";
        assert.deepEqual(args, settingsOnly ? ["--settings"] : []);
        if (!settingsOnly && gatewayUnavailable) return new Promise(() => {});
        const env = { ...process.env, ...opts.env, PROVIDER_USAGE_BASE_URL: "", PROVIDER_USAGE_API_KEY: "",
          PROVIDER_USAGE_PRESET: "sub2api", PROVIDER_USAGE_DAYS: "30", ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: key };
        const completion = settingsOnly ? settings : gateway;
        try {
          const { stdout } = await run(exe, [script, ...args], { env, timeout: 5_000 });
          return { exitCode: 0, stdout };
        } finally {
          setImmediate(completion.resolve);
        }
      } },
      ui: { resolve: () => elements, invalidate() {}, open: async (options) => { opened = options; } },
    };
    const fire = (name, event, next = () => "untouched") => {
      const hook = hooks.find((hook) => hook.name === name && Object.entries(hook.matcher).every(([key, value]) => event[key] === value));
      return hook ? hook.handle(api, event, next) : next(event);
    };
    const band = (surface = "desktop") => fire("ui.render", { component: "AbovePrompt", surface }, () => null);
    return {
      band, settingsReady: settings.promise, rendered: Promise.all([settings.promise, gateway.promise]),
      details: () => fire("ui.render", { component: "Pane", surface: "desktop", requestId: opened.id }),
      async measure(agentId, tokens, elapsed) {
        const result = { usage: { output_tokens: tokens }, stopReason: "end_turn" };
        const stream = fire("turn.step", { agentId }, async function* () {
          yield "first chunk";
          ms += elapsed;
          return result;
        });
        assert.deepEqual(await stream.next(), { value: "first chunk", done: false });
        assert.deepEqual(await stream.next(), { value: result, done: true });
      },
      end() {
        assert.equal(fire("session.end", {}), "untouched");
        assert.equal(cancelled, true);
      },
    };
  }

  const base = `http://127.0.0.1:${gateway.address().port}`;
  const a = start(`${base}/a/v1`, "a");
  const b = start(`${base}/b/v1`, "b");
  const official = start("https://api.anthropic.com", "mock-official");
  assert.equal(await a.band("terminal"), null);
  await Promise.all([a.band(), b.band(), official.band()]);
  await Promise.all([a.rendered, b.rendered, official.rendered]);
  await a.measure(undefined, 40, 800);
  await a.measure("subagent", 900, 100);
  const row = await a.band();
  assert.equal(row.label, "balance $21.0 | 50.0 tok/s");
  await row.onPress();
  assert.deepEqual(a.details().children, ["balance $21.0"]);
  assert.equal((await b.band()).label, "balance $42.0");
  assert.equal(await official.band(), null);
  await official.measure(undefined, 12, 600);
  assert.deepEqual((await official.band()).children, ["20.0 tok/s"]);
  await a.measure(undefined, undefined, 800);
  assert.equal((await a.band()).label, "balance $21.0");
  assert.deepEqual(requests.sort(), [["/a/v1/usage?days=30", "Bearer a"], ["/b/v1/usage?days=30", "Bearer b"]]);
  for (const session of [a, b, official]) session.end();

  for (const sessionApi of [
    undefined,
    { id: async () => { throw new Error("session API unavailable"); } },
    { id: () => new Promise(() => {}) },
  ]) {
    const session = start(base, "", { sessionApi, gatewayUnavailable: true });
    await session.band();
    await session.settingsReady;
    await session.measure(undefined, 40, 800);
    assert.deepEqual((await session.band()).children, ["50.0 tok/s"]);
    session.end();
  }
});

test("Claude Desktop follows the authenticated CC Switch route without reusing the previous account", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-tools-cc-switch-"));
  let db;
  let gateway;
  t.after(async () => {
    db?.close();
    if (gateway?.listening) await new Promise((resolve) => gateway.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const stateDir = join(root, ".cc-switch");
  const dataDir = join(root, "data");
  const dbDir = join(root, "cc-switch data");
  const appDir = join(process.platform === "darwin" ? join(root, "Library", "Application Support") : dataDir, "com.ccswitch.desktop");
  const desktopRoot = process.platform === "darwin" ? join(root, "Library", "Application Support") : dataDir;
  const desktopLibrary = join(desktopRoot, process.platform === "win32" ? "Claude-3p-test" : "Claude-3p", "configLibrary");
  for (const dir of [stateDir, appDir, dbDir, desktopLibrary]) mkdirSync(dir, { recursive: true });
  const appPaths = join(appDir, "app_paths.json");
  const setDatabaseOverride = (path) => writeFileSync(appPaths, JSON.stringify({ app_config_dir_override: path }));
  setDatabaseOverride("~/cc-switch data");

  function select(id, extra = {}) {
    writeFileSync(join(stateDir, "live-state.json"), JSON.stringify({ version: 1, apps: {
      "claude-desktop": { mode: "proxy", attached: true, proxy_route: id, ...extra },
    } }));
  }
  const requests = [];
  let switchBeforeReply = false;
  gateway = createServer((req, res) => {
    requests.push([req.url, req.headers.authorization]);
    const match = /^\/(a|b)\/v1\/usage\?days=30$/.exec(req.url);
    if (!match || req.headers.authorization !== `Bearer upstream-${match[1]}`) return res.writeHead(404).end();
    if (switchBeforeReply) select("a");
    res.end(JSON.stringify({ balance: match[1] === "a" ? 21 : 42 }));
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  db = new DatabaseSync(join(dbDir, "cc-switch.db"));
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('claude_desktop_gateway_token', 'local-router-token');
    CREATE TABLE proxy_config (app_type TEXT PRIMARY KEY, auto_failover_enabled INTEGER);
    CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, meta TEXT, is_current INTEGER);
    CREATE TABLE proxy_request_logs (
      provider_id TEXT, app_type TEXT, session_id TEXT, data_source TEXT,
      status_code INTEGER, error_message TEXT, created_at INTEGER
    );
  `);
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const profileId = "00000000-0000-4000-8000-000000157210";
  const profileMeta = join(desktopLibrary, "_meta.json");
  writeFileSync(profileMeta, JSON.stringify({ appliedId: profileId }));
  writeFileSync(join(desktopLibrary, `${profileId}.json`), JSON.stringify({
    inferenceProvider: "gateway", inferenceGatewayBaseUrl: `${base}/claude-desktop/`,
    inferenceGatewayApiKey: "local-router-token",
  }));
  const insert = db.prepare("INSERT INTO providers VALUES (?, ?, ?, ?, NULL, ?)");
  for (const id of ["a", "b"]) insert.run(id, "claude-desktop", id, JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: `${base}/${id}/v1`, ANTHROPIC_AUTH_TOKEN: `upstream-${id}`,
  } }), id === "a" ? 1 : 0);
  insert.run("terminal-only", "claude", "terminal-only", JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: `${base}/a/v1`, ANTHROPIC_AUTH_TOKEN: "upstream-a",
  } }), 1);
  writeFileSync(join(root, "config.jsonc"), JSON.stringify({ providerUsage: { outputSpeed: true } }));
  const worker = fileURLToPath(new URL("../dist/usage/claude-desktop-usage.mjs", import.meta.url));
  const claudeProfile = join(root, "claude profile");
  mkdirSync(join(claudeProfile, "sessions"), { recursive: true });
  const sessionPath = join(claudeProfile, "sessions", `${process.pid}.json`);
  let sessionRegistered = false;
  async function query(overrides = {}, sessionId, registeredPid = process.pid, reportedSessionId) {
    if (sessionId) {
      writeFileSync(sessionPath, JSON.stringify({ pid: registeredPid, sessionId }));
      sessionRegistered = true;
    } else if (sessionRegistered) {
      unlinkSync(sessionPath);
      sessionRegistered = false;
    }
    const args = reportedSessionId ? [worker, "--session-id", reportedSessionId] : [worker];
    const { stdout } = await run(process.execPath, args, { timeout: 5_000, env: {
      ...process.env, APPDATA: dataDir, LOCALAPPDATA: dataDir, XDG_CONFIG_HOME: dataDir, XDG_DATA_HOME: dataDir,
      HOME: root, USERPROFILE: root, AGENT_TOOLS_HOME: root, CLAUDE_CONFIG_DIR: claudeProfile,
      PROVIDER_USAGE_PRESET: "sub2api", PROVIDER_USAGE_DAYS: "30", PROVIDER_USAGE_DEBUG: "1",
      PROVIDER_USAGE_BASE_URL: "", PROVIDER_USAGE_API_KEY: "",
      ANTHROPIC_BASE_URL: `${base}/claude-desktop`, ANTHROPIC_AUTH_TOKEN: "local-router-token", ...overrides,
    } });
    return JSON.parse(stdout);
  }

  const noSessionToken = { ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "" };
  select("a");
  const withoutToken = await query(noSessionToken);
  assert.deepEqual(withoutToken, { gateway: "balance $21.0", routed: true },
    readFileSync(join(root, "logs", "usage-debug.log"), "utf8").trim());
  db.prepare("VACUUM INTO ?").run(join(stateDir, "cc-switch.db"));
  setDatabaseOverride("~/missing database directory");
  assert.equal((await query(noSessionToken)).gateway, "balance $21.0");
  mkdirSync(join(root, "empty database directory"));
  setDatabaseOverride("~/empty database directory");
  assert.equal((await query(noSessionToken)).gateway, "");
  setDatabaseOverride("~/cc-switch data");
  assert.equal((await query({
    ...noSessionToken, ANTHROPIC_BASE_URL: "http://127.0.0.1:1/claude-desktop",
  })).gateway, "");
  select("b");
  switchBeforeReply = true;
  assert.equal((await query()).gateway, "");
  switchBeforeReply = false;
  select("b");
  assert.equal((await query()).gateway, "balance $42.0");
  assert.equal((await query({ ANTHROPIC_AUTH_TOKEN: "another-router-token" })).gateway, "");
  db.prepare("UPDATE settings SET value = ? WHERE key = ?")
    .run("another-router-token", "claude_desktop_gateway_token");
  assert.equal((await query(noSessionToken)).gateway, "");
  db.prepare("UPDATE settings SET value = ? WHERE key = ?")
    .run("local-router-token", "claude_desktop_gateway_token");
  writeFileSync(profileMeta, JSON.stringify({ appliedId: "another-profile" }));
  assert.equal((await query(noSessionToken)).gateway, "");
  assert.equal((await query({ PROVIDER_USAGE_BASE_URL: `${base}/a/v1` })).gateway, "");
  assert.equal((await query({ PROVIDER_USAGE_BASE_URL: `${base}/a/v1`, PROVIDER_USAGE_API_KEY: "upstream-a" })).gateway, "balance $21.0");
  select("b", { stack: { enabled: true } });
  assert.equal((await query()).gateway, "");
  select("terminal-only");
  assert.equal((await query()).gateway, "");

  const logRequest = db.prepare("INSERT INTO proxy_request_logs VALUES (?, ?, ?, ?, ?, ?, ?)");
  const now = Math.floor(Date.now() / 1000);
  logRequest.run("a", "claude-desktop", "active-session", "proxy", 200, null, now - 2);
  logRequest.run("b", "claude-desktop", "active-session", "proxy", 502, "failed", now - 1);
  logRequest.run("b", "claude-desktop", "active-session", "session_log", 200, null, now - 1);
  logRequest.run("b", "claude", "active-session", "proxy", 200, null, now - 1);
  logRequest.run("b", "claude-desktop", "other-session", "proxy", 200, null, now - 1);
  logRequest.run("a", "claude-desktop", "old-session", "proxy", 200, null, now - 1_200);
  select("a");
  writeFileSync(profileMeta, JSON.stringify({ appliedId: profileId }));
  db.prepare("UPDATE settings SET value = ? WHERE key = ?")
    .run("new-local-router-token", "claude_desktop_gateway_token");
  assert.equal((await query(noSessionToken, "active-session")).gateway, "balance $21.0");
  assert.equal((await query(noSessionToken, "other-session", process.pid, "active-session")).gateway, "balance $21.0");
  assert.equal((await query(noSessionToken, "active-session", process.pid, "new-session")).gateway, "");
  assert.equal((await query(noSessionToken, "active-session", process.pid + 1)).gateway, "");
  assert.equal((await query(noSessionToken, "old-session")).gateway, "");
  assert.equal((await query(noSessionToken, "new-session")).gateway, "");
  select("b");
  assert.equal((await query({ ANTHROPIC_AUTH_TOKEN: "new-local-router-token" }, "active-session")).gateway, "");
  logRequest.run("b", "claude-desktop", "active-session", "proxy", 200, null, now - 1);
  assert.equal((await query(noSessionToken, "active-session")).gateway, "balance $42.0");
  logRequest.run("a", "claude-desktop", "active-session", "proxy", 200, null, now - 1);
  assert.equal((await query(noSessionToken, "active-session")).gateway, "");
  assert.equal((await query({ ANTHROPIC_AUTH_TOKEN: "new-local-router-token" }, "new-session")).gateway, "balance $42.0");
  assert.deepEqual(requests, [["/a/v1/usage?days=30", "Bearer upstream-a"], ["/b/v1/usage?days=30", "Bearer upstream-b"]]);
  const diagnostics = readFileSync(join(root, "logs", "usage-debug.log"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line)).filter((line) => line.source === "claude-desktop-usage");
  assert.deepEqual(diagnostics.map(({ status }) => status), [
    "quota-available", "quota-available", "cc-switch-database-unreadable", "cc-switch-session-token-missing",
    "cc-switch-route-changed", "quota-available",
    "cc-switch-session-token-mismatch", "cc-switch-session-token-mismatch",
    "cc-switch-session-token-missing", "incomplete-usage-override", "quota-available",
    "cc-switch-stack-enabled", "cc-switch-provider-missing",
    "quota-available-from-session-route", "quota-available-from-session-route", "cc-switch-session-token-mismatch",
    "cc-switch-session-token-mismatch", "cc-switch-session-token-mismatch",
    "cc-switch-session-token-mismatch",
    "cc-switch-session-route-mismatch", "quota-available-from-session-route", "cc-switch-session-provider-ambiguous",
    "quota-available",
  ]);
  assert.ok(diagnostics.every((line) => line.routed && Object.keys(line).length === 4));
});
