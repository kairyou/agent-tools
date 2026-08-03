import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "dist", "log", "hook.mjs");
const INSTALL_SCRIPT = join(ROOT, "scripts", "install.mjs");

function makeHome(config) {
  const home = mkdtempSync(join(tmpdir(), "agent-tools-log-"));
  writeFileSync(join(home, "config.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
  return home;
}

function fireEvent(home, event) {
  const result = spawnSync(process.execPath, [HOOK], {
    cwd: ROOT,
    env: { ...process.env, AGENT_TOOLS_HOME: home },
    input: JSON.stringify(event),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function today() {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

const SUBSTANTIVE_PROMPT = "重构导入模块的数据解析流程, 并补充回归测试覆盖新的字段映射";
const SUBSTANTIVE_OUTCOME = "已完成导入模块重构: 拆分了数据解析与字段映射, 新增 12 个回归用例, 全部通过.";

function fireTurn(home, { sessionId = "session-1", prompt = SUBSTANTIVE_PROMPT, outcome = SUBSTANTIVE_OUTCOME } = {}) {
  fireEvent(home, {
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    cwd: ROOT,
    prompt,
  });
  fireEvent(home, {
    hook_event_name: "Stop",
    session_id: sessionId,
    cwd: ROOT,
    last_assistant_message: outcome,
  });
}

test("daily format writes a dated marker block into a single file", () => {
  const home = makeHome({ log: { output: join("{{home}}", "work-log.md") } });
  const output = join(home, "work-log.md");
  writeFileSync(join(home, "config.jsonc"), `${JSON.stringify({ log: { output } }, null, 2)}\n`);

  fireTurn(home);

  const text = readFileSync(output, "utf8");
  const day = today();
  assert.ok(text.includes(`+ ${day}`), text);
  assert.ok(text.includes(`<!-- log:${day}:start -->`), text);
  assert.ok(text.includes(`<!-- log:${day}:end -->`), text);
  assert.ok(text.includes("1. agent-tools: 已完成导入模块重构"), text);
});

test("daily format refreshes its block without duplicating the date", () => {
  const home = makeHome({});
  const output = join(home, "work-log.md");
  writeFileSync(join(home, "config.jsonc"), `${JSON.stringify({ log: { output } }, null, 2)}\n`);

  fireTurn(home, { sessionId: "session-1" });
  fireTurn(home, {
    sessionId: "session-2",
    prompt: "排查 statusline 在 Windows 下的乱码问题并修复编码处理",
    outcome: "定位到编码问题出在 BOM 处理, 已修复并验证 Windows 下显示正常.",
  });

  const text = readFileSync(output, "utf8");
  const day = today();
  assert.equal(text.split(`+ ${day}`).length, 2, text);
  assert.equal(text.split(`<!-- log:${day}:start -->`).length, 2, text);
  assert.ok(text.includes("1. agent-tools:"), text);
  assert.ok(text.includes("2. agent-tools:"), text);
});

test("daily format keeps user lines outside the markers", () => {
  const home = makeHome({});
  const output = join(home, "work-log.md");
  writeFileSync(join(home, "config.jsonc"), `${JSON.stringify({ log: { output } }, null, 2)}\n`);
  const day = today();
  writeFileSync(
    output,
    [`+ 2020-01-01`, `  手写的历史记录`, ``, `+ ${day}`, `  今天的手写备注`, ``, `## 待办`, `- 明天的事`, ``].join("\n")
  );

  fireTurn(home);

  const text = readFileSync(output, "utf8");
  assert.ok(text.includes("手写的历史记录"), text);
  assert.ok(text.includes("今天的手写备注"), text);
  assert.ok(text.includes("## 待办"), text);
  assert.equal(text.split(`+ ${day}`).length, 2, text);
  const markerIndex = text.indexOf(`<!-- log:${day}:start -->`);
  const noteIndex = text.indexOf("今天的手写备注");
  const todoIndex = text.indexOf("## 待办");
  assert.ok(markerIndex > noteIndex, "marked block appends below the user's lines");
  assert.ok(markerIndex < todoIndex, "marked block stays inside the dated section");
});

test("a trivial follow-up prompt does not overwrite the previous turn's result", () => {
  const home = makeHome({});
  const output = join(home, "work-log.md");
  writeFileSync(join(home, "config.jsonc"), `${JSON.stringify({ log: { output } }, null, 2)}\n`);

  fireTurn(home);
  fireEvent(home, { hook_event_name: "UserPromptSubmit", session_id: "session-1", cwd: ROOT, prompt: "你好" });
  fireEvent(home, { hook_event_name: "Stop", session_id: "session-1", cwd: ROOT, last_assistant_message: "你好!" });

  const text = readFileSync(output, "utf8");
  assert.ok(text.includes("已完成导入模块重构"), text);
  assert.equal(text.includes("你好"), false, "the greeting must not replace the real outcome");
});

test("scopes inheriting the same output merge into one file", () => {
  const home = makeHome({});
  const output = join(home, "work-log.md");
  const projectB = join(home, "project-b");
  mkdirSync(projectB, { recursive: true });
  writeFileSync(
    join(home, "config.jsonc"),
    `${JSON.stringify({ log: { output, projects: [ROOT, projectB] } }, null, 2)}\n`
  );

  fireTurn(home, { sessionId: "in-root" });
  fireTurn(home, { sessionId: "in-b" });
  fireEvent(home, {
    hook_event_name: "UserPromptSubmit",
    session_id: "in-b2",
    cwd: projectB,
    prompt: "排查 statusline 在 Windows 下的乱码问题并修复编码处理",
  });
  fireEvent(home, {
    hook_event_name: "Stop",
    session_id: "in-b2",
    cwd: projectB,
    last_assistant_message: "定位到编码问题出在 BOM 处理, 已修复并验证 Windows 下显示正常.",
  });

  const text = readFileSync(output, "utf8");
  assert.ok(text.includes("已完成导入模块重构"), text);
  assert.ok(text.includes("定位到编码问题出在 BOM 处理"), text);
});

test("zero config writes to the default location", () => {
  const home = makeHome({});

  fireTurn(home);

  const output = join(home, "logs", "ai-log.md");
  assert.ok(existsSync(output), "default output file should exist");
  assert.ok(readFileSync(output, "utf8").includes("已完成导入模块重构"));
});

test("concurrent sessions across agents all reach the log", async () => {
  const home = makeHome({});
  const output = join(home, "work-log.md");
  writeFileSync(join(home, "config.jsonc"), `${JSON.stringify({ log: { output } }, null, 2)}\n`);

  function fire(event) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [HOOK], {
        cwd: ROOT,
        env: { ...process.env, AGENT_TOOLS_HOME: home },
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("exit", () => resolve(stderr));
      child.on("error", () => resolve(stderr));
      child.stdin.write(JSON.stringify(event));
      child.stdin.end();
    });
  }

  // Mirrors reality: each agent serializes its own session's events, while
  // sessions from different agents run concurrently against one day state.
  const SESSIONS = 10;
  const sessions = [];
  for (let i = 0; i < SESSIONS; i += 1) {
    sessions.push(
      (async () => {
        const first = await fire({
          hook_event_name: "UserPromptSubmit",
          session_id: `s${i}`,
          cwd: ROOT,
          prompt: `重构模块${i}的数据解析流程, 补充回归测试覆盖新字段映射`,
        });
        const second = await fire({
          hook_event_name: "Stop",
          session_id: `s${i}`,
          cwd: ROOT,
          last_assistant_message: `已完成模块${i}的重构, 新增回归用例并全部通过验证.`,
        });
        return [first, second].filter(Boolean);
      })()
    );
  }

  const failures = (await Promise.all(sessions)).flat();
  assert.deepEqual(failures, [], "no hook run may fail under concurrency");

  const text = readFileSync(output, "utf8");
  const missing = [];
  for (let i = 0; i < SESSIONS; i += 1) {
    if (!text.includes(`已完成模块${i}的重构`)) missing.push(i);
  }
  assert.deepEqual(missing, [], `sessions missing from the log: ${missing.join(", ")}\n${text}`);
});

test("enabled: false pauses recording without uninstalling", () => {
  const home = makeHome({});
  const output = join(home, "work-log.md");
  writeFileSync(
    join(home, "config.jsonc"),
    `${JSON.stringify({ log: { output, enabled: false } }, null, 2)}\n`
  );

  fireTurn(home);

  assert.equal(existsSync(output), false);
});

test("trivial prompts are not recorded", () => {
  const home = makeHome({});
  const output = join(home, "work-log.md");
  writeFileSync(join(home, "config.jsonc"), `${JSON.stringify({ log: { output } }, null, 2)}\n`);

  fireEvent(home, { hook_event_name: "UserPromptSubmit", session_id: "s", cwd: ROOT, prompt: "你好" });
  fireEvent(home, { hook_event_name: "Stop", session_id: "s", cwd: ROOT, last_assistant_message: "你好!" });

  assert.equal(existsSync(output), false);
});

test("projects allowlist scopes recording and per-project format", () => {
  const home = makeHome({});
  const dailyOutput = join(home, "work-log.md");
  const projectB = join(home, "project-b");
  const reportsDir = join(home, "reports-b");
  mkdirSync(projectB, { recursive: true });
  writeFileSync(
    join(home, "config.jsonc"),
    `${JSON.stringify(
      {
        log: {
          output: dailyOutput,
          projects: [ROOT, { path: projectB, format: "detailed", output: reportsDir, language: "en" }],
        },
      },
      null,
      2
    )}\n`
  );

  // Session inside ROOT: recorded into the daily file.
  fireTurn(home);
  // Session outside every listed project: skipped entirely.
  fireEvent(home, {
    hook_event_name: "UserPromptSubmit",
    session_id: "outside",
    cwd: tmpdir(),
    prompt: SUBSTANTIVE_PROMPT,
  });
  // Session inside project-b: recorded as a detailed English report.
  fireEvent(home, {
    hook_event_name: "UserPromptSubmit",
    session_id: "in-b",
    cwd: projectB,
    prompt: SUBSTANTIVE_PROMPT,
  });
  fireEvent(home, {
    hook_event_name: "Stop",
    session_id: "in-b",
    cwd: projectB,
    last_assistant_message: SUBSTANTIVE_OUTCOME,
  });

  const daily = readFileSync(dailyOutput, "utf8");
  assert.equal(daily.split("已完成导入模块重构").length, 2, daily);

  const report = readFileSync(join(reportsDir, `${today()}.md`), "utf8");
  assert.ok(report.includes("## Overview"), report);
  assert.ok(report.includes("- Prompts: 1"), report);
  assert.equal(report.includes("outside"), false, "unlisted session must not leak into reports");
});

test("a scope deeper than the repo labels items with the scope directory", () => {
  const home = makeHome({});
  const output = join(home, "work-log.md");
  // ROOT is a git repo; scoping to its tests/ dir mimics a monorepo team dir.
  const teamDir = join(ROOT, "tests");
  writeFileSync(
    join(home, "config.jsonc"),
    `${JSON.stringify({ log: { output, projects: [teamDir] } }, null, 2)}\n`
  );

  fireEvent(home, {
    hook_event_name: "UserPromptSubmit",
    session_id: "mono",
    cwd: teamDir,
    prompt: SUBSTANTIVE_PROMPT,
  });
  fireEvent(home, {
    hook_event_name: "Stop",
    session_id: "mono",
    cwd: teamDir,
    last_assistant_message: SUBSTANTIVE_OUTCOME,
  });

  const text = readFileSync(output, "utf8");
  assert.ok(text.includes("1. tests:"), text);
});

test("detailed format writes a per-day report with language strings", () => {
  const home = makeHome({});
  const outputDir = join(home, "reports");
  writeFileSync(
    join(home, "config.jsonc"),
    `${JSON.stringify({ log: { output: outputDir, format: "detailed", language: "en" } }, null, 2)}\n`
  );

  fireTurn(home);
  fireEvent(home, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: ROOT,
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  });

  const report = readFileSync(join(outputDir, `${today()}.md`), "utf8");
  assert.ok(report.includes(`# AI Log - ${today()}`), report);
  assert.ok(report.includes("## Overview"), report);
  assert.ok(report.includes("Request"), report);
  assert.ok(report.includes(SUBSTANTIVE_PROMPT), report);
});

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

test("code fences inside outcomes do not break the detailed report", () => {
  const home = makeHome({});
  const outputDir = join(home, "reports");
  writeFileSync(
    join(home, "config.jsonc"),
    `${JSON.stringify({ log: { output: outputDir, format: "detailed" } }, null, 2)}\n`
  );

  fireTurn(home, {
    outcome: "修复完成, 示例代码如下:\n```js\nconst a = 1;\n```\n以上改动已验证.",
  });

  const report = readFileSync(join(outputDir, `${today()}.md`), "utf8");
  assert.ok(report.includes("````text"), "outer fence must outgrow the embedded one");
  assert.ok(report.includes("```js"), "embedded fence survives verbatim");
});

// Payload shapes below mirror a captured real OpenCode 1.18 run.
test("opencode adapter translates plugin events into a log entry", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-tools-log-oc-"));
  const output = join(home, "work-log.md");
  writeFileSync(join(home, "config.jsonc"), `${JSON.stringify({ log: { output } }, null, 2)}\n`);

  const previousHome = process.env.AGENT_TOOLS_HOME;
  process.env.AGENT_TOOLS_HOME = home;
  try {
    const { AgentToolsLog } = await import(
      pathToFileURL(join(ROOT, "dist", "log", "opencode-plugin.mjs")).href
    );
    const hooks = await AgentToolsLog({ directory: ROOT });

    await hooks["chat.message"](
      { sessionID: "ses_1" },
      {
        message: { role: "user", sessionID: "ses_1" },
        parts: [{ type: "text", text: SUBSTANTIVE_PROMPT }],
      }
    );
    // The spawned hook processes race each other; wait for the prompt to land
    // in the day state before firing the turn-ending events.
    const statePath = join(home, "cache", "log", `${today()}.state.json`);
    const stateReady = await waitFor(
      () => existsSync(statePath) && readFileSync(statePath, "utf8").includes('"turn_id"')
    );
    assert.ok(stateReady, "prompt event should reach the day state");

    await hooks.event({
      event: { type: "message.updated", properties: { info: { role: "assistant", id: "msg_1" } } },
    });
    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: { type: "text", messageID: "msg_1", sessionID: "ses_1", text: SUBSTANTIVE_OUTCOME },
        },
      },
    });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });

    const done = await waitFor(
      () => existsSync(output) && readFileSync(output, "utf8").includes("已完成导入模块重构")
    );
    assert.ok(done, existsSync(output) ? readFileSync(output, "utf8") : "log file missing");
    const text = readFileSync(output, "utf8");
    assert.ok(text.includes(`<!-- log:${today()}:start -->`), text);
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_TOOLS_HOME;
    else process.env.AGENT_TOOLS_HOME = previousHome;
  }
});

