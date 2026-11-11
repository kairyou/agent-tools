import { createHash } from "node:crypto";
import { queryProviderUsage } from "./core.mjs";
import { isOfficialBaseUrl } from "./lib/urls.mjs";
import { agentConfig } from "./lib/config.mjs";
import { formatOutputSpeed, withOutputSpeed } from "./lib/output-speed.mjs";

// Refresh on session/model changes and completed runs, at most once a minute
// per account. No timer is needed while Pi is idle.
const REFRESH_MS = 60_000;
const STATUS_KEY = "agent-tools-usage";

export function createPiUsageExtension({ query = queryProviderUsage, now = Date.now, config = agentConfig } = {}) {
  return function agentToolsUsage(pi) {
    const accounts = new Map();
    let generation = 0;
    let speed = "";
    let quota = "";
    let responseStart;

    function resetSpeed() {
      speed = "";
      quota = "";
      responseStart = undefined;
    }

    async function refresh(ctx, model = ctx.model) {
      if (ctx.mode !== "tui") return;
      const current = generation;
      const show = (text) => {
        if (current === generation) {
          quota = text || "";
          ctx.ui.setStatus(STATUS_KEY, withOutputSpeed(quota, speed) || undefined);
        }
      };
      try {
        if (!model) return show();
        const baseUrlOverride = process.env.PROVIDER_USAGE_BASE_URL;
        // Do not resolve official OAuth credentials just to probe usage.
        if (isOfficialBaseUrl(baseUrlOverride || model.baseUrl)) return show();
        const keyOverride = process.env.PROVIDER_USAGE_API_KEY || process.env.SUB2API_API_KEY;
        const auth = keyOverride ? null : await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (current !== generation) return;
        const baseUrl = baseUrlOverride || auth?.baseUrl || model.baseUrl;
        const key = keyOverride || (auth?.ok && auth.apiKey);
        if (!baseUrl || !key || isOfficialBaseUrl(baseUrl)) return show();
        const id = createHash("sha256").update(JSON.stringify([model.provider, baseUrl, key])).digest("hex");
        let account = accounts.get(id);
        if (!account) {
          account = { startedAt: -Infinity, text: undefined, pending: null };
          accounts.set(id, account);
        }
        show(account.text);
        if (!account.pending && now() - account.startedAt >= REFRESH_MS) {
          account.startedAt = now();
          account.pending = Promise.resolve().then(() => query({
            providerName: model.provider,
            baseUrl,
            key,
          }, { agent: "pi", rememberSnapshot: true })).then((result) => {
            account.text = result?.text || undefined;
          }).catch(() => {
            // A failed probe must not interrupt Pi or leave stale quota visible.
            account.text = undefined;
          }).finally(() => { account.pending = null; });
        }
        await account.pending;
        show(account.text);
      } catch {
        show();
      }
    }

    pi.on("session_start", (_event, ctx) => {
      generation += 1;
      resetSpeed();
      void refresh(ctx);
    });
    pi.on("model_select", (event, ctx) => {
      generation += 1;
      resetSpeed();
      if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
      void refresh(ctx, event.model);
    });
    pi.on("agent_end", (_event, ctx) => { void refresh(ctx); });
    pi.on("message_start", (event) => {
      if (event.message?.role === "assistant") responseStart = { generation };
    });
    pi.on("message_update", (event) => {
      const delta = event.assistantMessageEvent;
      if (!responseStart || responseStart.generation !== generation || event.message?.role !== "assistant" ||
          !["text_delta", "thinking_delta", "toolcall_delta"].includes(delta?.type) ||
          typeof delta.delta !== "string" || !delta.delta) return;
      // Count actual generation, including thinking and tool arguments, rather
      // than the wait before the first delta or final message bookkeeping.
      const time = now();
      responseStart.time ??= time;
      responseStart.end = time;
    });
    pi.on("message_end", async (event, ctx) => {
      if (event.message?.role !== "assistant") return;
      const started = responseStart;
      responseStart = undefined;
      if (!started || started.generation !== generation || ctx.mode !== "tui") return;
      const enabled = (await config()).outputSpeed === true;
      if (started.generation !== generation) return;
      speed = enabled && !["aborted", "error"].includes(event.message.stopReason)
        ? formatOutputSpeed(event.message.usage?.output, started.end - started.time) : "";
      ctx.ui.setStatus(STATUS_KEY, withOutputSpeed(quota, speed) || undefined);
    });
    pi.on("session_shutdown", (_event, ctx) => {
      generation += 1;
      resetSpeed();
      accounts.clear();
      if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
    });
  };
}

export default createPiUsageExtension();
