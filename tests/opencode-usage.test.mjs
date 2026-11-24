import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PLUGIN = join(ROOT, "dist", "usage", "opencode-plugin.mjs");
const TUI_PLUGIN = join(ROOT, "dist", "usage", "opencode-tui.mjs");
// Both bundles share core.mjs, which resolves the installation home once.
const AGENT_HOME = mkdtempSync(join(tmpdir(), "agent-tools-opencode-usage-"));

function withServer(handler, run) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();
      try {
        resolvePromise(await run(`http://127.0.0.1:${port}`));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

test("opencode usage plugins time streaming output independently of provider quota", async (t) => {
  const temp = AGENT_HOME;
  const previousHome = process.env.AGENT_TOOLS_HOME;
  const previousPreset = process.env.PROVIDER_USAGE_PRESET;
  process.env.AGENT_TOOLS_HOME = temp;
  process.env.PROVIDER_USAGE_PRESET = "sub2api";
  writeFileSync(join(temp, "config.jsonc"), JSON.stringify({ providerUsage: { outputSpeed: true } }));

  try {
    await withServer((req, res) => {
      if (req.url === "/v1/usage?days=30") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ balance: 27.5 }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    }, async (baseUrl) => {
      const { AgentToolsUsage } = await import(`${pathToFileURL(SERVER_PLUGIN).href}?test=${Date.now()}`);
      let time = 0;
      t.mock.method(Date, "now", () => time);
      let resolveToast;
      const toasts = [];
      const toast = new Promise((resolve) => {
        resolveToast = resolve;
      });
      const hooks = await AgentToolsUsage({
        client: {
          tui: {
            showToast: async ({ body }) => { toasts.push(body); resolveToast(body); },
          },
        },
      }, { refreshMs: 0 });
      async function idle(sessionID) {
        const count = toasts.length;
        const delivered = new Promise((resolve) => { resolveToast = resolve; });
        await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
        let timeout;
        try {
          await Promise.race([
            delivered,
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("usage toast timed out")), 3000); }),
          ]);
        } finally { clearTimeout(timeout); }
        assert.equal(toasts.length, count + 1);
      }
      const start = (sessionID, id) => hooks.event({ event: { type: "message.updated", properties: { info: {
        id, sessionID, role: "assistant", time: { created: 0 },
      } } } });
      const chunk = (at, sessionID, messageID, delta = "output", field = "text") => {
        time = at;
        return hooks.event({ event: { type: "message.part.delta", properties: { sessionID, messageID, delta, field } } });
      };

      await hooks["chat.params"]({
        sessionID: "session-1",
        model: { providerID: "relay", modelID: "test-model" },
        provider: {
          info: { id: "relay", name: "Relay" },
          options: { baseURL: `${baseUrl}/v1`, apiKey: "test-secret" },
        },
      });
      await start("session-1", "answer");
      await chunk(0, "other-session", "answer");
      await chunk(100, "session-1", "answer", "ignored", "metadata");
      await chunk(200, "session-1", "answer", "");
      await chunk(1000, "session-1", "answer");
      await chunk(11000, "session-1", "answer");
      time = 60000;
      await hooks.event({ event: { type: "message.updated", properties: { info: {
        id: "answer", sessionID: "session-1", role: "assistant",
        time: { created: 0, completed: 60000 }, tokens: { output: 382 },
      } } } });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });

      const shown = await Promise.race([
        toast,
        new Promise((_, reject) => setTimeout(() => reject(new Error("usage toast timed out")), 3000)),
      ]);
      assert.equal(shown.message, "balance $27.5 | 38.2 tok/s");

      const snapshotFile = join(temp, "cache", "usage-snapshot.json");
      const snapshotText = readFileSync(snapshotFile, "utf8");
      assert.doesNotMatch(snapshotText, /test-secret/);
      assert.doesNotMatch(snapshotText, /tok\/s/);

      const tuiModule = await import(`${pathToFileURL(TUI_PLUGIN).href}?test=${Date.now()}`);
      let layer;
      let tuiToast;
      let sessionID = "session-1";
      await tuiModule.default.tui({
        route: { get current() { return { name: "session", params: { sessionID } }; } },
        state: { path: { directory: process.cwd() } },
        keymap: { registerLayer: (value) => { layer = value; } },
        ui: { toast: (value) => { tuiToast = value; } },
      });

      assert.equal(layer.commands[0].slashName, "at-usage");
      await layer.commands[0].run();
      assert.equal(tuiToast.message, "balance $27.5 | 38.2 tok/s");
      await hooks["chat.params"]({
        sessionID: "session-2", model: { providerID: "relay" },
        provider: { options: { baseURL: `${baseUrl}/v1`, apiKey: "test-secret" } },
      });
      await idle("session-2");
      sessionID = "session-2";
      await layer.commands[0].run();
      assert.equal(tuiToast.message, "balance $27.5");
      // Speed also works without gateway context and is removed with the session.
      await start("local", "local-answer");
      await chunk(61000, "local", "local-answer");
      await chunk(63000, "local", "local-answer");
      await hooks.event({ event: { type: "message.updated", properties: { info: {
        id: "local-answer", sessionID: "local", role: "assistant",
        time: { created: 0, completed: 65000 }, tokens: { output: 10, reasoning: 10 },
      } } } });
      await idle("local");
      sessionID = "local";
      await layer.commands[0].run();
      assert.equal(tuiToast.message, "10.0 tok/s");
      // Repeated final metadata does not lose the observed timing.
      await hooks.event({ event: { type: "message.updated", properties: { info: {
        id: "local-answer", sessionID: "local", role: "assistant",
        time: { completed: 90000 }, tokens: { output: 10, reasoning: 10 },
      } } } });
      await idle("local");
      await layer.commands[0].run();
      assert.equal(tuiToast.message, "10.0 tok/s");
      for (const sample of [
        { id: "missing", chunks: [] },
        { id: "single", chunks: [1000] },
        { id: "same-time", chunks: [1000, 1000] },
        { id: "tool", chunks: [1000, 11000], tool: true },
        { id: "error", chunks: [1000, 11000], error: { name: "MessageAbortedError" } },
      ]) {
        await start("session-1", sample.id);
        for (const at of sample.chunks) await chunk(at, "session-1", sample.id);
        if (sample.tool) await hooks.event({ event: { type: "message.part.updated", properties: { part: {
          id: "tool-part", sessionID: "session-1", messageID: sample.id, type: "tool", state: { status: "completed" },
        } } } });
        await hooks.event({ event: { type: "message.updated", properties: { info: {
          id: sample.id, sessionID: "session-1", role: "assistant", error: sample.error,
          time: { created: 0, completed: 90000 }, tokens: { output: 382 },
        } } } });
        await idle("session-1");
        assert.equal(toasts.at(-1).message, "balance $27.5", sample.id);
      }
      await hooks.event({ event: { type: "session.deleted", properties: { sessionID: "local" } } });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "local" } } });
      await layer.commands[0].run();
      assert.equal(tuiToast.variant, "warning");
    });
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_TOOLS_HOME;
    else process.env.AGENT_TOOLS_HOME = previousHome;
    if (previousPreset === undefined) delete process.env.PROVIDER_USAGE_PRESET;
    else process.env.PROVIDER_USAGE_PRESET = previousPreset;
  }
});