test("opencode adapter baselines files so the detailed diff is not unknown", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-tools-log-oc-diff-"));
  const outputDir = join(home, "reports");
  const target = join(home, "sample.txt");
  writeFileSync(target, "line1\n");
  writeFileSync(
    join(home, "config.jsonc"),
    `${JSON.stringify({ log: { output: outputDir, format: "detailed", language: "en" } }, null, 2)}\n`
  );

  const previousHome = process.env.AGENT_TOOLS_HOME;
  process.env.AGENT_TOOLS_HOME = home;
  try {
    const { AgentToolsLog } = await import(
      pathToFileURL(join(ROOT, "dist", "log", "opencode-plugin.mjs")).href
    );
    const hooks = await AgentToolsLog({ directory: home });

    await hooks["chat.message"](
      { sessionID: "ses_d" },
      { message: { role: "user", sessionID: "ses_d" }, parts: [{ type: "text", text: SUBSTANTIVE_PROMPT }] }
    );
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: "ses_d" },
      { args: { filePath: target } }
    );
    // Wait for the baseline snapshot before mutating the file.
    const statePath = join(home, "cache", "log", `${today()}.state.json`);
    const baselined = await waitFor(
      () => existsSync(statePath) && readFileSync(statePath, "utf8").includes('"snapshot_kind": "text"')
    );
    assert.ok(baselined, "baseline snapshot should be captured from the before event");

    writeFileSync(target, "line1\nline2\n");
    await hooks["tool.execute.after"](
      { tool: "write", sessionID: "ses_d", args: { filePath: target } },
      { metadata: { files: [{ filePath: target }] } }
    );
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_d" } } });

    const reportPath = join(outputDir, `${today()}.md`);
    const done = await waitFor(
      () => existsSync(reportPath) && readFileSync(reportPath, "utf8").includes("+1/-0")
    );
    assert.ok(done, existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "report missing");
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_TOOLS_HOME;
    else process.env.AGENT_TOOLS_HOME = previousHome;
  }
});

