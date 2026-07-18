#!/usr/bin/env node
// Capture the tools array from one Codex Responses API request, then exit.
// The request intentionally receives HTTP 503; no data is forwarded upstream.
//
// Terminal 1:
//   node ./scripts/capture-codex-tools.mjs 8787
//
// Find the active custom provider name:
//   grep '^model_provider' "$HOME/.codex/config.toml"
//   Select-String "$HOME/.codex/config.toml" -Pattern '^model_provider'  # PowerShell
//
// Terminal 2 (replace <model_provider_name>, then reproduce the issue):
//   codex -c 'model_providers.<model_provider_name>.base_url="http://127.0.0.1:8787"'

import http from "node:http";

const port = Number(process.argv[2] || 8787);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const names = tools.map((tool) => tool.name || tool.function?.name || tool.type || "<unnamed>");
      const hasInspectImage = JSON.stringify(tools).includes("inspect_image");
      const mcpTools = tools.filter((tool) => {
        const name = tool.name || tool.function?.name || "";
        return name.startsWith("mcp__") || JSON.stringify(tool).includes("inspect_image");
      });
      console.log(`request: ${req.method} ${req.url}`);
      console.log(`inspect_image reference: ${hasInspectImage ? "present" : "absent"}`);
      console.log(`tools (${tools.length}): ${names.join(", ") || "<none>"}`);
      console.log(`MCP tool definitions:\n${JSON.stringify(mcpTools, null, 2)}`);
    } catch (err) {
      console.error(`Could not parse request JSON: ${err.message}`);
    }

    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Diagnostic capture complete" } }));
    server.close();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Waiting for one Codex API request on http://127.0.0.1:${port} ...`);
});
