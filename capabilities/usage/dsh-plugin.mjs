import { queryCachedProviderUsage } from "./core.mjs";
import { usageAccountCacheKey } from "./lib/cache-policy.mjs";
import { isOfficialBaseUrl } from "./lib/urls.mjs";

export const name = "agent-tools-usage";
export const inject = ["llm"];

function environmentValue(ctx, name) {
  const environment = ctx.get("launchEnvironment");
  return environment ? environment.get(name)?.value : process.env[name];
}

export async function dshUsageContext(ctx, selection, routing) {
  if (!selection?.provider || !selection.model) return null;
  const entry = ctx.llm.listConfigurableProviders().find((item) => item.provider === selection.provider);
  let profile = entry && ctx.get("settings")?.describe().find((item) => item.ns === entry.settingsNs)?.value;
  for (const key of entry?.settingsPath || []) profile = profile?.[key];
  const baseUrl = environmentValue(ctx, "PROVIDER_USAGE_BASE_URL") ||
    profile?.baseURL ||
    (routing?.provider === selection.provider && routing.model === selection.model ? routing.baseURL : "") ||
    entry?.defaultBaseURL || "";
  let key = environmentValue(ctx, "PROVIDER_USAGE_API_KEY") || environmentValue(ctx, "SUB2API_API_KEY") || "";
  if (!key && profile?.apiKeyEnv) {
    const credentials = ctx.get("credentials");
    key = credentials ? (await credentials.resolve(profile.apiKeyEnv))?.value || "" : environmentValue(ctx, profile.apiKeyEnv) || "";
  }
  if (!key && !profile?.apiKeyEnv) {
    // The default pi-ai mount owns this record format. Do not read another
    // adapter family's credentials merely because its route has the same name.
    const record = entry?.settingsNs === "llm-pi-ai"
      ? await ctx.get("credentials")?.readRecord(`llm-pi-ai/${selection.provider}`) : undefined;
    if (record?.kind === "grant") return { providerName: selection.provider, baseUrl, key: "" };
    if (record?.kind === "api-key") key = record.key || "";
    for (const ref of entry?.nativeAuth?.env || []) {
      if (key) break;
      key = (await ctx.get("credentials")?.resolve(ref))?.value || environmentValue(ctx, ref) || "";
    }
  }
  return { providerName: selection.provider, label: entry?.displayName || selection.provider, baseUrl, key };
}

function sameModel(a, b) {
  return a?.provider === b?.provider && a?.model === b?.model;
}

function accountFor(context) {
  return context && !isOfficialBaseUrl(context.baseUrl) ? usageAccountCacheKey(context) : "";
}

async function selectedModel(ctx, sessionId, signal) {
  const agent = ctx.agents.get(sessionId);
  if (agent) return agent.model.current();
  // Opening a saved session should not start its agent or change its model.
  const snapshot = await ctx.sessionController.projections({ sessionId }, signal);
  if (snapshot?.kind !== "sequenced") return null;
  const model = snapshot.values.modelSelection;
  return model?.next ?? model?.lastUsed ?? ctx.get("agentDefaultModel")?.currentSelection();
}

export function createDshUsagePlugin({ query = queryCachedProviderUsage } = {}) {
  return async function apply(ctx) {
    const routes = new Map();
    ctx.on("llm-pi-ai/request-headers", (request, _headers, next) => {
      if (request.sessionId) routes.set(request.sessionId, {
        provider: request.provider, model: request.model, baseURL: request.baseURL,
      });
      return next();
    });
    ctx.on("session/event", (session, event) => {
      if (event.type === "model/selection") routes.delete(session.id);
    });
    ctx.on("session/disposed", (session) => { routes.delete(session.id); });

    // Connection's exact routes admit only the authenticated owner. The client
    // supplies a session ID; all model and credential resolution stays here.
    ctx.inject(["connection", "agents", "sessionController"], (web) => {
      web.connection.fetch.register({
        path: "/api/agent-tools.usage", methods: ["GET"], requestBody: "buffered",
        async fetch(request) {
          const sessionId = new URL(request.url).searchParams.get("sessionId");
          const respond = (text) => Response.json({ text }, { headers: { "cache-control": "no-store" } });
          if (!sessionId || sessionId.length > 256 || request.signal.aborted) return respond("");
          const selection = () => selectedModel(web, sessionId, request.signal);
          const resolve = (model) => dshUsageContext(ctx, model, routes.get(sessionId));
          try {
            const model = await selection();
            const context = await resolve(model);
            const account = accountFor(context);
            if (!account || request.signal.aborted) return respond("");
            const text = await query(context, { agent: "dsh" });
            const current = await selection();
            if (!sameModel(model, current) || account !== accountFor(await resolve(current)) || request.signal.aborted) return respond("");
            return respond(text);
          } catch { return respond(""); }
        },
      });
    });
    ctx.inject(["commands"], (ui) => {
      ui.commands.register({
        name: "at-usage",
        description: "Show the current gateway's balance and usage",
        recordInput: false,
        async handler({ agent, rawInput, signal }) {
          if (rawInput.trim()) return { kind: "error", text: "Usage: /at-usage" };
          const selection = agent?.model.current();
          const unavailable = { kind: "error", text: "Provider usage is unavailable." };
          if (!selection || signal.aborted) return unavailable;
          try {
            const resolve = (model) => dshUsageContext(ctx, model, routes.get(agent.id));
            const context = await resolve(selection);
            if (!sameModel(selection, agent.model.current()) || signal.aborted) return unavailable;
            const account = accountFor(context);
            if (!account) return unavailable;
            const text = await query(context, { agent: "dsh", force: true, allowStale: false });
            const current = agent.model.current();
            if (!text || !sameModel(selection, current) || account !== accountFor(await resolve(current)) ||
                signal.aborted || !sameModel(selection, agent.model.current())) return unavailable;
            return { kind: "success", text };
          } catch { return unavailable; }
        },
      });
    });
    ctx.effect(() => () => routes.clear());
  };
}

export const apply = createDshUsagePlugin();
