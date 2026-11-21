import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("Codex status line shows configured fields and full usage for the displayed thread", { timeout: 10_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-tools-codex-footer-"));
  const sessions = join(home, "sessions");
  mkdirSync(sessions);
  writeFileSync(join(home, "config.jsonc"), '{"providerUsage":{"preset":"sub2api","outputSpeed":true}}\n');

  let releaseGateway;
  const blocked = new Promise((resolve) => { releaseGateway = resolve; });
  const gateway = createServer(async (request, response) => {
    const provider = request.url.split("/")[1];
    if (!["a", "b"].includes(provider) || request.headers.authorization !== `Bearer key-${provider}`) {
      response.writeHead(401).end();
      return;
    }
    await blocked;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(provider === "a" ? { subscription: {
      daily_limit_usd: 180, daily_usage_usd: 27.5,
      weekly_limit_usd: 500, weekly_usage_usd: 98.1,
      expires_at: "2030-11-29T12:00:00Z",
    } } : { balance: 42 }));
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));

  const client = new Client({ name: "statusline-test", version: "1" });
  t.after(async () => {
    releaseGateway();
    await client.close();
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${gateway.address().port}`;
  writeFileSync(join(home, "config.toml"), ['model_provider = "relay_a"', ...["a", "b"].flatMap((id) => [
    `[model_providers.relay_${id}]`,
    `base_url = "${url}/${id === "a" ? "unused" : id}/v1"`,
    `experimental_bearer_token = "key-${id === "a" ? "unused" : id}"`,
  ])].join("\n"));

  const stateFor = (id, tokens) => {
    const cwd = join(home, `workspace-${id}`);
    mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet", `--initial-branch=branch-${id}`], { cwd });
    const sessionId = `00000000-0000-4000-8000-00000000000${id}`;
    const record = (seconds, type, payload) => JSON.stringify({ timestamp: `2026-01-01T00:00:0${seconds}.000Z`, type, payload });
    writeFileSync(join(sessions, `rollout-fixture-${sessionId}.jsonl`), [
      record(0, "event_msg", { type: "task_started", turn_id: "turn" }),
      record(2, "response_item", { type: "message", role: "assistant" }),
      record(2, "token_usage_record", { turn_id: "turn", response_id: "response", usage: { output_tokens: tokens } }),
    ].join("\n"));
    return {
      config: { statusline_items: ["model", "git-branch", "context-remaining", "five-hour-limit", "weekly-limit"] },
      thread: { id: sessionId, workspace: { cwd }, model: { display_name: `Model ${id}`, provider: `relay_${id}` }, usage: { context: { used_percentage: 30 } } },
    };
  };
  const a = stateFor("a", 32);
  const b = stateFor("b", 40);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/statusline/codex-statusline.mjs", import.meta.url))],
    env: {
      CODEX_HOME: home, AGENT_TOOLS_HOME: home,
      PROVIDER_USAGE_BASE_URL: `${url}/a/v1`, PROVIDER_USAGE_API_KEY: "key-a",
    },
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const entry = tools[0]._meta["openai/ui"].entrypoints[0];
  assert.equal(entry.type, "statusline");
  const read = async (state) => {
    const { contents } = await client.readResource({
      uri: entry.resourceUri, _meta: { "com.openai/codex-statusline-state": state },
    }, { timeout: 1500 });
    return JSON.parse(contents[0].text);
  };
  assert.equal(await read(a), "Model a | branch-a | Context 70% left | 16.0 tok/s");
  assert.equal(await read(b), "Model b | branch-b | Context 70% left | 20.0 tok/s");
  assert.equal(await read({
    ...b,
    account: { rate_limits: [{
      limit_id: "codex",
      primary_limit: { window_minutes: 10080, used_percent: 35 },
      secondary_limit: { window_minutes: 300, used_percent: 20 },
    }] },
  }), "Model b | branch-b | Context 70% left | 5h 80% left | weekly 65% left | 20.0 tok/s");
  assert.equal(await read({
    ...b,
    config: { statusline_items: [
      "total-output-tokens", "total-input-tokens", "used-tokens", "context-window-size",
      "estimated-thread-cost", "thread-credits", "permissions", "approval-mode", "fast-mode",
    ] },
    thread: {
      ...b.thread,
      model: { ...b.thread.model, service_tier_display_name: "Fast" },
      permissions: { display_name: "Workspace Write" },
      approval: { policy: "on-request", reviewer: "auto-review" },
      usage: {
        context: { context_window_size: 128000 },
        total: { total_input_tokens: 2400, cache_read_input_tokens: 1000, output_tokens: 200 },
        cost: { total_cost_usd: 0.0042, total_credits: 1.5 },
      },
    },
  }), "200 out | 2.4K in | 1.6K used | 128K window | ~$0.0042 | 1.5 credits | Workspace Write | Approve for me | Fast | 20.0 tok/s");
  releaseGateway();

  for (let tries = 0; tries < 30; tries++) {
    const [first, second] = [await read(a), await read(b)];
    if (first === "Model a | branch-a | Context 70% left | D $27.5/$180 | W $98.1/$500 | Exp 11-29 | 16.0 tok/s" &&
        second === "Model b | branch-b | Context 70% left | balance $42.0 | 20.0 tok/s") {
      execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/updated"], { cwd: a.thread.workspace.cwd });
      assert.equal(await read(a), first.replace(" | branch-a | ", " | updated | "));
      return;
    }
    await delay(25);
  }
  assert.fail("Codex did not render both gateway balances in their respective threads");
});