test("OpenCode commands isolate sessions and discard quota from replaced credentials", async () => {
  const home = AGENT_HOME;
  const previous = { home: process.env.AGENT_TOOLS_HOME, preset: process.env.PROVIDER_USAGE_PRESET };
  process.env.AGENT_TOOLS_HOME = home;
  process.env.PROVIDER_USAGE_PRESET = "sub2api";
  const waitFor = async (check) => {
    const deadline = Date.now() + 3000;
    while (!check()) {
      assert.ok(Date.now() < deadline, "timed out waiting for usage");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    let finishSlow;
    let requests = 0;
    await withServer((req, res) => {
      requests += 1;
      res.setHeader("content-type", "application/json");
      const amount = req.url.startsWith("/other/") ? 30 : req.headers.authorization === "Bearer fixture-b" ? 20 : 10;
      const send = () => res.end(JSON.stringify({ balance: amount }));
      if (req.headers.authorization === "Bearer fixture-slow") finishSlow = send;
      else send();
    }, async (baseUrl) => {
      const { AgentToolsUsage } = await import(`${pathToFileURL(SERVER_PLUGIN).href}?accounts=${Date.now()}`);
      const toasts = [];
      const hooks = await AgentToolsUsage({ directory: home, client: { tui: {
        showToast: async ({ body }) => { toasts.push(body); },
      } } }, { refreshMs: 0 });
      const params = (sessionID, apiKey, baseURL = `${baseUrl}/v1`) => hooks["chat.params"]({
        sessionID, model: { providerID: "relay", modelID: "fixture-model" }, provider: { options: { baseURL, apiKey } },
      });
      const idle = async (sessionID) => {
        const count = toasts.length;
        await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
        await waitFor(() => toasts.length > count);
      };
      const tui = (await import(`${pathToFileURL(TUI_PLUGIN).href}?accounts=${Date.now()}`)).default;
      let route = { name: "session", params: { sessionID: "a" } };
      let layer, shown;
      await tui.tui({
        route: { get current() { return route; } }, state: { path: { directory: home } },
        keymap: { registerLayer(value) { layer = value; } }, ui: { toast(value) { shown = value; } },
      });
      const read = async (sessionID) => {
        route = sessionID ? { name: "session", params: { sessionID } } : { name: "home" };
        await layer.commands[0].run();
        return shown;
      };
      const { queryCachedProviderUsage } = await import("../dist/usage/core.mjs");
      assert.equal(await queryCachedProviderUsage({
        baseUrl: `${baseUrl}/v1`, key: "fixture-a",
      }, { agent: "claude" }), "balance $10.0");
      assert.equal(requests, 1);
      await params("a", "fixture-a");
      await idle("a");
      assert.equal(requests, 1, "OpenCode reuses a recent reading from another agent");
      await params("b", "fixture-b");
      await idle("b");
      await params("c", "fixture-a", `${baseUrl}/other/v1`);
      await idle("c");
      assert.equal((await read("a")).message, "balance $10.0");
      assert.equal((await read("b")).message, "balance $20.0");
      assert.equal((await read("c")).message, "balance $30.0");
      assert.equal((await read("unknown")).variant, "warning");
      assert.equal((await read()).variant, "warning");

      await params("a", "fixture-slow");
      assert.equal((await read("a")).variant, "warning");
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "a" } } });
      await waitFor(() => finishSlow);
      await params("a", "fixture-b");
      finishSlow();
      await idle("a");
      assert.equal((await read("a")).message, "balance $20.0");
      await hooks.event({ event: { type: "session.deleted", properties: { sessionID: "a" } } });
      assert.equal((await read("a")).variant, "warning");
      assert.equal((await read("b")).message, "balance $20.0");
    });
  } finally {
    if (previous.home === undefined) delete process.env.AGENT_TOOLS_HOME;
    else process.env.AGENT_TOOLS_HOME = previous.home;
    if (previous.preset === undefined) delete process.env.PROVIDER_USAGE_PRESET;
    else process.env.PROVIDER_USAGE_PRESET = previous.preset;
  }
});
