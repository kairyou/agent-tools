import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

test("ZCode Desktop shows account usage per session and discards results after a provider switch", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "at-zcode-extension-"));
  process.env.AGENT_TOOLS_HOME = home;
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = join(home, "providers.json");
  process.env.PROVIDER_USAGE_PRESET = "fixture";
  for (const name of ["PROVIDER_USAGE_BASE_URL", "PROVIDER_USAGE_API_KEY", "SUB2API_API_KEY"]) delete process.env[name];
  writeFileSync(join(home, "config.jsonc"), JSON.stringify({ providerUsage: { outputSpeed: true, routes: ["fixture.mjs"] } }));
  writeFileSync(join(home, "fixture.mjs"), `
    export async function run({ baseUrl, key }, { requestJson }) {
      return requestJson(baseUrl, { headers: { authorization: "Bearer " + key } });
    }
  `);
  const marketplace = new URL("../dist/usage/zcode-marketplace/", import.meta.url);
  const { plugins: [entry] } = JSON.parse(readFileSync(new URL("marketplace.json", marketplace), "utf8"));
  const plugin = new URL(`${entry.source}/`, marketplace);
  const manifest = JSON.parse(readFileSync(new URL(".zcode-plugin/plugin.json", plugin), "utf8"));
  const { createZcodeUsageExtension } = await import(new URL(manifest.extension.main, plugin));
  assert.deepEqual(manifest.slots["composer.status"][0], {
    id: "gateway-usage", target: { command: "refresh-usage" }, icon: "chart-bar",
  });

  let releaseB;
  let startedB;
  const waitingForB = new Promise((resolve) => { startedB = resolve; });
  const blockB = new Promise((resolve) => { releaseB = resolve; });
  const requests = [];
  const today = "today ¥9.7 1575reqs 91.2Mtok";
  const recent = "7d ¥16.5 11162reqs 770.0Mtok";
  let usageA = today;
  const gateway = createServer(async (req, res) => {
    const provider = req.url.split("/")[1];
    if (!["a", "b"].includes(provider) || req.headers.authorization !== `Bearer fixture-${provider}`) {
      res.writeHead(401).end();
      return;
    }
    requests.push(provider);
    if (provider === "b") { startedB(); await blockB; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ text: provider === "a" ? usageA : "balance $20.0 | today $0.3" }));
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => { releaseB(); gateway.closeAllConnections(); return new Promise((resolve) => gateway.close(resolve)); });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  writeFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, JSON.stringify({ schemaVersion: 1, config: {
    defaultModelSelection: { providerId: "a", modelId: "model" },
    providerConfigRules: { providerRules: ["a", "b"].map((providerId) => ({ providerId, config: {
      api: { baseUrl: `${base}/${providerId}/v1` }, access: { type: "api-key", apiKey: `fixture-${providerId}` },
    } })) },
  } }));

  const selection = new Map([["left", "a"], ["right", "a"]]);
  const slots = new Map();
  const published = [];
  const subscriptions = new Map();
  const listen = (event) => (handler) => {
    subscriptions.set(event, handler);
    return { dispose: () => subscriptions.delete(event) };
  };
  const extension = createZcodeUsageExtension();
  t.after(() => extension.deactivate());
  extension.activate({
    workbench: { onDidChange: listen("visible") },
    models: { onDidGenerate: listen("generate") },
    context: {
      onDidChange: listen("change"),
      get: async ({ sessionId }) => ({ model: { providerId: selection.get(sessionId), modelId: "model" } }),
    },
    slots: { update(id, value, scope) {
      assert.equal(id, manifest.slots["composer.status"][0].id);
      slots.set(scope.sessionId, value);
      published.push({ sessionId: scope.sessionId, ...value });
    } },
    commands: { register(id, handler) {
      assert.equal(id, "refresh-usage");
      return listen("refresh")(handler);
    } },
  });
  const until = async (ready) => {
    for (let i = 0; i < 100 && !ready(); i++) await delay(10);
    assert.ok(ready(), "slot update did not arrive");
  };
  subscriptions.get("visible")({ sessions: [{ sessionId: "left" }, { sessionId: "right" }] });
  await until(() => slots.get("left")?.text && slots.get("right")?.text);
  assert.deepEqual(slots.get("left"), { text: "today ¥9.7", tooltip: today });
  assert.deepEqual(requests, ["a"], "two sessions on one account share the query");
  const generate = subscriptions.get("generate");
  const metrics = { sessionId: "left", model: { providerId: "a", modelId: "model" }, outputTokensPerSecond: 32 };
  generate({ ...metrics, phase: "streaming" });
  assert.equal(slots.get("left").text, "today ¥9.7");
  generate({ ...metrics, phase: "final", outputTokens: 320 });
  assert.deepEqual(slots.get("left"), {
    text: "today ¥9.7 | 32.0 tok/s", tooltip: `${today} | 32.0 tok/s`,
  });
  assert.deepEqual(slots.get("right"), { text: "today ¥9.7", tooltip: today });
  usageA = `${recent} | ${today}`;
  await subscriptions.get("refresh")({ scope: { kind: "session", sessionId: "right" } });
  assert.deepEqual(requests, ["a", "a"], "clicking a status item refreshes its account");
  assert.deepEqual(slots.get("right"), { text: "7d ¥16.5", tooltip: usageA });

  selection.set("left", "b");
  const refreshing = subscriptions.get("refresh")({ scope: { kind: "session", sessionId: "left" } });
  await Promise.race([waitingForB, refreshing.then(() => { throw new Error("The new gateway was not queried"); })]);
  assert.equal(slots.get("left").text, null);
  assert.equal(slots.get("right").text, "7d ¥16.5");
  selection.set("left", "builtin:official");
  subscriptions.get("change")({ sessionId: "left" });
  releaseB();
  await refreshing;
  await until(() => slots.get("left")?.text === null);
  assert.equal(slots.get("left").text, null);
  // A final event on the official model shows local output without querying a gateway.
  await subscriptions.get("refresh")({ scope: { kind: "session", sessionId: "left" } });
  generate({ ...metrics, phase: "final", outputTokens: 320 });
  assert.equal(slots.get("left").text, null, "late results from the previous model are ignored");
  generate({ ...metrics, model: { providerId: "builtin:official", modelId: "model" }, phase: "final", outputTokens: 320 });
  assert.deepEqual(slots.get("left"), { text: "32.0 tok/s", tooltip: "32.0 tok/s" });
  assert.equal(published.some(({ text }) => text === "balance $20.0"), false);
  assert.deepEqual(requests, ["a", "a", "b"], "unconfigured models do not query the default account");

  subscriptions.get("visible")({ sessions: [{ sessionId: "left" }] });
  assert.equal(slots.get("right").text, null);
  extension.deactivate();
  assert.equal(subscriptions.size, 0);
});
