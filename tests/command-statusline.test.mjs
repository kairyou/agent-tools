import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

test("CLI usage footers isolate accounts and skip ambiguous Qwen models", { timeout: 15_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-tools-usage-footer-"));
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const requests = [];
  let releaseGateway;
  const blocked = new Promise((resolve) => { releaseGateway = resolve; });
  const gateway = createServer(async (req, res) => {
    requests.push([req.url, req.headers.authorization]);
    const match = /^\/(a|b)\/v1\/usage\?days=30$/.exec(req.url);
    if (!match || req.headers.authorization !== `Bearer key-${match[1]}`) return res.writeHead(404).end();
    await blocked;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ balance: match[1] === "a" ? 21 : 42 }));
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    releaseGateway();
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });

  const write = (file, value) => writeFileSync(join(home, file), JSON.stringify(value));
  const ids = ["a", "b"];
  const baseUrl = (id) => `http://127.0.0.1:${gateway.address().port}/${id}/v1`;
  write("config.jsonc", { providerUsage: { preset: "sub2api" } });
  write("providers.json", {
    providers: ids.map((id) => ({ name: id, baseUrl: baseUrl(id), apiKey: `key-${id}` })),
    models: ids.map((id) => ({ id: "same-model", provider: id })),
  });
  const qwenModels = ids.map((id) => ({ id, name: `Model ${id}`, baseUrl: baseUrl(id), envKey: `KEY_${id}` }));
  write("settings.json", { modelProviders: { openai: qwenModels } });
  const env = {
    ...process.env, AGENT_TOOLS_HOME: home, COPILOT_HOME: home, QWEN_HOME: home,
    COPILOT_PROVIDER_BASE_URL: "", COPILOT_PROVIDERS_CONFIG: "", KEY_a: "key-a", KEY_b: "key-b",
  };

  function render(agent, model) {
    const script = fileURLToPath(new URL(`../dist/usage/${agent}-statusline.mjs`, import.meta.url));
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [script], { env, timeout: 2_500 }, (error, stdout, stderr) => {
        if (error) reject(error);
        else if (stderr) reject(new Error(stderr));
        else resolve(stdout);
      });
      child.stdin.end(JSON.stringify({ model, workspace: { current_dir: workspace } }));
    });
  }

  assert.equal(await render("copilot", { id: "a/same-model" }), "");
  assert.equal(await render("qwen", { display_name: "Model b" }), "");
  releaseGateway();
  for (let attempt = 0; attempt < 30; attempt++) {
    const [a, b] = await Promise.all([
      render("copilot", { id: "a/same-model" }),
      render("qwen", { display_name: "Model b" }),
    ]);
    if (a === "balance $21.0" && b === "balance $42.0") break;
    if (attempt === 29) assert.fail(`Expected cached balances, got ${a} and ${b}`);
    await delay(30);
  }
  assert.equal(await render("copilot", { id: "b/same-model" }), "balance $42.0");
  assert.equal(await render("qwen", { display_name: "Model a" }), "balance $21.0");
  assert.equal(await render("copilot", { id: "same-model" }), "");

  write("settings.json", { modelProviders: { openai: qwenModels, anthropic: [{ ...qwenModels[1], name: "Model a" }] } });
  assert.equal(await render("qwen", { display_name: "Model a" }), "");
  mkdirSync(join(workspace, ".qwen"));
  write("workspace/.qwen/settings.json", { modelProviders: { openai: qwenModels } });
  assert.equal(await render("qwen", { display_name: "Model b" }), "");

  assert.deepEqual(requests.sort(), [
    ["/a/v1/usage?days=30", "Bearer key-a"],
    ["/b/v1/usage?days=30", "Bearer key-b"],
  ]);
});
