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
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-opencode-usage-"));
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
      await tuiModule.default.tui({
        keymap: { registerLayer: (value) => { layer = value; } },
        ui: { toast: (value) => { tuiToast = value; } },
      });

      assert.equal(layer.commands[0].slashName, "at-usage");
      layer.commands[0].run();
      assert.equal(tuiToast.message, "balance $27.5 | 38.2 tok/s");
      await hooks["chat.params"]({
        sessionID: "session-2", model: { providerID: "relay" },
        provider: { options: { baseURL: `${baseUrl}/v1`, apiKey: "test-secret" } },
      });
      await idle("session-2");
      layer.commands[0].run();
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
      layer.commands[0].run();
      assert.equal(tuiToast.message, "10.0 tok/s");
      // Repeated final metadata does not lose the observed timing.
      await hooks.event({ event: { type: "message.updated", properties: { info: {
        id: "local-answer", sessionID: "local", role: "assistant",
        time: { completed: 90000 }, tokens: { output: 10, reasoning: 10 },
      } } } });
      await idle("local");
      layer.commands[0].run();
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
      layer.commands[0].run();
      assert.equal(tuiToast.variant, "warning");
    });
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_TOOLS_HOME;
    else process.env.AGENT_TOOLS_HOME = previousHome;
    if (previousPreset === undefined) delete process.env.PROVIDER_USAGE_PRESET;
    else process.env.PROVIDER_USAGE_PRESET = previousPreset;
  }
});
