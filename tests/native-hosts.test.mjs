import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "agent-tools-native-hosts-"));
process.env.AGENT_TOOLS_HOME = home;
const root = new URL("../", import.meta.url);
const { zcodeLogInput } = await import(new URL("dist/log/zcode-hook.mjs", root));
const { createDshLogPlugin, apply: dshLog } = await import(new URL("dist/log/dsh-plugin.mjs", root));
const { createDshUsagePlugin, dshUsageContext } = await import(new URL("dist/usage/dsh-plugin.mjs", root));

function harness(services = {}) {
  services = { launchEnvironment: { get: () => undefined }, ...services };
  const handlers = new Map();
  const disposers = [];
  let command;
  return {
    get command() { return command; },
    ctx: {
      ...services,
      on(name, callback) { handlers.set(name, callback); },
      get(name) { return services[name]; },
      effect(setup) { disposers.push(setup()); },
      inject(names, mount) { if (names.includes("commands")) mount(this); },
      commands: { register(value) { command = value; } },
    },
    async emit(name, ...args) { return await handlers.get(name)?.(...args); },
    async dispose() { for (const dispose of disposers) await dispose(); },
  };
}

test("ZCode native hook fields translate without relying on temporary transcripts", () => {
  const input = zcodeLogInput({ hookEventName: "Stop", sessionId: "native", cwd: home, responseText: "Completed the requested change." });
  assert.equal(input.session_id, "zcode:native");
  assert.equal(input.last_assistant_message, "Completed the requested change.");
  assert.equal(zcodeLogInput({ hookEventName: "PostToolUseFailure", sessionId: "native" }), null);
  assert.equal(zcodeLogInput({ hookEventName: "Stop" }), null);
});

test("DSH log awaits baselines, filters synthetic prompts and failures, and clears aborted outcomes", async () => {
  const sent = [];
  let release;
  const h = harness({ workingDirectory: { get: () => home } });
  createDshLogPlugin({ send: async (payload) => {
    sent.push(payload);
    if (payload.hook_event_name === "PreToolUse") await new Promise((resolve) => { release = resolve; });
  } })(h.ctx);
  const session = { id: "session" };
  const event = (type, data = {}) => h.emit("session/event", session, { type, data });
  await event("turn/start");
  await event("user/message", { source: { kind: "plugin" }, content: [{ type: "text", text: "Injected context" }] });
  assert.equal(sent.length, 0);
  await event("user/message", { source: { kind: "user" }, content: [{ type: "text", text: "Implement the requested change" }] });
  const exec = { name: "write", arguments: { file_path: "a.txt", content: "done" }, agent: { session } };
  let continued = false;
  const pre = h.emit("tools/pre-execute", exec, async () => { continued = true; return { kind: "allow" }; });
  await new Promise(setImmediate);
  assert.equal(continued, false);
  release();
  await pre;
  assert.equal(continued, true);
  await h.emit("tools/post-execute", exec, { isError: true }, async () => ({ kind: "allow" }));
  assert.equal(sent.filter((item) => item.hook_event_name === "PostToolUse").length, 0);
  await h.emit("tools/post-execute", exec, { isError: false }, async () => ({ kind: "allow" }));
  await event("assistant/message", { message: { content: [{ type: "text", text: "Finished the complete requested implementation." }] } });
  await event("turn/end", { reason: { kind: "aborted" } });
  assert.equal(sent.at(-1).last_assistant_message, "");
  await event("turn/start");
  await event("user/message", { source: { kind: "user" }, content: [{ type: "text", text: "Continue with the next implementation" }] });
  await event("turn/end", { reason: { kind: "completed" } });
  assert.equal(sent.at(-1).last_assistant_message, "");
  assert.ok(sent.every((payload) => payload.session_id === "dsh:session"));
  await h.dispose();
});

test("DSH native command queries the selected provider and discards results after model switches", async () => {
  const values = { a: { baseURL: "https://a.example/v1", apiKeyEnv: "KEY_A" }, b: { baseURL: "https://b.example/v1", apiKeyEnv: "KEY_B" } };
  const h = harness({
    llm: { listConfigurableProviders: () => ["a", "b"].map((provider) => ({ provider, settingsNs: "models", settingsPath: ["providers", provider] })) },
    settings: { describe: () => [{ ns: "models", value: { providers: values } }] },
    credentials: { resolve: async (ref) => ({ value: `secret-${ref}` }) },
  });
  const calls = [];
  let finish;
  await createDshUsagePlugin({ query: async (context) => {
    calls.push(context);
    return await new Promise((resolve) => { finish = resolve; });
  } })(h.ctx);
  let selection = { provider: "a", model: "model-a" };
  const agent = { id: "session", model: { current: () => selection } };
  const exec = { agent, rawInput: "", signal: new AbortController().signal };
  assert.equal(h.command.name, "at-usage");
  assert.deepEqual(await h.command.handler({ ...exec, rawInput: " unexpected" }), { kind: "error", text: "Usage: /at-usage" });
  assert.equal(calls.length, 0);
  const pending = h.command.handler(exec);
  await new Promise(setImmediate);
  assert.equal(calls[0].baseUrl, "https://a.example/v1");
  assert.equal(calls[0].key, "secret-KEY_A");
  selection = { provider: "b", model: "model-b" };
  finish("balance $10");
  assert.deepEqual(await pending, { kind: "error", text: "Provider usage is unavailable." });
  const next = h.command.handler(exec);
  await new Promise(setImmediate);
  assert.equal(calls[1].baseUrl, "https://b.example/v1");
  assert.equal(calls[1].key, "secret-KEY_B");
  finish("balance $20");
  assert.deepEqual(await next, { kind: "success", text: "balance $20" });
  assert.equal((await h.command.handler({ ...exec, signal: AbortSignal.abort() })).kind, "error");
  assert.equal(calls.length, 2);
  await h.dispose();
});

