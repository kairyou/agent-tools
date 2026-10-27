import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piLogExtension, { createPiLogExtension } from "../dist/log/pi-extension.mjs";

const PROMPT = "Refactor the import parser and cover the new field mapping with regression tests";
const OUTCOME = "Completed the import parser refactor, added regression coverage and verified all tests pass.";

function harness(factory = createPiLogExtension) {
  const handlers = new Map();
  const records = [];
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "session-1" } };
  factory({ send: async (payload) => { records.push(payload); } })({ on: (event, fn) => handlers.set(event, fn) });
  return { ctx, records, emit: async (name, event = {}) => { await handlers.get(name)(event, ctx); } };
}

const userMessage = (text = PROMPT) => ({ message: { role: "user", content: [{ type: "text", text }] } });
const assistantMessage = (text = OUTCOME, stopReason = "stop") => ({
  message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text }], stopReason },
});

test("Pi log records accepted prompts, successful tools and only the settled outcome", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("message_start", userMessage());
  await h.emit("tool_call", { toolName: "write", input: { path: "file.txt", content: "new" } });
  await h.emit("tool_result", { toolName: "write", input: { path: "file.txt" }, isError: false });
  await h.emit("tool_result", { toolName: "edit", input: { path: "failed.txt" }, isError: true });
  await h.emit("tool_result", { toolName: "read", input: { path: "file.txt" }, isError: false });
  await h.emit("tool_result", { toolName: "powershell", input: { command: "npm test" }, isError: false });
  await h.emit("message_end", assistantMessage());
  assert.equal(h.records.some((r) => r.hook_event_name === "Stop"), false);
  await h.emit("agent_settled", { aborted: false });
  assert.deepEqual(h.records.map((r) => r.hook_event_name), ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUse", "Stop"]);
  assert.equal(h.records[1].tool_name, "Write");
  assert.equal(h.records[3].tool_name, "Bash");
  assert.equal(h.records[4].last_assistant_message, OUTCOME);
  assert.ok(h.records.every((r) => r.session_id === "pi:session-1" && r.cwd === process.cwd()));
  assert.equal(JSON.stringify(h.records).includes("private reasoning"), false);
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.records.length, 5);
});

test("Pi log never carries a previous result into an aborted, failed or textless turn", async () => {
  const h = harness();
  await h.emit("message_start", userMessage());
  await h.emit("message_end", assistantMessage());
  await h.emit("agent_settled", { aborted: false });
  for (const reason of ["aborted", "error", "toolUse"]) {
    await h.emit("message_start", userMessage("Investigate the remaining parser regression"));
    await h.emit("message_end", assistantMessage("Partial output", reason));
    await h.emit("agent_settled", { aborted: reason === "aborted" });
    assert.equal(h.records.at(-1).last_assistant_message, "");
  }
  await h.emit("message_start", userMessage());
  await h.emit("message_end", assistantMessage());
  await h.emit("message_start", assistantMessage("", "toolUse"));
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.records.at(-1).last_assistant_message, "");
});

test("Pi log drains ordered events before continuing and survives recorder failures", async () => {
  let finish;
  const calls = [];
  const h = harness((options) => createPiLogExtension({ send: async (payload) => {
    calls.push(payload.hook_event_name);
    if (calls.length === 1) throw new Error("recorder unavailable");
    await new Promise((resolve) => { finish = resolve; });
    await options.send(payload);
  } }));
  await h.emit("message_start", userMessage());
  let completed = false;
  const baseline = h.emit("tool_call", { toolName: "edit", input: { path: "file.txt" } }).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  const shutdown = h.emit("session_shutdown");
  finish();
  await Promise.all([baseline, shutdown]);
  assert.deepEqual(calls, ["UserPromptSubmit", "PreToolUse"]);
  assert.equal(completed, true);
  await h.emit("message_end", assistantMessage());
  await h.emit("agent_settled", { aborted: false });
  assert.equal(calls.length, 2);
});

test("Pi log isolates replaced sessions and preserves a completed queued exchange", async () => {
  const h = harness();
  await h.emit("message_start", userMessage());
  await h.emit("message_end", assistantMessage());
  await h.emit("message_start", userMessage("Implement the remaining parser validation"));
  assert.equal(h.records[1].last_assistant_message, OUTCOME);
  assert.equal(h.records[2].hook_event_name, "UserPromptSubmit");
  h.ctx.sessionManager.getSessionId = () => "session-2";
  await h.emit("message_end", assistantMessage("Unrelated session result"));
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.records.length, 3);
  await h.emit("session_shutdown");
  await h.emit("session_start");
  await h.emit("message_start", userMessage());
  assert.equal(h.records.at(-1).session_id, "pi:session-2");
});

test("Pi log shared recorder snapshots before mutation and writes detailed reports", async () => {
  const home = mkdtempSync(join(tmpdir(), "at-pi-log-"));
  const output = join(home, "reports");
  const target = join(home, "sample.txt");
  writeFileSync(target, "first\n");
  writeFileSync(join(home, "config.jsonc"), JSON.stringify({ log: { output, format: "detailed", language: "en" } }));
  const previousHome = process.env.AGENT_TOOLS_HOME;
  process.env.AGENT_TOOLS_HOME = home;
  try {
    const h = harness(() => piLogExtension);
    h.ctx.cwd = home;
    await h.emit("session_start");
    await h.emit("message_start", userMessage());
    const tool = { toolName: "edit", input: { path: target, oldText: "first", newText: "first\nsecond" } };
    await h.emit("tool_call", tool);
    writeFileSync(target, "first\nsecond\n");
    await h.emit("tool_result", { ...tool, isError: false });
    await h.emit("message_end", assistantMessage());
    await h.emit("agent_settled", { aborted: false });
    await h.emit("session_shutdown");
    const report = readFileSync(join(output, readdirSync(output)[0]), "utf8");
    assert.ok(report.includes(PROMPT), report);
    assert.ok(report.includes(OUTCOME), report);
    assert.ok(report.includes("sample.txt"), report);
    assert.ok(report.includes("+1/-0"), report);
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_TOOLS_HOME;
    else process.env.AGENT_TOOLS_HOME = previousHome;
  }
});
