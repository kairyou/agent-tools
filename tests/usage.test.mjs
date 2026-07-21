import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER_SCRIPT = join(ROOT, "integrations", "usage", "core.mjs");
const USAGE_CLI = join(ROOT, "integrations", "usage", "cli.mjs");
const DIST_USAGE_CLI = join(ROOT, "dist", "usage", "cli.mjs");
const CODEX_USAGE_HOOK = join(ROOT, "integrations", "usage", "codex-hook.mjs");

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runProvider({ baseUrl, preset = "auto", config = {}, codexHome, agentHome, env = {} }) {
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
  // Comment + trailing commas: every provider test exercises tolerant parsing.
  writeFileSync(
    join(agentHome, "config.jsonc"),
    `// agent-tools test config\n{\n  "providerUsage": ${JSON.stringify(config)},\n}\n`
  );

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
        // Snapshot reuse is covered by its own test; keep the rest live.
        AGENT_TOOLS_USAGE_SNAPSHOT_TTL_MS: "0",
        ...env,
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

async function runUsageCli(agent, env, entry = USAGE_CLI) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, agent ? [entry, "--agent", agent] : [entry], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

test("local usage CLI queries Codex and Claude without a package manager", async () => {
  await withServer((req, res) => {
    if (req.url === "/v1/usage?days=30") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ balance: 18.75 }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  }, async (baseUrl) => {
    const temp = mkdtempSync(join(tmpdir(), "agent-tools-usage-cli-"));
    const codexHome = join(temp, "codex");
    const agentHome = join(temp, "agent");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(agentHome, { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-key" }));
    writeFileSync(
      join(codexHome, "config.toml"),
      `model_provider = "mock"\n[model_providers.mock]\nname = "Mock"\nbase_url = "${baseUrl}/v1"\n`
    );
    writeFileSync(join(agentHome, "config.jsonc"), JSON.stringify({ providerUsage: {} }));
    const common = {
      AGENT_TOOLS_HOME: agentHome,
      PROVIDER_USAGE_PRESET: "sub2api",
      PROVIDER_USAGE_BASE_URL: "",
      SUB2API_BASE_URL: "",
    };

    const codex = await runUsageCli("codex", {
      ...common,
      CODEX_HOME: codexHome,
      OPENAI_BASE_URL: "",
    });
    assert.deepEqual(codex, { status: 0, stdout: "API | balance $18.8\n", stderr: "" });

    const claudeEnv = {
      ...common,
      ANTHROPIC_BASE_URL: `${baseUrl}/v1`,
      ANTHROPIC_AUTH_TOKEN: "test-key",
      ANTHROPIC_API_KEY: "",
    };
    const claude = await runUsageCli("claude", claudeEnv);
    assert.deepEqual(claude, { status: 0, stdout: "API | balance $18.8\n", stderr: "" });

    // The bundled dist entry must behave exactly like the source entry.
    const bundled = await runUsageCli("claude", claudeEnv, DIST_USAGE_CLI);
    assert.deepEqual(bundled, claude);
  });
});

test("local usage CLI rejects unsupported agents without querying", async () => {
  const result = await runUsageCli("opencode", {});
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Unsupported agent: opencode\n");

  const missing = await runUsageCli(null, {});
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr, "Missing --agent <claude|codex>\n");
});

test("custom routes from config.jsonc probe first and are preset-selectable", async () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-custom-route-"));
  const codexHome = join(temp, "codex");
  const agentHome = join(temp, "agent");
  mkdirSync(join(agentHome, "custom"), { recursive: true });
  writeFileSync(
    join(agentHome, "custom", "my-gateway.mjs"),
    'export const meta = { id: "my-gateway" };\n' +
      "export async function run(context, { requestJson, agentConfig }) {\n" +
      '  if (typeof requestJson !== "function") throw new Error("helpers missing");\n' +
      "  const config = await agentConfig();\n" +
      '  if (!Array.isArray(config.routes)) throw new Error("agentConfig missing");\n' +
      "  return { text: `API | custom $1 ${context.label}` };\n" +
      "}\n"
  );
  const config = { routes: ["custom/my-gateway.mjs"] };

  // Auto mode: the declared route wins before any built-in probe (the base URL
  // points at a closed port, so a network probe would fail loudly).
  const auto = await runProvider({ baseUrl: "http://127.0.0.1:9/v1", config, codexHome, agentHome });
  assert.equal(auto.systemMessage, "API | custom $1 MOCK");

  const byPreset = await runProvider({
    baseUrl: "http://127.0.0.1:9/v1",
    preset: "my-gateway",
    config,
    codexHome,
    agentHome,
  });
  assert.equal(byPreset.systemMessage, "API | custom $1 MOCK");
});

