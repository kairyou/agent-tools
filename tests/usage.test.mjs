import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER_SCRIPT = join(ROOT, "lib", "usage.mjs");
const CODEX_USAGE_HOOK = join(ROOT, "hooks", "codex", "usage-hook.mjs");

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runProvider({ baseUrl, preset = "auto", config = {}, codexHome, agentHome }) {
  const temp = codexHome && agentHome ? "" : mkdtempSync(join(tmpdir(), "agent-tools-provider-"));
  codexHome ||= join(temp, "codex");
  agentHome ||= join(temp, "agent");
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
        AGENT_TOOLS_HOME: agentHome,
        PROVIDER_USAGE_PRESET: preset,
        PROVIDER_USAGE_BASE_URL: "",
        SUB2API_BASE_URL: "",
        OPENAI_BASE_URL: "",
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
    assert.equal(payload.systemMessage, "API | balance $12.3");
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
    assert.equal(payload.systemMessage, "API | balance $7.5 | used $2.5/$10.0");
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
    assert.equal(payload.systemMessage, "API | balance $7.5 | used $2.5/$10.0");
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

test("provider usage caches the successful route for a service root", async () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-provider-cache-"));
  const codexHome = join(temp, "codex");
  const agentHome = join(temp, "agent");
  const seen = [];

  await withServer((req, res) => {
    seen.push(req.url);
    if (req.url === "/v1/usage?days=30") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [] }));
      return;
    }
    if (req.url === "/api/v1/auth/me") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: 0, data: { username: "cached-user", balance: 42 } }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  }, async (base) => {
    const first = await runProvider({ baseUrl: `${base}/v1`, preset: "auto", codexHome, agentHome });
    const second = await runProvider({ baseUrl: `${base}/v1`, preset: "auto", codexHome, agentHome });
    assert.equal(first.systemMessage, "API | balance $42.0");
    assert.equal(second.systemMessage, "API | balance $42.0");
    assert.deepEqual(seen, ["/v1/usage?days=30", "/api/v1/auth/me", "/api/v1/auth/me"]);

    const cache = JSON.parse(readFileSync(join(agentHome, "cache", "usage-routes.json"), "utf8"));
    assert.equal(cache.routes[base].route, "sub2api-auth-me");
    assert.equal(cache.routes[base].path, "/api/v1/auth/me");
  });
});

test("Codex usage hook wrapper logs failures and exits successfully", async () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-usage-hook-"));
  const agentHome = join(temp, "agent");
  const hookDir = join(agentHome, "hooks", "codex");
  mkdirSync(hookDir, { recursive: true });
  copyFileSync(CODEX_USAGE_HOOK, join(hookDir, "usage-hook.mjs"));

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(hookDir, "usage-hook.mjs")], {
      cwd: ROOT,
      env: {
        ...process.env,
        AGENT_TOOLS_HOME: agentHome,
        AGENT_TOOLS_USAGE_HOOK_LOG_BYTES: "1024",
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

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.continue, true);
  assert.match(payload.systemMessage, /API usage hook failed; see .+usage-hook\.log/);

  const logPath = join(agentHome, "logs", "usage-hook.log");
  const log = readFileSync(logPath, "utf8");
  assert.match(log, /missing usage script/);
});

test("Codex usage hook wrapper caps failure log size", async () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-usage-hook-log-"));
  const agentHome = join(temp, "agent");
  const hookDir = join(agentHome, "hooks", "codex");
  const logDir = join(agentHome, "logs");
  const logPath = join(logDir, "usage-hook.log");
  mkdirSync(hookDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  copyFileSync(CODEX_USAGE_HOOK, join(hookDir, "usage-hook.mjs"));
  writeFileSync(logPath, `${"x".repeat(5000)}\n`);

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(hookDir, "usage-hook.mjs")], {
      cwd: ROOT,
      env: {
        ...process.env,
        AGENT_TOOLS_HOME: agentHome,
        AGENT_TOOLS_USAGE_HOOK_LOG_BYTES: "1024",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("exit", (status) => {
      resolve({ status });
    });
  });

  assert.equal(result.status, 0);
  assert.ok(statSync(logPath).size < 1600);
  assert.match(readFileSync(logPath, "utf8"), /log rotated/);
});