test("opencode adapter does not reuse the previous turn's text as the next result", async () => {
  const home = makeHome({});
  const output = join(home, "work-log.md");
  writeFileSync(join(home, "config.jsonc"), `${JSON.stringify({ log: { output } }, null, 2)}\n`);

  const previousHome = process.env.AGENT_TOOLS_HOME;
  process.env.AGENT_TOOLS_HOME = home;
  try {
    const { AgentToolsLog } = await import(
      pathToFileURL(join(ROOT, "dist", "log", "opencode-plugin.mjs")).href
    );
    const hooks = await AgentToolsLog({ directory: ROOT });

    await hooks["chat.message"](
      { sessionID: "ses_r" },
      { message: { role: "user", sessionID: "ses_r" }, parts: [{ type: "text", text: SUBSTANTIVE_PROMPT }] }
    );
    await hooks.event({
      event: { type: "message.updated", properties: { info: { role: "assistant", id: "msg_r1" } } },
    });
    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: { part: { type: "text", messageID: "msg_r1", sessionID: "ses_r", text: SUBSTANTIVE_OUTCOME } },
      },
    });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_r" } } });
    const first = await waitFor(
      () => existsSync(output) && readFileSync(output, "utf8").includes("已完成导入模块重构")
    );
    assert.ok(first, "first turn should be recorded");

    // Second turn produces no assistant text before going idle.
    const secondPrompt = "排查 statusline 在 Windows 下的乱码问题并说明结论";
    await hooks["chat.message"](
      { sessionID: "ses_r" },
      { message: { role: "user", sessionID: "ses_r" }, parts: [{ type: "text", text: secondPrompt }] }
    );
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_r" } } });

    const second = await waitFor(
      () => existsSync(output) && readFileSync(output, "utf8").includes("排查 statusline")
    );
    assert.ok(second, readFileSync(output, "utf8"));
    const text = readFileSync(output, "utf8");
    assert.equal(
      text.split("已完成导入模块重构").length,
      2,
      "the first turn's outcome must not be duplicated into the second turn"
    );
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_TOOLS_HOME;
    else process.env.AGENT_TOOLS_HOME = previousHome;
  }
});

