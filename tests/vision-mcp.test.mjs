import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { QUESTION_LIMITS } from "../lib/vision/inspect.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_SCRIPT = join(ROOT, "scripts", "install.mjs");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

// Fake OpenAI-compatible gateway that answers every question it is asked.
const gateway = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    const prompt = body.messages[0].content.find((p) => p.type === "text").text;
    const ids = [...prompt.matchAll(/^- (\S+): /gm)].map((m) => m[1]);
    const answers = ids.map((id) => ({ question_id: id, answer: `answer for ${id}`, uncertainty: null }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers }) } }] }));
  });
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}/v1`;
after(() => gateway.close());

function makeHome({ withConfig }) {
  const home = mkdtempSync(join(tmpdir(), "at-vision-mcp-"));
  if (withConfig) {
    writeFileSync(
      join(home, "config.jsonc"),
      JSON.stringify({
        vision: {
          provider: "openai-compatible",
          baseUrl: gatewayUrl,
          model: "fake-vlm",
          apiKey: "sk-test",
        },
      })
    );
  }
  return home;
}

// Minimal MCP stdio client: newline-delimited JSON-RPC, match replies by id.
function startServer(home) {
  const child = spawn(process.execPath, [INSTALL_SCRIPT, "mcp-vision"], {
    cwd: ROOT,
    env: { ...process.env, AGENT_TOOLS_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  function request(id, method, params) {
    const reply = new Promise((resolveReply, reject) => {
      pending.set(id, resolveReply);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return reply;
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  return { child, request, notify };
}

async function withServer(home, fn) {
  const server = startServer(home);
  try {
    const init = await server.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    });
    assert.equal(init.result.serverInfo.name, "agent-tools-vision");
    assert.match(init.result.instructions, /callable MCP tool, not an MCP resource/);
    assert.match(init.result.instructions, /read_mcp_resource/);
    server.notify("notifications/initialized", {});
    await fn(server);
  } finally {
    server.child.kill();
  }
}

test("MCP server exposes inspect_image and answers per question id", async () => {
  const home = makeHome({ withConfig: true });
  const img = join(home, "shot.png");
  writeFileSync(img, PNG);
  await withServer(home, async (server) => {
    const list = await server.request(2, "tools/list", {});
    const tool = list.result.tools.find((t) => t.name === "inspect_image");
    assert.ok(tool, "inspect_image tool registered");
    assert.match(tool.description, /callable MCP tool, not an MCP resource/);
    assert.match(tool.description, /read_mcp_resource/);
    assert.match(tool.description, /untrusted data/);
    assert.ok(tool.inputSchema.properties.image_source);
    assert.ok(tool.inputSchema.properties.questions);
    assert.equal(tool.inputSchema.properties.questions.maxItems, QUESTION_LIMITS.maxCount);
    assert.equal(
      tool.inputSchema.properties.questions.items.properties.id.maxLength,
      QUESTION_LIMITS.maxIdLength
    );
    assert.equal(
      tool.inputSchema.properties.questions.items.properties.text.maxLength,
      QUESTION_LIMITS.maxTextLength
    );

    const call = await server.request(3, "tools/call", {
      name: "inspect_image",
      arguments: {
        image_source: { type: "file", value: img },
        questions: [
          { id: "q1", text: "What error code is shown?" },
          { id: "q2", text: "What color is the light?" },
        ],
      },
    });
    assert.ok(!call.result.isError, JSON.stringify(call.result));
    const payload = JSON.parse(call.result.content[0].text);
    assert.match(payload.request_id, /^vision_req_/);
    assert.deepEqual(
      payload.answers.map((a) => [a.question_id, a.answer]),
      [
        ["q1", "answer for q1"],
        ["q2", "answer for q2"],
      ]
    );
  });
});

test("MCP server returns typed errors for invalid input and bad paths", async () => {
  const home = makeHome({ withConfig: true });
  await withServer(home, async (server) => {
    const missingFile = await server.request(4, "tools/call", {
      name: "inspect_image",
      arguments: {
        image_source: { type: "file", value: join(home, "does-not-exist.png") },
        questions: [{ id: "q1", text: "anything" }],
      },
    });
    assert.equal(missingFile.result.isError, true);
    assert.match(missingFile.result.content[0].text, /^\[input_error\]/);
  });
});

test("MCP server survives missing config and reports config_error per call", async () => {
  const home = makeHome({ withConfig: false });
  await withServer(home, async (server) => {
    const list = await server.request(5, "tools/list", {});
    assert.ok(list.result.tools.some((t) => t.name === "inspect_image"));
    const call = await server.request(6, "tools/call", {
      name: "inspect_image",
      arguments: {
        image_source: { type: "file", value: "x.png" },
        questions: [{ id: "q1", text: "anything" }],
      },
    });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /^\[config_error\]/);
    assert.match(call.result.content[0].text, /config\.jsonc/);
  });
});
