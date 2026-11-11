import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATUSLINE_SCRIPT = join(ROOT, "dist", "statusline", "claude-statusline.mjs");

test("Claude statusline renders configured fields in configured order", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-statusline-"));
  const projectDir = join(temp, "project");
  mkdirSync(projectDir, { recursive: true });
  const configFile = join(temp, "config.jsonc");
  writeFileSync(configFile, JSON.stringify({
    statusline: {
      fields: ["directory", "model", "context"],
      separator: " / ",
      symbols: { context: "ctx" },
    },
  }));

  const input = {
    workspace: {
      current_dir: projectDir,
      project_dir: projectDir,
    },
    model: {
      display_name: "Claude Opus 4.8",
    },
    context_window: {
      used_percentage: 42.2,
    },
  };

  const result = spawnSync(process.execPath, [STATUSLINE_SCRIPT], {
    input: JSON.stringify(input),
    env: {
      ...process.env,
      AGENT_TOOLS_HOME: temp,
      AGENT_TOOLS_USAGE_REFRESH: "0",
      ANTHROPIC_BASE_URL: "",
      PROVIDER_USAGE_BASE_URL: "",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${basename(projectDir)} / Opus 4.8 / ctx 42%`);
});

test("Claude statusline keeps empty official rate limit placeholders", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-statusline-"));
  const configFile = join(temp, "config.jsonc");
  writeFileSync(configFile, JSON.stringify({
    statusline: {
      fields: ["model", "fiveHour", "week"],
    },
  }));

  const result = spawnSync(process.execPath, [STATUSLINE_SCRIPT], {
    input: JSON.stringify({ model: { display_name: "Claude Sonnet 4.5" } }),
    env: {
      ...process.env,
      AGENT_TOOLS_HOME: temp,
      ANTHROPIC_BASE_URL: "",
      PROVIDER_USAGE_BASE_URL: "",
      AGENT_TOOLS_USAGE_REFRESH: "0",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "Sonnet 4.5 | 5h – | w –");
});

test("Claude statusline hides empty rate limit placeholders for relay base URLs", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-statusline-"));
  const configFile = join(temp, "config.jsonc");
  writeFileSync(configFile, JSON.stringify({
    statusline: {
      fields: ["model", "fiveHour", "week"],
    },
  }));

  const result = spawnSync(process.execPath, [STATUSLINE_SCRIPT], {
    input: JSON.stringify({ model: { display_name: "Claude Sonnet 4.5" } }),
    env: {
      ...process.env,
      AGENT_TOOLS_HOME: temp,
      ANTHROPIC_BASE_URL: "https://relay.example.com/v1",
      PROVIDER_USAGE_BASE_URL: "",
      AGENT_TOOLS_USAGE_REFRESH: "0",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "Sonnet 4.5");
});

test("Claude statusline keeps appending complete relay usage for existing fields", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-statusline-"));
  const agentHome = join(temp, "agent");
  const cacheDir = join(agentHome, "cache");
  const configFile = join(agentHome, "config.jsonc");
  mkdirSync(cacheDir, { recursive: true });
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  writeFileSync(configFile, JSON.stringify({
    statusline: {
      fields: ["model", "fiveHour", "week"],
    },
  }));
  writeFileSync(join(cacheDir, "usage-snapshot.json"), JSON.stringify({
    version: 1,
    items: {
      "https://relay.example.com": {
        text: "balance $362 | today $61.7 | 30d $566",
        source: "v1-usage",
        baseUrl: "https://relay.example.com/v1",
        updatedAt: new Date().toISOString(),
      },
    },
  }));

  const result = spawnSync(process.execPath, [STATUSLINE_SCRIPT], {
    input: JSON.stringify({ model: { display_name: "Claude Sonnet 4.5" } }),
    env: {
      ...process.env,
      AGENT_TOOLS_HOME: agentHome,
      ANTHROPIC_BASE_URL: "https://relay.example.com/v1",
      PROVIDER_USAGE_BASE_URL: "",
      AGENT_TOOLS_USAGE_REFRESH: "0",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    "Sonnet 4.5 | balance $362 | today $61.7 | 30d $566"
  );
});

test("showProviderUsage hides only gateway usage and skips background refresh", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-usage-block-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  mkdirSync(join(temp, "cache"));
  mkdirSync(join(temp, "dist", "usage"), { recursive: true });
  writeFileSync(join(temp, "dist", "usage", "core.mjs"), "process.exit(0);\n");
  const snapshot = join(temp, "cache", "usage-snapshot.json");
  const render = (showProviderUsage) => {
    writeFileSync(join(temp, "config.jsonc"), JSON.stringify({ statusline: { fields: ["model"], showProviderUsage, separator: " / " } }));
    const result = spawnSync(process.execPath, [STATUSLINE_SCRIPT], {
      input: JSON.stringify({ model: { id: "custom-model" } }), encoding: "utf8",
      env: { ...process.env, AGENT_TOOLS_HOME: temp, PROVIDER_USAGE_BASE_URL: "https://relay.example.com/v1", PROVIDER_USAGE_API_KEY: "fixture-key", AGENT_TOOLS_USAGE_REFRESH: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout;
  };
  writeFileSync(snapshot, JSON.stringify({ items: { "https://relay.example.com": { text: "balance $1 | today $2" } } }));
  assert.equal(render(false), "custom-model");
  assert.equal(existsSync(join(temp, "cache", "usage-refresh-state.json")), false);
  writeFileSync(snapshot, JSON.stringify({ items: { "https://relay.example.com": { text: "balance $1 | today $2", updatedAt: new Date().toISOString() } } }));
  assert.equal(render(undefined), "custom-model / balance $1 | today $2");
  assert.equal(render(true), "custom-model / balance $1 | today $2");
  assert.equal(existsSync(join(temp, "cache", "usage-refresh-state.json")), false);
});

test("custom-model speed uses transcript independently of provider usage settings and cache", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-custom-speed-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const transcript = join(temp, "session.jsonl");
  writeFileSync(transcript, [
    { type: "user", timestamp: "2026-11-10T00:00:00Z" },
    { type: "assistant", timestamp: "2026-11-10T00:00:10Z", message: { id: "custom-response", usage: { output_tokens: 344 } } },
  ].map(JSON.stringify).join("\n"));
  mkdirSync(join(temp, "cache"));
  writeFileSync(join(temp, "cache", "usage-snapshot.json"), JSON.stringify({ items: { "https://relay.example.com": { text: "today $0.2 | 7d $16.5" } } }));
  for (const enabled of [false, true]) for (const showProviderUsage of [false, true]) {
    writeFileSync(join(temp, "config.jsonc"), JSON.stringify({ statusline: { fields: ["model", "outputSpeed"], showProviderUsage }, providerUsage: { outputSpeed: enabled } }));
    const result = spawnSync(process.execPath, [STATUSLINE_SCRIPT], {
      input: JSON.stringify({ model: { id: "custom-model" }, transcript_path: transcript }), encoding: "utf8",
      env: { ...process.env, AGENT_TOOLS_HOME: temp, ANTHROPIC_BASE_URL: "https://relay.example.com/v1", PROVIDER_USAGE_BASE_URL: "", AGENT_TOOLS_USAGE_REFRESH: "0" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `custom-model | 34.4 tok/s${showProviderUsage ? " | today $0.2 | 7d $16.5" : ""}`);
  }
});

test("outputSpeed estimates the latest response and deduplicates streaming usage", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-speed-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const transcript = join(temp, "session.jsonl");
  const user = (seconds) => ({ type: "user", timestamp: new Date(seconds * 1000).toISOString() });
  const assistant = (id, seconds, tokens) => ({
    type: "assistant", timestamp: new Date(seconds * 1000).toISOString(),
    message: { id, usage: { output_tokens: tokens } },
  });
  const entries = [
    user(0), assistant("old", 2, 200),
    user(10), assistant("latest", 11, 10), assistant("latest", 20, 382),
    { type: "progress", timestamp: new Date(90_000).toISOString() },
    { ...assistant("child", 100, 9999), isSidechain: true },
  ];
  const render = (records, input = {}) => {
    writeFileSync(transcript, records.map((record) => typeof record === "string" ? record : JSON.stringify(record)).join("\n") + "\n");
    const result = spawnSync(process.execPath, [STATUSLINE_SCRIPT, "--fields", "model,outputSpeed,context"], {
      input: JSON.stringify({
        model: { display_name: "Claude Opus 4.8" },
        context_window: { used_percentage: 42 },
        transcript_path: transcript,
        ...input,
      }),
      env: {
        ...process.env, AGENT_TOOLS_HOME: temp, AGENT_TOOLS_USAGE_REFRESH: "0",
        ANTHROPIC_BASE_URL: "", PROVIDER_USAGE_BASE_URL: "",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout;
  };
  assert.equal(render(entries), "Opus 4.8 | 38.2 tok/s | ctx 42%");
  // Idle repaints and partial JSONL writes do not change the last response's speed.
  assert.equal(render([...entries, user(200), '{"type":']), "Opus 4.8 | 38.2 tok/s | ctx 42%");
  assert.equal(render([...entries, user(200), assistant("next", 202, 20)]), "Opus 4.8 | 10.0 tok/s | ctx 42%");
  assert.equal(render([user(0), assistant("zero", 2, 0)]), "Opus 4.8 | 0.0 tok/s | ctx 42%");
  const hidden = "Opus 4.8 | ctx 42%";
  assert.equal(render(entries, { transcript_path: join(temp, "missing") }), hidden);
  assert.equal(render(entries, { transcript_path: null }), hidden);
  assert.equal(render([assistant("unpaired", 2, 20)]), hidden);
  assert.equal(render([user(2), assistant("zero-time", 2, 20)]), hidden);
  assert.equal(render([user(3), assistant("negative-time", 2, 20)]), hidden);
  assert.equal(render([user(0), assistant("bad", 2, -1)]), hidden);
  assert.equal(render([user(0), assistant("bad", 2, "20")]), hidden);
  assert.equal(render([...entries, { type: "system", subtype: "compact_boundary" }]), hidden);
  // The bounded tail must not pair a response with a user outside the read window.
  assert.equal(render([user(0), JSON.stringify({ type: "progress", text: "x".repeat(1024 * 1024) }), assistant("unpaired", 2, 20)]), hidden);
  assert.equal(render(["x".repeat(1024 * 1024), ...entries]), "Opus 4.8 | 38.2 tok/s | ctx 42%");
});
