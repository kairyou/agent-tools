import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "lib", "vision", "cli.mjs");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

function runCli(args, env) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

test("installed CLI module runs directly for the agent fallback", async (t) => {
  const gateway = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      assert.equal(body.model, "fake-vlm");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "A settings window is visible." } }] }));
    });
  });
  await new Promise((resolveListen) => gateway.listen(0, "127.0.0.1", resolveListen));
  t.after(() => gateway.close());

  const home = mkdtempSync(join(tmpdir(), "at-vision-cli-"));
  const image = join(home, "shot.png");
  writeFileSync(image, PNG);
  writeFileSync(
    join(home, "config.jsonc"),
    JSON.stringify({
      vision: {
        provider: "openai-compatible",
        baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`,
        model: "fake-vlm",
        maxRequestsPerMinute: 0,
      },
    })
  );

  const result = await runCli(
    [image, "--question", "What is the main content?", "--json"],
    { AGENT_TOOLS_HOME: home }
  );
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.answers[0].question_id, "q1");
  assert.equal(payload.answers[0].answer, "A settings window is visible.");
});

test("request-file fallback keeps image paths and questions out of the shell command", async (t) => {
  let receivedPrompt = "";
  const gateway = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      receivedPrompt = body.messages[0].content.find((part) => part.type === "text").text;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Visible content." } }] }));
    });
  });
  await new Promise((resolveListen) => gateway.listen(0, "127.0.0.1", resolveListen));
  t.after(() => gateway.close());

  const home = mkdtempSync(join(tmpdir(), "at-vision-request-file-"));
  const image = join(home, "shot $(Write-Output injected).png");
  const requestFile = join(home, "request.json");
  const question = "What does $(Get-Content secret.txt) show?";
  writeFileSync(image, PNG);
  writeFileSync(
    join(home, "config.jsonc"),
    JSON.stringify({
      vision: {
        provider: "openai-compatible",
        baseUrl: `http://127.0.0.1:${gateway.address().port}/v1`,
        model: "fake-vlm",
        maxRequestsPerMinute: 0,
      },
    })
  );
  writeFileSync(
    requestFile,
    JSON.stringify({
      image_source: { type: "file", value: image },
      questions: [{ id: "q-safe", text: question }],
    })
  );

  const result = await runCli(["--request-file", requestFile, "--json"], {
    AGENT_TOOLS_HOME: home,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(receivedPrompt, /q-safe/);
  assert.match(receivedPrompt, /\$\(Get-Content secret\.txt\)/);
  assert.equal(JSON.parse(result.stdout).answers[0].question_id, "q-safe");
});
