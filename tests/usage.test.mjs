import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER_SCRIPT = join(ROOT, "hooks", "codex", "usage.mjs");

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runProvider({ baseUrl, preset = "auto", config = {} }) {
  const temp = mkdtempSync(join(tmpdir(), "agent-tooling-provider-"));
  const codexHome = join(temp, "codex");
  const agentHome = join(temp, "agent");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(agentHome, { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-key" }));
  writeFileSync(
    join(codexHome, "config.toml"),
    `model_provider = "mock"\n[model_providers.mock]\nname = "Mock"\nbase_url = "${baseUrl}"\n`
  );
  writeFileSync(join(agentHome, "config.jsonc"), JSON.stringify({ providerUsage: config }));

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [PROVIDER_SCRIPT, "hook"], {
      cwd: ROOT,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        AGENT_TOOLING_HOME: agentHome,
        PROVIDER_USAGE_PRESET: preset,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (status) => {
      resolve({ status, stdout, stderr });
    });
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("provider usage reads Sub2API balance from /api/v1/auth/me", async () => {
  await withServer((req, res) => {
    if (req.url === "/api/v1/auth/me") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: 0, data: { username: "sub-user", balance: 12.34 } }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  }, async (base) => {
    const payload = await runProvider({ baseUrl: `${base}/v1`, preset: "sub2api" });
    assert.equal(payload.continue, true);
    assert.equal(payload.systemMessage, "[额度] sub-user | 余额 $12.3");
  });
});

test("provider usage reads AnyRouter/NewAPI-style panel balance", async () => {
  await withServer((req, res) => {
    if (req.url === "/api/usage/token/") {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    if (req.url === "/api/user/self") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        success: true,
        data: { username: "any-user", quota: 3_750_000, used_quota: 1_250_000 },
      }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  }, async (base) => {
    const payload = await runProvider({ baseUrl: `${base}/v1`, preset: "anyrouter" });
    assert.equal(payload.systemMessage, "[额度] any-user | 余额 $7.5 | 已用 $2.5/$10.0");
  });
});

test("provider usage reads Veloera panel balance with Veloera scale", async () => {
  await withServer((req, res) => {
    if (req.url === "/api/user/self") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        success: true,
        data: { username: "velo-user", quota: 10_000_000, used_quota: 2_500_000 },
      }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  }, async (base) => {
    const payload = await runProvider({ baseUrl: `${base}/v1`, preset: "veloera" });
    assert.equal(payload.systemMessage, "[额度] velo-user | 余额 $7.5 | 已用 $2.5/$10.0");
  });
});

test("provider usage fails open when no compatible usage endpoint exists", async () => {
  await withServer((_req, res) => {
    res.statusCode = 404;
    res.end("{}");
  }, async (base) => {
    const payload = await runProvider({ baseUrl: `${base}/v1`, preset: "auto" });
    assert.deepEqual(payload, { continue: true });
  });
});
