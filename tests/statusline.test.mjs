import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATUSLINE_SCRIPT = join(ROOT, "integrations", "statusline", "claude-statusline.mjs");

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

test("Claude statusline appends relay usage snapshot", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-statusline-"));
  const agentHome = join(temp, "agent");
  const cacheDir = join(agentHome, "cache");
  const configFile = join(agentHome, "config.jsonc");
  mkdirSync(cacheDir, { recursive: true });
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
