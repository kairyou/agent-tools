import { open, stat } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { agentConfig, REFRESH_INTERVAL_MS } from "../usage/lib/config.mjs";
import { usageContext } from "../usage/lib/context.mjs";
import { codexTranscriptUsage, codexTranscriptPath } from "../usage/lib/output-speed.mjs";
import { cachedUsage, queryCachedProviderUsage } from "../usage/lib/query.mjs";
import { isOfficialBaseUrl } from "../usage/lib/urls.mjs";
import { usageAccountCacheKey } from "../usage/lib/cache-policy.mjs";
import { codexSubscriptionQuota, nativeFields } from "./codex-statusline-fields.mjs";

const name = "agent-tools-codex-statusline";
const uri = `ui://${name}/footer`;
const resource = { name: "Usage status line", uri, mimeType: "application/json" };
const tool = {
  name: "statusline", title: "Agent Tools usage", description: "Display session usage in the Codex footer.",
  inputSchema: { type: "object", properties: {} },
  _meta: { "openai/ui": { entrypoints: [{ type: "statusline", resourceUri: uri }] } },
};
const panelResource = { name: "Agent Tools usage", uri: `ui://${name}/usage.html`, mimeType: "text/html;profile=mcp-app" };
const panelTool = {
  name: "usage_panel", title: "Agent Tools usage", description: "Read usage for this Codex conversation.",
  inputSchema: {
    type: "object",
    properties: { refresh: { type: "boolean", description: "Bypass the refresh interval. Omit to read the cache only." } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: {
    ui: { resourceUri: panelResource.uri, visibility: ["app"] },
    "openai/ui": { entrypoints: [{ type: "thread" }] },
  },
};
const panelHtml = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Tools usage</title>
<style>
  :root{color-scheme:light dark;background:transparent;color:var(--color-text-primary,CanvasText);font:14px/1.5 system-ui,sans-serif}
  body{margin:0;padding:12px 16px}p{margin:0}p+p{margin-top:8px}#usage{overflow-wrap:anywhere}
  button{margin-top:12px;padding:4px 8px;font:inherit;color:inherit;cursor:pointer}
</style>
<p id="usage" role="status">Loading usage…</p><p id="speed" hidden></p>
<button id="refresh" type="button" disabled>Refresh</button>
<script type="module">${CODEX_USAGE_PANEL_SCRIPT}</script></html>`;

let lastRefresh;
async function gatewayUsage(providerId) {
  if (!providerId) return "";
  const context = await usageContext("codex", { providerId });
  if (!context.key || isOfficialBaseUrl(context.baseUrl)) return "";
  const snapshot = await cachedUsage(context);
  const account = usageAccountCacheKey(context);
  // Codex gives a resource read one second. Keep gateway requests off that path.
  if ((!snapshot || snapshot.ageMs >= REFRESH_INTERVAL_MS) &&
      (lastRefresh?.account !== account || Date.now() - lastRefresh.at >= REFRESH_INTERVAL_MS)) {
    lastRefresh = { account, at: Date.now() };
    void queryCachedProviderUsage(context, { agent: "codex" }).catch(() => {});
  }
  return snapshot?.text || "";
}

let transcript;
async function sessionUsage(sessionId, file) {
  if (typeof sessionId !== "string" || !/^[a-f0-9-]+$/i.test(sessionId)) return;
  if (transcript?.sessionId !== sessionId) transcript = { sessionId };
  const current = transcript;
  current.file ??= file || codexTranscriptPath(sessionId);
  if (!current.file) return;
  const metadata = await stat(current.file).catch(() => null);
  if (!metadata) {
    current.file = undefined;
    return;
  }
  if (current.mtime !== metadata.mtimeMs || current.size !== metadata.size) {
    current.usage = codexTranscriptUsage(current.file);
    current.mtime = metadata.mtimeMs;
    current.size = metadata.size;
  }
  return current.usage;
}

async function outputSpeed(sessionId) {
  return (await agentConfig()).outputSpeed === true ? (await sessionUsage(sessionId))?.speed : "";
}

async function transcriptProvider(file, threadId) {
  const handle = await open(file, "r");
  try {
    // The first record identifies the thread and provider. Bound the read even for long histories.
    const header = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const end = header.subarray(0, bytesRead).indexOf(10);
    if (end < 0 && bytesRead === header.length) return undefined;
    const row = JSON.parse(header.toString("utf8", 0, end < 0 ? bytesRead : end));
    if (row?.type === "session_meta" && row.payload?.id === threadId && typeof row.payload.model_provider === "string") {
      return row.payload.model_provider;
    }
  } finally {
    await handle.close();
  }
}

async function panelQuota(file, threadId, refresh, rateLimits) {
  const providerId = await transcriptProvider(file, threadId);
  if (!providerId) return "";
  const context = await usageContext("codex", { providerId });
  const official = context.baseUrl ? isOfficialBaseUrl(context.baseUrl) :
    providerId === "openai" || context.provider?.requires_openai_auth === true;
  if (official) return codexSubscriptionQuota(rateLimits);
  if (refresh === undefined) {
    if (!context.key || isOfficialBaseUrl(context.baseUrl)) return "";
    return (await cachedUsage(context))?.text || "";
  }
  return await queryCachedProviderUsage(context, { agent: "codex", force: refresh });
}

const server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [tool, panelTool] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name === tool.name) return { content: [{ type: "text", text: "Choose Agent Tools usage in /statusline." }] };
  if (params.name !== panelTool.name) throw new McpError(ErrorCode.InvalidParams, "Unknown usage tool.");
  const threadId = params._meta?.threadId;
  const file = typeof threadId === "string" && /^[a-f0-9-]+$/i.test(threadId) && codexTranscriptPath(threadId);
  const usage = file ? await sessionUsage(threadId, file).catch(() => undefined) : undefined;
  const quota = file ? await panelQuota(file, threadId, params.arguments?.refresh, usage?.rateLimits).catch(() => "") : "";
  const speed = (await agentConfig()).outputSpeed === true ? usage?.speed || "" : "";
  return { content: [], structuredContent: { quota, speed } };
});
server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [resource, panelResource] }));
server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
  if (params.uri === panelResource.uri) return { contents: [{ ...panelResource, text: panelHtml }] };
  if (params.uri !== uri) throw new McpError(ErrorCode.InvalidParams, "Unknown status line resource.");
  const state = params._meta?.["com.openai/codex-statusline-state"];
  let text = "";
  if (state?.thread) {
    const [fields, quota, speed] = await Promise.all([
      nativeFields(state),
      gatewayUsage(state.thread.model?.provider).catch(() => ""),
      outputSpeed(state.thread.id).catch(() => ""),
    ]);
    text = [...fields, quota, speed].filter(Boolean).join(" | ");
  }
  return { contents: [{ uri, mimeType: resource.mimeType, text: JSON.stringify(text || null) }] };
});
await server.connect(new StdioServerTransport());
