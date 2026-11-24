import { queryProviderUsage } from "./core.mjs";
import { usageAccountCacheKey } from "./lib/cache-policy.mjs";
import { agentConfig } from "./lib/config.mjs";
import { formatOutputSpeed, withOutputSpeed } from "./lib/output-speed.mjs";
import { readUsageSnapshot } from "./lib/cache.mjs";
import { rememberOpenCodeSession } from "./lib/opencode-session.mjs";

const DEFAULT_REFRESH_MS = 60_000;

function firstString(value, keys) {
  for (const key of keys) {
    if (typeof value?.[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return "";
}

function providerContext(input) {
  const info = input?.provider?.info || {};
  const options = input?.provider?.options || {};
  const providerName = String(input?.model?.providerID || info.id || "opencode");
  const label = String(info.name || providerName);
  return {
    providerName,
    provider: { name: label },
    label,
    baseUrl:
      process.env.PROVIDER_USAGE_BASE_URL ||
      firstString(options, ["baseURL", "baseUrl", "base_url"]),
    key:
      process.env.PROVIDER_USAGE_API_KEY ||
      process.env.SUB2API_API_KEY ||
      firstString(options, ["apiKey", "api_key"]),
  };
}

function refreshInterval(options) {
  const configured = Number(options?.refreshMs || process.env.PROVIDER_USAGE_REFRESH_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_REFRESH_MS;
}

export const AgentToolsUsage = async ({ client, directory = process.cwd() }, options = {}) => {
  const contexts = new Map();
  const refreshedAt = new Map();
  const inFlight = new Map();
  const refreshMs = refreshInterval(options);
  const speedEnabled = (await agentConfig()).outputSpeed === true;
  const speeds = new Map();
  const responses = new Map();

  async function showUsage(text) {
    if (!text) return;
    try {
      await client.tui.showToast({
        body: {
          title: "Provider usage",
          message: text,
          variant: "info",
          duration: 8000,
        },
      });
    } catch {
      // Headless OpenCode sessions do not have a TUI to notify.
    }
  }

  async function refreshSession(sessionID) {
    const context = contexts.get(sessionID);
    if (!context && !speeds.has(sessionID)) return;
    const show = async (quota = "") => {
      if (contexts.get(sessionID) !== context) return;
      const outputSpeed = speeds.get(sessionID) || "";
      const text = withOutputSpeed(quota, outputSpeed);
      await rememberOpenCodeSession(directory, sessionID, {
        accountKey: quota ? usageAccountCacheKey(context) : "", outputSpeed,
      }, () => contexts.get(sessionID) === context);
      if (contexts.get(sessionID) !== context) return;
      await showUsage(text);
    };
    if (!context?.baseUrl || !context?.key) return await show();

    const cacheKey = usageAccountCacheKey(context);
    const now = Date.now();
    if (!inFlight.has(cacheKey) && now - (refreshedAt.get(cacheKey) || 0) >= refreshMs) {
      refreshedAt.set(cacheKey, now);
      const task = queryProviderUsage(context, {
        agent: "opencode",
        rememberSnapshot: true,
        force: false,
      })
        .catch(() => null)
        .finally(() => inFlight.delete(cacheKey));
      inFlight.set(cacheKey, task);
    }
    const pending = inFlight.get(cacheKey);
    const result = await pending;
    await show(result?.text || (await readUsageSnapshot(context))?.text);
  }

  return {
    "chat.params": async (input) => {
      const context = { ...providerContext(input), modelID: input.model?.modelID };
      const previous = contexts.get(input.sessionID);
      if (previous && (previous.modelID !== context.modelID || previous.baseUrl !== context.baseUrl || previous.key !== context.key)) {
        speeds.delete(input.sessionID);
        responses.delete(input.sessionID);
      }
      contexts.set(input.sessionID, context);
      if (!previous || previous.modelID !== context.modelID || previous.baseUrl !== context.baseUrl || previous.key !== context.key) {
        await rememberOpenCodeSession(directory, input.sessionID, {});
      }
    },
    event: async ({ event }) => {
      if (event.type === "message.updated" && speedEnabled) {
        const info = event.properties.info;
        if (info?.role !== "assistant" || !info.id) return;
        let response = responses.get(info.sessionID);
        if (response?.id !== info.id) {
          response = { id: info.id };
          responses.set(info.sessionID, response);
        }
        if (info.time?.completed !== undefined) {
          // Reasoning has its own token counter, but shares the output stream.
          const output = info.tokens?.output;
          const reasoning = info.tokens?.reasoning ?? 0;
          const tokens = Number.isFinite(output) && output >= 0 && Number.isFinite(reasoning) && reasoning >= 0
            ? output + reasoning : NaN;
          speeds.set(info.sessionID, info.error || response.hasTools ? "" :
            formatOutputSpeed(tokens, response.end - response.start));
        }
      } else if (speedEnabled && event.type === "message.part.updated") {
        const part = event.properties.part;
        const response = responses.get(part?.sessionID);
        if (response && response.id === part?.messageID && part?.type === "tool") response.hasTools = true;
      } else if (speedEnabled && event.type === "message.part.delta") {
        const delta = event.properties;
        const response = responses.get(delta.sessionID);
        if (response && response.id === delta.messageID && delta.field === "text" && typeof delta.delta === "string" && delta.delta) {
          const time = Date.now();
          response.start ??= time;
          response.end = time;
        }
      } else if (event.type === "session.idle") {
        void refreshSession(event.properties.sessionID);
      } else if (event.type === "session.deleted") {
        contexts.delete(event.properties.sessionID);
        speeds.delete(event.properties.sessionID);
        responses.delete(event.properties.sessionID);
        await rememberOpenCodeSession(directory, event.properties.sessionID, null);
      }
    },
  };
};