test("installer wires and unwires the opencode log plugin stub", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-log-oc-install-"));
  const runtime = join(temp, "runtime");
  const configDir = join(temp, "opencode");
  const stub = join(configDir, "plugins", "agent-tools-log.js");

  const args = ["log", "-a", "opencode", "--opencode-config-dir", configDir];
  const install = spawnSync(process.execPath, [INSTALL_SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, AGENT_TOOLS_HOME: runtime },
    encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  assert.ok(existsSync(stub));
  assert.ok(readFileSync(stub, "utf8").includes("AgentToolsLog"));
  assert.ok(existsSync(join(runtime, "dist", "log", "opencode-plugin.mjs")));
  assert.ok(existsSync(join(runtime, "dist", "log", "hook.mjs")));

  const uninstall = spawnSync(process.execPath, [INSTALL_SCRIPT, ...args, "--uninstall"], {
    cwd: ROOT,
    env: { ...process.env, AGENT_TOOLS_HOME: runtime },
    encoding: "utf8",
  });
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  assert.equal(existsSync(stub), false);
});

test("installer wires and unwires the codex log hooks without matchers", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-log-codex-"));
  const runtime = join(temp, "runtime");
  const hooksFile = join(temp, "hooks.json");
  const userEntry = { hooks: [{ type: "command", command: "node user-hook.mjs" }] };
  writeFileSync(hooksFile, JSON.stringify({ hooks: { Stop: [userEntry] } }));

  const args = ["log", "-a", "codex", "--codex-hooks", hooksFile];
  const install = spawnSync(process.execPath, [INSTALL_SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, AGENT_TOOLS_HOME: runtime },
    encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const cfg = JSON.parse(readFileSync(hooksFile, "utf8"));
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
    const ours = (cfg.hooks[event] || []).filter((entry) =>
      JSON.stringify(entry).includes("dist/log/hook.mjs")
    );
    assert.equal(ours.length, 1, `${event} should carry exactly one log hook`);
    assert.equal(ours[0].matcher, undefined, `${event} carries no matcher on codex`);
  }
  assert.ok(existsSync(join(runtime, "dist", "log", "hook.mjs")));

  const uninstall = spawnSync(process.execPath, [INSTALL_SCRIPT, ...args, "--uninstall"], {
    cwd: ROOT,
    env: { ...process.env, AGENT_TOOLS_HOME: runtime },
    encoding: "utf8",
  });
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);

  const cleaned = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert.equal(cleaned.hooks.Stop.length, 1, "user hook survives uninstall");
  assert.equal(JSON.stringify(cleaned).includes("dist/log/hook.mjs"), false);
});

