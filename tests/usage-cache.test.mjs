import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { usageAccountCacheKey } from "../capabilities/usage/lib/cache-policy.mjs";

const home = mkdtempSync(join(tmpdir(), "agent-tools-account-cache-"));
after(() => rmSync(home, { recursive: true, force: true }));
process.env.AGENT_TOOLS_HOME = home;
const cache = await import("../capabilities/usage/lib/cache.mjs");
const sessions = await import("../capabilities/usage/lib/opencode-session.mjs");
const a = { baseUrl: "https://relay-a.example/v1", key: "fixture-secret-a" };
const b = { baseUrl: a.baseUrl, key: "fixture-secret-b" };
const c = { baseUrl: "https://relay-b.example/v1", key: a.key };

test("a foreground usage query reuses the snapshot from a running background process", async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let requests = 0;
  const server = createServer(async (_request, response) => {
    const request = ++requests;
    if (request === 1) {
      started.resolve();
      await release.promise;
    }
    response.end(JSON.stringify({ balance: request === 1 ? 21 : 42 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const context = { baseUrl: `http://127.0.0.1:${server.address().port}`, key: "refresh-test-key" };
  const entry = new URL("../dist/usage/core.mjs", import.meta.url);
  const { queryProviderUsage, queryCachedProviderUsage } = await import(entry);
  const previousPreset = process.env.PROVIDER_USAGE_PRESET;
  process.env.PROVIDER_USAGE_PRESET = "sub2api";
  t.after(() => {
    if (previousPreset === undefined) delete process.env.PROVIDER_USAGE_PRESET;
    else process.env.PROVIDER_USAGE_PRESET = previousPreset;
  });
  const background = promisify(execFile)(process.execPath, [fileURLToPath(entry), "refresh", "--agent", "claude"], {
    env: {
      ...process.env, PROVIDER_USAGE_API_KEY: context.key, PROVIDER_USAGE_BASE_URL: context.baseUrl,
    },
    timeout: 5_000,
  });
  const contested = Promise.withResolvers();
  const open = fsPromises.open;
  let foreground;
  try {
    await Promise.race([started.promise, background.then(() => assert.fail("no background request"))]);
    assert.equal(await queryCachedProviderUsage(context), "");
    t.mock.method(fsPromises, "open", async (...args) => {
      try { return await open(...args); }
      catch (error) {
        if (error.code === "EEXIST" && basename(args[0]).startsWith("usage-refresh-")) contested.resolve();
        throw error;
      }
    });
    syncBuiltinESMExports();
    foreground = queryProviderUsage(context, { rememberSnapshot: true, reuseSnapshot: true });
    await Promise.race([
      contested.promise,
      foreground.then(() => assert.fail("foreground skipped the refresh lease")),
      background.then(() => assert.fail("background exited before the foreground tried the lease")),
    ]);
    release.resolve();
    const result = await foreground;
    assert.equal(result.text, "balance $21.0");
    assert.equal(result.cached, true);
    assert.equal((await cache.readUsageSnapshot(context)).text, "balance $21.0");
    assert.equal(requests, 1);
  } finally {
    release.resolve();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await Promise.allSettled([background, foreground]);
  }
});

test("quota, refresh throttles and leases are isolated by endpoint and credential", async () => {
  const alias = { ...a, baseUrl: "https://relay-a.example/api/v1/" };
  const now = new Date().toISOString();
  await Promise.all([
    cache.rememberUsageSnapshot(a, { text: "balance $10" }),
    cache.rememberUsageSnapshot(b, { text: "balance $20" }),
    cache.rememberUsageSnapshot(c, { text: "balance $30" }),
  ]);
  assert.equal((await cache.readUsageSnapshot(alias)).text, "balance $10");
  assert.equal((await cache.readUsageSnapshot(b)).text, "balance $20");
  assert.equal((await cache.readUsageSnapshot(c)).text, "balance $30");
  assert.equal(await cache.readUsageSnapshot({ ...a, key: "replaced-key" }), null);
  assert.equal(await cache.readUsageSnapshot({ ...a, key: "" }), null);

  await cache.rememberRefreshState(a, { lastFailureAt: now });
  assert.equal(await cache.canRefreshUsage(alias, 60_000), false);
  assert.equal(await cache.canRefreshUsage(b, 60_000), true);
  assert.equal(await cache.canRefreshUsage(c, 60_000), true);
  const first = await cache.acquireUsageRefreshLease(a);
  const second = await cache.acquireUsageRefreshLease(b);
  const third = await cache.acquireUsageRefreshLease(c);
  try {
    assert.ok(first);
    assert.ok(second);
    assert.ok(third);
    assert.equal(await cache.acquireUsageRefreshLease(alias), null);
  } finally { await first?.(); await second?.(); await third?.(); }
  for (const name of ["usage-snapshot.json", "usage-refresh-state.json"]) {
    assert.doesNotMatch(readFileSync(join(home, "cache", name), "utf8"), /fixture-secret/);
  }
});

test("automatic usage keeps an older snapshot until the same gateway refreshes", async (t) => {
  let available = false;
  const server = createServer((_request, response) => {
    if (!available) return response.writeHead(503).end();
    response.end(JSON.stringify({ balance: 21 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const previousPreset = process.env.PROVIDER_USAGE_PRESET;
  process.env.PROVIDER_USAGE_PRESET = "sub2api";
  t.after(() => {
    if (previousPreset === undefined) delete process.env.PROVIDER_USAGE_PRESET;
    else process.env.PROVIDER_USAGE_PRESET = previousPreset;
  });
  const context = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, key: "stale-key" };
  const { queryCachedProviderUsage } = await import("../dist/usage/core.mjs");
  const updatedAt = new Date(Date.now() - 11 * 60_000).toISOString();
  const previous = "today $1 25reqs | 7d $7";
  await cache.updateJsonCache(join(home, "cache", "usage-snapshot.json"), "items", "test", (items) => {
    items[usageAccountCacheKey(context)] = { text: previous, updatedAt };
  });
  assert.equal(await queryCachedProviderUsage(context), previous);
  assert.equal(await queryCachedProviderUsage({ ...context, key: "rotated-key" }), "");
  assert.equal(await queryCachedProviderUsage(context, { force: true, allowStale: false }), "");
  available = true;
  assert.equal(await queryCachedProviderUsage(context, { force: true }), "balance $21.0");
  assert.equal(await queryCachedProviderUsage(context), "balance $21.0");
});

test("Codex usage CLI can query with a read-only cache and falls back only to the matching account", async (t) => {
  const root = mkdtempSync(join(home, "readonly-"));
  const transcript = join(root, "session.jsonl");
  writeFileSync(join(root, "config.jsonc"), JSON.stringify({ providerUsage: { outputSpeed: true } }));
  writeFileSync(transcript, [
    { type: "event_msg", timestamp: "2026-01-01T00:00:00Z", payload: { type: "task_started" } },
    { type: "response_item", timestamp: "2026-01-01T00:00:01Z", payload: { type: "message", role: "assistant" } },
    { type: "token_usage_record", timestamp: "2026-01-01T00:00:02Z", payload: { response_id: "response", usage: { output_tokens: 40 } } },
  ].map(JSON.stringify).join("\n"));
  const allowed = "readonly-key";
  let available = true;
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.headers.authorization);
    if (!available) return response.writeHead(503).end();
    response.end(JSON.stringify({ balance: 21 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const snapshot = join(root, "cache", "usage-snapshot.json");
  await cache.updateJsonCache(snapshot, "items", "test", (items) => {
    items[usageAccountCacheKey({ baseUrl, key: allowed })] = { text: "balance $7.0", updatedAt: new Date().toISOString() };
  });
  const blockedWrites = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    const root = process.env.AGENT_TOOLS_HOME;
    const cache = join(root, "cache");
    const logs = join(root, "logs");
    const denied = () => Object.assign(new Error("Sandbox cannot write here"), { code: "EPERM" });
    const { mkdir, open } = fs;
    fs.mkdir = async (path, ...args) => {
      if (path === logs || (path === cache && process.env.TEST_DENIED_OPERATION === "mkdir")) throw denied();
      return mkdir(path, ...args);
    };
    fs.open = async (path, ...args) => {
      if (String(path).startsWith(cache) && String(path).endsWith(".lock")) throw denied();
      return open(path, ...args);
    };
    syncBuiltinESMExports();
  `;
  const preload = `data:text/javascript,${encodeURIComponent(blockedWrites)}`;
  const cli = fileURLToPath(new URL("../dist/usage/cli.mjs", import.meta.url));
  const run = promisify(execFile);
  async function query(key, operation = "open") {
    const { stdout, stderr } = await run(process.execPath, ["--import", preload, cli, "--agent", "codex", "--transcript", transcript], {
      timeout: 5_000,
      env: { ...process.env, AGENT_TOOLS_HOME: root, CODEX_HOME: root, TEST_DENIED_OPERATION: operation,
        PROVIDER_USAGE_BASE_URL: baseUrl, PROVIDER_USAGE_API_KEY: key, PROVIDER_USAGE_PRESET: "sub2api", PROVIDER_USAGE_DEBUG: "1" },
    });
    assert.equal(stderr, "");
    return stdout.trim();
  }

  assert.equal(await query(allowed), "balance $21.0 | 20.0 tok/s");
  assert.equal(await query(allowed, "mkdir"), "balance $21.0 | 20.0 tok/s");
  assert.deepEqual(requests, [`Bearer ${allowed}`, `Bearer ${allowed}`]);
  available = false;
  assert.equal(await query(allowed), "balance $7.0 | 20.0 tok/s");
  assert.equal(await query("rotated-key"), "20.0 tok/s");
  assert.match(readFileSync(snapshot, "utf8"), /balance \$7\.0/);
});

test("writes prune expired and excess entries from each persistent cache", async () => {
  const now = Date.now();
  const expired = new Date(now - 31 * 24 * 60 * 60_000).toISOString();
  for (const [name, field, write, expected] of [
    ["usage-snapshot.json", "items", () => cache.rememberUsageSnapshot(a, { text: "balance $10" }), usageAccountCacheKey(a)],
    ["usage-refresh-state.json", "items", () => cache.rememberRefreshState(a, { lastStartedAt: new Date().toISOString() }), usageAccountCacheKey(a)],
    ["usage-routes.json", "routes", () => cache.rememberUsageRoute(a, { id: "fixture", path: "/quota" }, {}), "https://relay-a.example"],
    ["opencode-sessions.json", "items", () => sessions.rememberOpenCodeSession(home, "session-a", { accountKey: usageAccountCacheKey(a) }), null],
  ]) {
    const accountCache = name === "usage-snapshot.json" || name === "usage-refresh-state.json";
    const id = (i) => accountCache ? `scrypt-${i.toString(16).padStart(64, "0")}` : `entry-${i}`;
    const legacy = "f".repeat(64);
    const seed = Object.fromEntries([
      [id(65), { updatedAt: expired, text: "balance $999" }],
      [id(66), { updatedAt: "invalid" }],
      ...Array.from({ length: 65 }, (_, i) => [id(i), { updatedAt: new Date(now - (i + 1) * 1000).toISOString() }]),
    ]);
    if (accountCache) seed[legacy] = { text: "balance $99", updatedAt: new Date(now).toISOString() };
    const file = join(home, "cache", name);
    writeFileSync(file, JSON.stringify({ version: 1, [field]: seed }));
    if (name === "usage-snapshot.json") assert.equal(await cache.readUsageSnapshotByKey(legacy), null);
    await write();
    const entries = JSON.parse(readFileSync(file, "utf8"))[field];
    assert.equal(Object.keys(entries).length, 64, name);
    assert.equal(entries[legacy], undefined, name);
    assert.equal(entries[id(65)], undefined, name);
    assert.equal(entries[id(66)], undefined, name);
    assert.equal(entries[id(64)], undefined, name);
    if (expected) assert.ok(entries[expected], name);
  }
});

test("OpenCode session references use the shared quota, expire, and delete cleanly", async (t) => {
  await cache.rememberUsageSnapshot(a, { text: "balance $10" });
  await cache.rememberUsageSnapshot(b, { text: "balance $20" });
  await sessions.rememberOpenCodeSession(home, "session-a", { accountKey: usageAccountCacheKey(a), outputSpeed: "12.0 tok/s" });
  await sessions.rememberOpenCodeSession(home, "session-b", { accountKey: usageAccountCacheKey(b) });
  assert.equal(await sessions.readOpenCodeUsage(home, "session-a"), "balance $10 | 12.0 tok/s");
  assert.equal(await sessions.readOpenCodeUsage(home, "session-b"), "balance $20");
  assert.equal(await sessions.readOpenCodeUsage(join(home, "other-project"), "session-a"), "");
  assert.equal(await sessions.readOpenCodeUsage(home, "unknown-session"), "");
  await sessions.rememberOpenCodeSession(home, "session-a", { accountKey: usageAccountCacheKey(b) }, () => false);
  assert.equal(await sessions.readOpenCodeUsage(home, "session-a"), "balance $10 | 12.0 tok/s");
  await cache.rememberUsageSnapshot(a, { text: "balance $11" });
  assert.equal(await sessions.readOpenCodeUsage(home, "session-a"), "balance $11 | 12.0 tok/s");
  const serialized = readFileSync(join(home, "cache", "opencode-sessions.json"), "utf8");
  assert.doesNotMatch(serialized, /balance|fixture-secret|"text"/);
  const now = Date.now();
  const usageAt = new Date(now - 11 * 60_000).toISOString();
  await cache.updateJsonCache(join(home, "cache", "usage-snapshot.json"), "items", "test", (items) => {
    items[usageAccountCacheKey(b)].updatedAt = usageAt;
  });
  assert.equal(await sessions.readOpenCodeUsage(home, "session-b"), "balance $20");
  t.mock.method(Date, "now", () => now + 11 * 60_000);
  assert.equal(await sessions.readOpenCodeUsage(home, "session-b"), "");
  t.mock.restoreAll();
  await sessions.rememberOpenCodeSession(home, "session-a", null);
  assert.equal(await sessions.readOpenCodeUsage(home, "session-a"), "");
  assert.equal(await sessions.readOpenCodeUsage(home, "session-b"), "balance $20");
});