test("packaged routes under dist/usage/routes load automatically", async () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-packaged-route-"));
  const codexHome = join(temp, "codex");
  const agentHome = join(temp, "agent");
  const packagedDir = join(agentHome, "dist", "usage", "routes");
  mkdirSync(packagedDir, { recursive: true });
  writeFileSync(
    join(packagedDir, "corp.mjs"),
    "export async function run(context) {\n" +
      "  return { text: `API | packaged ${context.label}` };\n" +
      "}\n"
  );

  // No config needed: the packaged route probes before the built-ins.
  const auto = await runProvider({ baseUrl: "http://127.0.0.1:9/v1", codexHome, agentHome });
  assert.equal(auto.systemMessage, "API | packaged MOCK");

  // A config-declared route with the same id overrides the packaged one.
  mkdirSync(join(agentHome, "custom"), { recursive: true });
  writeFileSync(
    join(agentHome, "custom", "corp.mjs"),
    "export async function run() {\n" +
      '  return { text: "API | declared" };\n' +
      "}\n"
  );
  const declared = await runProvider({
    baseUrl: "http://127.0.0.1:9/v1",
    config: { routes: ["custom/corp.mjs"] },
    codexHome,
    agentHome,
  });
  assert.equal(declared.systemMessage, "API | declared");
});

test("a broken custom route is skipped and built-ins still answer", async () => {
  await withServer((req, res) => {
    if (req.url === "/api/usage/token/") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { quota: 10_000_000, used_quota: 2_500_000 } }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  }, async (base) => {
    const temp = mkdtempSync(join(tmpdir(), "agent-tools-broken-route-"));
    const codexHome = join(temp, "codex");
    const agentHome = join(temp, "agent");
    mkdirSync(join(agentHome, "custom"), { recursive: true });
    writeFileSync(join(agentHome, "custom", "broken.mjs"), "export const nothing = 1;\n");

    const payload = await runProvider({
      baseUrl: `${base}/v1`,
      preset: "new-api",
      config: { routes: ["custom/broken.mjs"] },
      codexHome,
      agentHome,
    });
    assert.equal(payload.systemMessage, "API | balance $15.0 | used $5.0/$20.0");
  });
});

test("provider usage reads One API billing with the relay API key", async () => {
  const seen = [];
  await withServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/dashboard/billing/subscription") {
      res.end(JSON.stringify({ object: "billing_subscription", hard_limit_usd: 20 }));
      return;
    }
    if (req.url === "/v1/dashboard/billing/usage") {
      res.end(JSON.stringify({ object: "list", total_usage: 500 }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  }, async (base) => {
    const payload = await runProvider({ baseUrl: `${base}/v1`, preset: "one-api" });
    assert.equal(payload.systemMessage, "API | balance $15.0 | used $5.0/$20.0");
    assert.deepEqual(seen, [
      { url: "/v1/dashboard/billing/subscription", authorization: "Bearer test-key" },
      { url: "/v1/dashboard/billing/usage", authorization: "Bearer test-key" },
    ]);
  });
});

test("provider usage fails open when no compatible usage endpoint exists", async () => {
  const seen = [];
  await withServer((req, res) => {
    seen.push(req.url);
    res.statusCode = 404;
    res.end("{}");
  }, async (base) => {
    const payload = await runProvider({ baseUrl: `${base}/v1`, preset: "auto" });
    assert.deepEqual(payload, { continue: true });
    assert.deepEqual(seen, [
      "/v1/usage?days=30",
      "/api/usage/token/",
      "/v1/dashboard/billing/subscription",
    ]);
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
    if (req.url === "/api/usage/token/") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { quota: 10_000_000, used_quota: 2_500_000 } }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  }, async (base) => {
    const first = await runProvider({ baseUrl: `${base}/v1`, preset: "auto", codexHome, agentHome });
    const second = await runProvider({ baseUrl: `${base}/v1`, preset: "auto", codexHome, agentHome });
    assert.equal(first.systemMessage, "API | balance $15.0 | used $5.0/$20.0");
    assert.equal(second.systemMessage, "API | balance $15.0 | used $5.0/$20.0");
    assert.deepEqual(seen, ["/v1/usage?days=30", "/api/usage/token/", "/api/usage/token/"]);

    const cache = JSON.parse(readFileSync(join(agentHome, "cache", "usage-routes.json"), "utf8"));
    assert.equal(cache.routes[base].route, "newapi-token");
    assert.equal(cache.routes[base].path, "/api/usage/token/");
  });
});

test("hook mode reuses a fresh snapshot instead of re-querying", async () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-provider-ttl-"));
  const codexHome = join(temp, "codex");
  const agentHome = join(temp, "agent");
  const seen = [];

  await withServer((req, res) => {
    seen.push(req.url);
    if (req.url === "/api/usage/token/") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { quota: 10_000_000, used_quota: 2_500_000 } }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  }, async (base) => {
    const ttl = { env: { AGENT_TOOLS_USAGE_SNAPSHOT_TTL_MS: "60000" } };
    const first = await runProvider({ baseUrl: `${base}/v1`, preset: "new-api", codexHome, agentHome, ...ttl });
    const second = await runProvider({ baseUrl: `${base}/v1`, preset: "new-api", codexHome, agentHome, ...ttl });
    assert.equal(first.systemMessage, "API | balance $15.0 | used $5.0/$20.0");
    assert.equal(second.systemMessage, "API | balance $15.0 | used $5.0/$20.0");
    // The second hook call is served from the snapshot and makes no request.
    assert.deepEqual(seen, ["/api/usage/token/"]);
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