test("installer wires and unwires the claude log hooks", () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-tools-log-install-"));
  const runtime = join(temp, "runtime");
  const runtimeHook = join(runtime, "dist", "log", "hook.mjs").replace(/\\/g, "/");
  const settings = join(temp, "settings.json");
  const userEntry = { hooks: [{ type: "command", command: "node user-hook.mjs" }] };
  // A user hook whose path merely resembles ours must never be claimed.
  const lookalike = { hooks: [{ type: "command", command: 'node "C:/custom/dist/log/hook.mjs"' }] };
  writeFileSync(settings, JSON.stringify({ hooks: { Stop: [userEntry, lookalike] } }));

  const args = ["log", "-a", "claude", "--settings", settings];
  const install = spawnSync(process.execPath, [INSTALL_SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, AGENT_TOOLS_HOME: runtime },
    encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const cfg = JSON.parse(readFileSync(settings, "utf8"));
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
    const ours = (cfg.hooks[event] || []).filter((entry) =>
      JSON.stringify(entry).includes(runtimeHook)
    );
    assert.equal(ours.length, 1, `${event} should carry exactly one log hook`);
  }
  assert.ok(cfg.hooks.PreToolUse[0].matcher, "PreToolUse is scoped by a matcher");
  assert.ok(existsSync(join(runtime, "dist", "log", "hook.mjs")));

  const uninstall = spawnSync(process.execPath, [INSTALL_SCRIPT, ...args, "--uninstall"], {
    cwd: ROOT,
    env: { ...process.env, AGENT_TOOLS_HOME: runtime },
    encoding: "utf8",
  });
  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);

  const cleaned = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(cleaned.hooks.Stop.length, 2, "both user hooks survive uninstall");
  assert.ok(JSON.stringify(cleaned).includes("C:/custom/dist/log/hook.mjs"));
  assert.equal(JSON.stringify(cleaned).includes(runtimeHook), false);
});
