import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const home = mkdtempSync(join(tmpdir(), "agent-tools-native-usage-"));
process.env.AGENT_TOOLS_HOME = home;
writeFileSync(join(home, "config.jsonc"), JSON.stringify({ providerUsage: { preset: "sub2api" } }));
const { createDshUsagePlugin } = await import(new URL("dist/usage/dsh-plugin.mjs", root));

async function withGateway(run, beforeResponse = async () => {}) {
  const server = createServer(async (req, res) => {
    const provider = req.url.split("/")[1];
    const amount = { "a:Bearer fixture-a": 10, "b:Bearer fixture-b": 20, "b:Bearer fixture-c": 30 }[`${provider}:${req.headers.authorization}`];
    if (!amount) { res.writeHead(401).end(); return; }
    await beforeResponse(provider);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ balance: amount }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function runZcode(file, mode = "print", env = {}) {
  const script = mode === "hook" ? new URL("dist/usage/core.mjs", root) : new URL("dist/usage/cli.mjs", root);
  const args = mode === "hook" ? ["hook", "--agent", "zcode"] : ["--agent", "zcode"];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(script), ...args], {
      env: { ...process.env, AGENT_TOOLS_HOME: home, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: file,
        ZCODE_SESSION_ID: "", ZCODE_SESSION_DB_PATH: "", ZCODE_SESSION_DB: "",
        PROVIDER_USAGE_BASE_URL: "", PROVIDER_USAGE_API_KEY: "", SUB2API_API_KEY: "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(JSON.stringify({ hookEventName: "Stop", sessionId: "zcode-native" }));
    child.on("close", (status) => { assert.equal(status, 0, stderr); resolve(stdout.trim()); });
  });
}

test("ZCode CLI and hooks use the configured provider and keep rotated keys isolated", async () => {
  await withGateway(async (base) => {
    const file = join(home, "provider_config.json");
    const config = { schemaVersion: 1, config: {
      defaultModelSelection: { providerId: "a", modelId: "model" },
      providerConfigRules: { providerRules: ["a", "b"].map((providerId) => ({ providerId, config: {
        api: { type: "openai-chat-completions", baseUrl: `${base}/${providerId}/v1` },
        access: { type: "api-key", apiKey: `fixture-${providerId}` },
      } })) },
    } };
    writeFileSync(file, JSON.stringify(config));
    assert.equal(await runZcode(file), "balance $10.0");
    config.config.defaultModelSelection.providerId = "b";
    writeFileSync(file, JSON.stringify(config));
    assert.equal(await runZcode(file), "balance $20.0");
    assert.equal(JSON.parse(await runZcode(file, "hook")).systemMessage, "balance $20.0");
    config.config.providerConfigRules.providerRules[1].config.access.apiKey = "fixture-c";
    writeFileSync(file, JSON.stringify(config));
    assert.equal(await runZcode(file), "balance $30.0");
    const raw = readFileSync(join(home, "cache", "usage-snapshot.json"), "utf8");
    assert.doesNotMatch(raw, /fixture-[abc]/);
    assert.equal(Object.keys(JSON.parse(raw).items).length, 3);
    config.schemaVersion = 99;
    writeFileSync(file, JSON.stringify(config));
    assert.equal(await runZcode(file), "");
  });
});

test("ZCode uses the saved session provider and only falls back when selection is unambiguous", async (t) => {
  await withGateway(async (base) => {
    const file = join(home, "no-default-provider.json");
    const rule = (providerId) => ({ providerId, config: {
      api: { baseUrl: `${base}/${providerId}/v1` },
      access: { type: "api-key", apiKey: `fixture-${providerId}` },
    } });
    const config = { providerOrder: ["a", "b"], providerConfigRules: { providerRules: [rule("b")] }, modelConfigRules: {} };
    const save = () => writeFileSync(file, JSON.stringify({ schemaVersion: 1, config }));
    save();
    assert.equal(await runZcode(file), "balance $20.0", "a single personal provider needs no saved default");
    config.providerConfigRules.providerRules.unshift(rule("a"));
    save();
    assert.equal(await runZcode(file), "", "provider order does not identify a session account");

    const database = join(home, "provider-selection.sqlite");
    const db = new DatabaseSync(database);
    t.after(() => db.close());
    db.exec(`CREATE TABLE session_entry (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
    )`);
    const select = (sessionId, providerId) => db.prepare(`
      INSERT OR REPLACE INTO session_entry VALUES (?, ?, 'runtime/model_selection', 100, 100, ?)
    `).run(`${sessionId}:runtime-model-selection`, sessionId, JSON.stringify({ modelSelection: { providerId, modelId: "model" } }));
    select("other-session", "a");
    select("zcode-native", "b");
    const env = { ZCODE_SESSION_ID: "zcode-native", ZCODE_SESSION_DB_PATH: database, ZCODE_SESSION_DB: database };
    assert.equal(await runZcode(file, "print", env), "balance $20.0");
    config.defaultModelSelection = { providerId: "a", modelId: "model" };
    save();
    assert.equal(JSON.parse(await runZcode(file, "hook", env)).systemMessage, "balance $20.0");
    select("zcode-native", "a");
    assert.equal(await runZcode(file, "print", env), "balance $10.0");
    select("zcode-native", "builtin:official");
    assert.equal(await runZcode(file, "print", env), "", "an unconfigured session provider must not query a different account");
  });
});

test("DSH dock and slash command share quota without adding speed or returning the previous provider", async () => {
  let requests = 0;
  let releaseA;
  let observeA;
  const startedA = new Promise((resolve) => { observeA = resolve; });
  const waitForA = new Promise((resolve) => { releaseA = resolve; });
  let releaseB;
  let observeB;
  const startedB = new Promise((resolve) => { observeB = resolve; });
  const waitForB = new Promise((resolve) => { releaseB = resolve; });
  await withGateway(async (base) => {
    const handlers = new Map();
    let command, route;
    let selection = { provider: "a", model: "model" };
    let credentialB = "fixture-b";
    const agents = new Map();
    const sessionId = "dsh-session";
    const agent = { id: sessionId, model: { current: () => selection } };
    const ctx = {
      on(name, callback) { handlers.set(name, callback); },
      effect() {},
      inject(_services, mount) { mount(this); },
      connection: { fetch: { register(value) { route = value; } } },
      agents,
      sessionController: { projections: async ({ sessionId: id }) => id === sessionId
        ? { kind: "sequenced", values: { modelSelection: { next: selection } } } : null },
      commands: { register(value) { command = value; } },
      llm: { listConfigurableProviders: () => ["a", "b"].map((provider) => ({ provider, settingsNs: "models", settingsPath: [provider] })) },
      get(name) {
        return {
          launchEnvironment: { get: () => undefined },
          credentials: { resolve: async (ref) => ({ value: ref === "b" ? credentialB : `fixture-${ref}` }) },
          settings: { describe: () => [{ ns: "models", value: { a: { baseURL: `${base}/a/v1`, apiKeyEnv: "a" }, b: { baseURL: `${base}/b/v1`, apiKeyEnv: "b" } } }] },
        }[name];
      },
    };
    await createDshUsagePlugin()(ctx);
    const dock = async (id = sessionId) => {
      const response = await route.fetch(new Request(`http://localhost${route.path}?sessionId=${id}`));
      assert.equal(response.headers.get("cache-control"), "no-store");
      return await response.json();
    };
    assert.deepEqual(await dock("unknown-session"), { text: "" });
    const views = Promise.all([dock(), dock()]);
    await startedA;
    agents.set(agent.id, agent);
    const exec = { agent, rawInput: "", signal: new AbortController().signal };
    const manual = command.handler(exec);
    await new Promise(setImmediate);
    releaseA();
    assert.deepEqual(await views, [{ text: "balance $10.0" }, { text: "balance $10.0" }]);
    assert.deepEqual(await manual, { kind: "success", text: "balance $10.0" });
    assert.equal(requests, 1, "dock and slash command join the same in-flight query");
    assert.deepEqual(await command.handler(exec), { kind: "success", text: "balance $10.0" });
    assert.deepEqual(await dock(), { text: "balance $10.0" });
    assert.equal(requests, 2, "manual query refreshes the same cache the dock reads");
    selection = { provider: "b", model: "model" };
    handlers.get("session/event")({ id: agent.id }, { type: "model/selection", data: selection });
    const delayed = dock();
    await Promise.race([startedB, delayed.then(() => { throw new Error("Dock returned before querying the new provider"); })]);
    credentialB = "fixture-c";
    releaseB();
    assert.deepEqual(await delayed, { text: "" }, "a query started under the old key must not reach the dock");
    assert.deepEqual(await dock(), { text: "balance $30.0" });
    const raw = readFileSync(join(home, "cache", "usage-snapshot.json"), "utf8");
    assert.doesNotMatch(raw, /fixture-[abc]|tok\/s/);
  }, async (provider) => {
    requests++;
    if (provider === "a" && requests === 1) { observeA(); await waitForA; }
    if (provider === "b") { observeB(); await waitForB; }
  });
});
