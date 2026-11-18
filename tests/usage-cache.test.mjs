import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { usageAccountCacheKey } from "../capabilities/usage/lib/cache-policy.mjs";

const home = mkdtempSync(join(tmpdir(), "agent-tools-account-cache-"));
process.env.AGENT_TOOLS_HOME = home;
const cache = await import("../capabilities/usage/lib/cache.mjs");
const sessions = await import("../capabilities/usage/lib/opencode-session.mjs");
const a = { baseUrl: "https://relay-a.example/v1", key: "fixture-secret-a" };
const b = { baseUrl: a.baseUrl, key: "fixture-secret-b" };
const c = { baseUrl: "https://relay-b.example/v1", key: a.key };

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

test("writes prune expired and excess entries from each persistent cache", async () => {
  const now = Date.now();
  const expired = new Date(now - 31 * 24 * 60 * 60_000).toISOString();
  const seed = () => Object.fromEntries([
    ["deleted-gateway", { updatedAt: expired, text: "balance $999" }],
    ["invalid-date", { updatedAt: "invalid" }],
    ...Array.from({ length: 65 }, (_, i) => [`entry-${i}`, { updatedAt: new Date(now - (i + 1) * 1000).toISOString() }]),
  ]);
  for (const [name, field, write, expected] of [
    ["usage-snapshot.json", "items", () => cache.rememberUsageSnapshot(a, { text: "balance $10" }), usageAccountCacheKey(a)],
    ["usage-refresh-state.json", "items", () => cache.rememberRefreshState(a, { lastStartedAt: new Date().toISOString() }), usageAccountCacheKey(a)],
    ["usage-routes.json", "routes", () => cache.rememberUsageRoute(a, { id: "fixture", path: "/quota" }, {}), "https://relay-a.example"],
    ["opencode-sessions.json", "items", () => sessions.rememberOpenCodeSession(home, "session-a", { accountKey: usageAccountCacheKey(a) }), null],
  ]) {
    const file = join(home, "cache", name);
    writeFileSync(file, JSON.stringify({ version: 1, [field]: seed() }));
    await write();
    const entries = JSON.parse(readFileSync(file, "utf8"))[field];
    assert.equal(Object.keys(entries).length, 64, name);
    assert.equal(entries["deleted-gateway"], undefined, name);
    assert.equal(entries["invalid-date"], undefined, name);
    assert.equal(entries["entry-64"], undefined, name);
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
  t.mock.method(Date, "now", () => now + 11 * 60_000);
  assert.equal(await sessions.readOpenCodeUsage(home, "session-b"), "");
  t.mock.restoreAll();
  await sessions.rememberOpenCodeSession(home, "session-a", null);
  assert.equal(await sessions.readOpenCodeUsage(home, "session-a"), "");
  assert.equal(await sessions.readOpenCodeUsage(home, "session-b"), "balance $20");
});