test("DSH does not substitute ambient keys for an unresolved credential reference", async () => {
  const h = harness({
    llm: { listConfigurableProviders: () => [{ provider: "a", settingsNs: "models", settingsPath: [] }] },
    settings: { describe: () => [{ ns: "models", value: { baseURL: "https://a.example/v1", apiKeyEnv: "KEY_A" } }] },
    launchEnvironment: { get: () => ({ value: "ambient-key" }) },
    credentials: { resolve: async () => undefined },
  });
  // Explicit provider-usage overrides are absent; KEY_A exists only in the launch environment.
  h.ctx.get("launchEnvironment").get = (name) => name === "KEY_A" ? { value: "ambient-key" } : undefined;
  const context = await dshUsageContext(h.ctx, { provider: "a", model: "model" });
  assert.equal(context.key, "");
});

test("DSH native environment credentials use the credential plane before the launch environment", async () => {
  const h = harness({
    llm: { listConfigurableProviders: () => [{ provider: "a", settingsNs: "llm-pi-ai", nativeAuth: { env: ["KEY_A"] } }] },
    credentials: { readRecord: async () => undefined, resolve: async () => ({ value: "stored-key" }) },
    launchEnvironment: { get: (name) => name === "KEY_A" ? { value: "ambient-key" } : undefined },
  });
  assert.equal((await dshUsageContext(h.ctx, { provider: "a", model: "model" })).key, "stored-key");
  h.ctx.get("credentials").readRecord = async () => ({ kind: "grant", payload: {} });
  assert.equal((await dshUsageContext(h.ctx, { provider: "a", model: "model" })).key, "");
});

for (const agent of ["ZCode", "DSH"]) test(`${agent} native log writes a report through the shared recorder`, async () => {
  const output = join(home, `reports-${agent}`);
  const file = join(home, `${agent}.txt`);
  writeFileSync(file, "first\n");
  writeFileSync(join(home, "config.jsonc"), JSON.stringify({ log: { output, format: "detailed", language: "en" } }));
  const prompt = "Refactor the import parser and cover the new field mapping with regression tests";
  const outcome = "Completed the import parser refactor, added regression coverage and verified all tests pass.";
  if (agent === "ZCode") {
    const send = (hookEventName, fields = {}) => {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("dist/log/zcode-hook.mjs", root))], {
        input: JSON.stringify({ hookEventName, sessionId: "native-recorder", cwd: home, ...fields }),
        encoding: "utf8", env: process.env,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    };
    const tool = { toolName: "Edit", toolInput: { file_path: file } };
    send("UserPromptSubmit", { prompt });
    send("PreToolUse", tool);
    writeFileSync(file, "first\nsecond\n");
    send("PostToolUse", tool);
    send("Stop", { responseText: outcome });
  } else {
    const h = harness({ workingDirectory: { get: () => home } });
    dshLog(h.ctx);
    const session = { id: "native-recorder" };
    const emit = (type, data = {}) => h.emit("session/event", session, { type, data });
    await emit("turn/start");
    await emit("user/message", { source: { kind: "user" }, content: [{ type: "text", text: prompt }] });
    const exec = { name: "apply_patch", arguments: { input: `*** Begin Patch\n*** Update File: ${file}\n@@\n first\n+second\n*** End Patch` }, agent: { session } };
    await h.emit("tools/pre-execute", exec, async () => ({}));
    writeFileSync(file, "first\nsecond\n");
    await h.emit("tools/post-execute", exec, { isError: false }, async () => ({}));
    await emit("assistant/message", { message: { content: [{ type: "text", text: outcome }] } });
    await emit("turn/end", { reason: { kind: "completed" } });
    await h.dispose();
  }
  const report = readFileSync(join(output, readdirSync(output)[0]), "utf8");
  for (const text of [prompt, outcome, `${agent}.txt`, "+1/-0"]) assert.ok(report.includes(text), report);
});
