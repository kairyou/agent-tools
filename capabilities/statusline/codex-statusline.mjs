import { stat } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { agentConfig, HOOK_SNAPSHOT_MAX_AGE_MS, REFRESH_INTERVAL_MS } from "../usage/lib/config.mjs";
import { usageContext } from "../usage/lib/context.mjs";
import { codexOutputSpeed, codexTranscriptPath } from "../usage/lib/output-speed.mjs";
import { cachedUsage, queryCachedProviderUsage } from "../usage/lib/query.mjs";
import { isOfficialBaseUrl } from "../usage/lib/urls.mjs";
import { usageAccountCacheKey } from "../usage/lib/cache-policy.mjs";
import { nativeFields } from "./codex-statusline-fields.mjs";

const name = "agent-tools-codex-statusline";
const uri = `ui://${name}/footer`;
const resource = { name: "Usage status line", uri, mimeType: "application/json" };
const tool = {
  name: "statusline", title: "Agent Tools usage", description: "Display session usage in the Codex footer.",
  inputSchema: { type: "object", properties: {} },
  _meta: { "openai/ui": { entrypoints: [{ type: "statusline", resourceUri: uri }] } },
};

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
  return snapshot?.ageMs < HOOK_SNAPSHOT_MAX_AGE_MS ? snapshot.text : "";
}

let transcript;
async function outputSpeed(sessionId) {
  if (typeof sessionId !== "string" || !/^[a-f0-9-]+$/i.test(sessionId) || (await agentConfig()).outputSpeed !== true) return "";
  if (transcript?.sessionId !== sessionId) transcript = { sessionId };
  const current = transcript;
  current.file ??= codexTranscriptPath(sessionId);
  if (!current.file) return "";
  const metadata = await stat(current.file).catch(() => null);
  if (!metadata) {
    current.file = undefined;
    return "";
  }
  if (current.mtime !== metadata.mtimeMs || current.size !== metadata.size) {
    current.speed = codexOutputSpeed(current.file);
    current.mtime = metadata.mtimeMs;
    current.size = metadata.size;
  }
  return current.speed;
}

const server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [tool] }));
server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: "text", text: "Choose Agent Tools usage in /statusline." }] }));
server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [resource] }));
server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
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
