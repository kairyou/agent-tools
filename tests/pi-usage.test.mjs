import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiUsageExtension } from "../dist/usage/pi-extension.mjs";

test("Pi usage extension queries a gateway and renders the shared usage output", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-key");
    requests += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ balance: 27.5 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const home = mkdtempSync(join(tmpdir(), "at-pi-usage-"));
  const source = `
    import extension from ${JSON.stringify(new URL("../dist/usage/pi-extension.mjs", import.meta.url).href)};
    const handlers = new Map();
    extension({ on: (name, fn) => handlers.set(name, fn) });
    const timeout = setTimeout(() => process.exit(1), 5000);
    handlers.get('session_start')({}, {
      mode: 'tui', model: { provider: 'fixture', baseUrl: 'http://127.0.0.1:${server.address().port}/v1' },
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'fixture-key' }) },
      ui: { setStatus(key, text) { if (text) { clearTimeout(timeout); console.log(text); } } },
    });
  `;
  try {
    const env = { ...process.env, AGENT_TOOLS_HOME: home, PROVIDER_USAGE_PRESET: "sub2api" };
    for (const name of ["PROVIDER_USAGE_BASE_URL", "PROVIDER_USAGE_API_KEY", "SUB2API_API_KEY"]) delete env[name];
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), "balance $27.5");
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function harness(options = {}) {
  const handlers = new Map();
  const statuses = [];
  const ctx = {
    mode: "tui",
    model: { provider: "relay", baseUrl: "https://relay.example/v1" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
    ui: { setStatus: (key, text) => statuses.push({ key, text }) },
  };
  createPiUsageExtension(options)({ on: (name, handler) => handlers.set(name, handler) });
  return {
    ctx, statuses,
    async emit(name, event = {}) {
      handlers.get(name)(event, ctx);
      await setImmediate();
    },
  };
}

test("Pi usage queries resolved auth, caches and coalesces refreshes", async () => {
  let time = 0;
  const calls = [];
  let finish;
  const h = harness({ now: () => time, query: (context, options) => {
    calls.push({ context, options });
    return new Promise((resolve) => { finish = resolve; });
  } });
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({
    ok: true, apiKey: "resolved-key", baseUrl: "https://resolved.example/v1",
  });
  await h.emit("session_start");
  await h.emit("agent_end");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.baseUrl, "https://resolved.example/v1");
  assert.equal(calls[0].context.key, "resolved-key");
  assert.deepEqual(calls[0].options, { agent: "pi", rememberSnapshot: true });
  finish({ text: "balance $27.5" });
  await setImmediate();
  assert.equal(h.statuses.at(-1).text, "balance $27.5");
  await h.emit("agent_end");
  assert.equal(calls.length, 1);
  time = 60_000;
  await h.emit("agent_end");
  assert.equal(calls.length, 2);
  finish({ text: "balance $26" });
  await setImmediate();
  assert.equal(h.statuses.at(-1).text, "balance $26");
});

test("Pi model changes and shutdown discard late results", async () => {
  const pending = [];
  const h = harness({ query: () => new Promise((resolve) => pending.push(resolve)) });
  await h.emit("session_start");
  const next = { provider: "other", baseUrl: "https://other.example/v1" };
  await h.emit("model_select", { model: next });
  pending[1]({ text: "new account" });
  await setImmediate();
  pending[0]({ text: "old account" });
  await setImmediate();
  assert.equal(h.statuses.at(-1).text, "new account");
  await h.emit("model_select", { model: { provider: "third", baseUrl: "https://third.example" } });
  await h.emit("session_shutdown");
  const count = h.statuses.length;
  pending[2]({ text: "closed session" });
  await setImmediate();
  assert.equal(h.statuses.length, count);
  assert.equal(h.statuses.at(-1).text, undefined);
});

test("Pi usage skips official endpoints, missing auth and headless sessions", async () => {
  let queries = 0;
  let authCalls = 0;
  const h = harness({ query: async () => { queries += 1; } });
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => { authCalls += 1; return { ok: false }; };
  h.ctx.model = { provider: "openai", baseUrl: "https://api.openai.com/v1" };
  await h.emit("session_start");
  assert.equal(authCalls, 0);
  h.ctx.model = { provider: "relay", baseUrl: "https://relay.example" };
  await h.emit("session_start");
  assert.equal(authCalls, 1);
  h.ctx.mode = "rpc";
  const count = h.statuses.length;
  await h.emit("session_start");
  assert.equal(h.statuses.length, count);
  assert.equal(authCalls, 1);
  assert.equal(queries, 0);
});

test("Pi usage failures clear stale status and allow a later retry", async () => {
  let time = 0;
  let calls = 0;
  const h = harness({ now: () => time, query: async () => {
    calls += 1;
    if (calls === 2) throw new Error("offline");
    return { text: "balance $10" };
  } });
  await h.emit("session_start");
  assert.equal(h.statuses.at(-1).text, "balance $10");
  time = 60_000;
  await h.emit("agent_end");
  assert.equal(h.statuses.at(-1).text, undefined);
  await h.emit("agent_end");
  assert.equal(calls, 2);
  time = 120_000;
  await h.emit("agent_end");
  assert.equal(h.statuses.at(-1).text, "balance $10");
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => { throw new Error("auth unavailable"); };
  await h.emit("agent_end");
  assert.equal(h.statuses.at(-1).text, undefined);
});

test("Pi usage honors explicit endpoint and credential overrides", async () => {
  const previous = { base: process.env.PROVIDER_USAGE_BASE_URL, key: process.env.PROVIDER_USAGE_API_KEY };
  process.env.PROVIDER_USAGE_BASE_URL = "https://override.example/v1";
  process.env.PROVIDER_USAGE_API_KEY = "override-key";
  try {
    let input;
    const h = harness({ query: async (context) => { input = context; return { text: "quota" }; } });
    h.ctx.model = { provider: "openai", baseUrl: "https://api.openai.com/v1" };
    h.ctx.modelRegistry.getApiKeyAndHeaders = async () => { throw new Error("must use override"); };
    await h.emit("session_start");
    assert.equal(input.baseUrl, "https://override.example/v1");
    assert.equal(input.key, "override-key");
    assert.equal(h.statuses.at(-1).text, "quota");
  } finally {
    for (const [name, value] of [["PROVIDER_USAGE_BASE_URL", previous.base], ["PROVIDER_USAGE_API_KEY", previous.key]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
