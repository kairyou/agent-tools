import { queryProviderUsage } from "./core.mjs";
import { createHash } from "node:crypto";
import { agentConfig } from "./lib/config.mjs";
import { formatOutputSpeed, withOutputSpeed } from "./lib/output-speed.mjs";
import { rememberOpenCodeDisplay } from "./lib/opencode-display.mjs";

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
  const quotas = new Map();

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
    const show = async (quota = "") => {
      if (contexts.get(sessionID) !== context) return;
      const text = withOutputSpeed(quota, speeds.get(sessionID));
      rememberOpenCodeDisplay(directory, text);
      await showUsage(text);
    };
    if (!context?.baseUrl || !context?.key) return await show();

    const cacheKey = createHash("sha256").update(JSON.stringify([context.baseUrl.replace(/\/+$/, ""), context.key])).digest("hex");
    const now = Date.now();
    if (!inFlight.has(cacheKey) && now - (refreshedAt.get(cacheKey) || 0) >= refreshMs) {
      refreshedAt.set(cacheKey, now);
      const task = queryProviderUsage(context, {
        agent: "opencode",
        rememberSnapshot: true,
      })
        .then((result) => quotas.set(cacheKey, result?.text || ""))
        .catch(() => quotas.delete(cacheKey))
        .finally(() => inFlight.delete(cacheKey));
      inFlight.set(cacheKey, task);
    }
    await inFlight.get(cacheKey);
    await show(quotas.get(cacheKey));
  }

  return {
    "chat.params": async (input) => {
      const context = { ...providerContext(input), modelID: input.model?.modelID };
      const previous = contexts.get(input.sessionID);
      if (previous && (previous.modelID !== context.modelID || previous.baseUrl !== context.baseUrl || previous.key !== context.key)) {
        speeds.delete(input.sessionID);
      }
      contexts.set(input.sessionID, context);
    },
    event: async ({ event }) => {
      if (event.type === "message.updated" && speedEnabled) {
        const info = event.properties.info;
        if (info?.role === "assistant" && info.time?.completed !== undefined) {
          speeds.set(info.sessionID, info.error ? "" : formatOutputSpeed(info.tokens?.output, info.time.completed - info.time.created));
        }
      } else if (event.type === "session.idle") {
        void refreshSession(event.properties.sessionID);
      } else if (event.type === "session.deleted") {
        contexts.delete(event.properties.sessionID);
        speeds.delete(event.properties.sessionID);
      }
    },
  };
};
