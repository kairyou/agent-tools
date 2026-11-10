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

test("opencode usage plugins query the resolved provider and expose the shared snapshot", async () => {
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

      await hooks["chat.params"]({
        sessionID: "session-1",
        model: { providerID: "relay", modelID: "test-model" },
        provider: {
          info: { id: "relay", name: "Relay" },
          options: { baseURL: `${baseUrl}/v1`, apiKey: "test-secret" },
        },
      });
      await hooks.event({ event: { type: "message.updated", properties: { info: {
        id: "answer", sessionID: "session-1", role: "assistant",
        time: { created: 1000, completed: 11000 }, tokens: { output: 382 },
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
      await hooks.event({ event: { type: "message.updated", properties: { info: {
        sessionID: "local", role: "assistant", time: { created: 0, completed: 2000 }, tokens: { output: 20 },
      } } } });
      await idle("local");
      layer.commands[0].run();
      assert.equal(tuiToast.message, "10.0 tok/s");
    });
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_TOOLS_HOME;
    else process.env.AGENT_TOOLS_HOME = previousHome;
    if (previousPreset === undefined) delete process.env.PROVIDER_USAGE_PRESET;
    else process.env.PROVIDER_USAGE_PRESET = previousPreset;
  }
});
