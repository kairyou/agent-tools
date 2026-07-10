import { queryProviderUsage } from "../../lib/usage.mjs";

const DEFAULT_REFRESH_MS = 60_000;

function toastMessage(text) {
  return text.replace(/^API \| /, "");
}

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

export const AgentToolsUsage = async ({ client }, options = {}) => {
  const contexts = new Map();
  const refreshedAt = new Map();
  const inFlight = new Map();
  const refreshMs = refreshInterval(options);

  async function showUsage(text) {
    if (!text) return;
    try {
      await client.tui.showToast({
        body: {
          title: "Provider usage",
          message: toastMessage(text),
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
    if (!context?.baseUrl || !context?.key) return;

    const cacheKey = context.baseUrl.replace(/\/+$/, "");
    const now = Date.now();
    if (now - (refreshedAt.get(cacheKey) || 0) < refreshMs) return;
    if (inFlight.has(cacheKey)) return await inFlight.get(cacheKey);

    refreshedAt.set(cacheKey, now);
    const task = queryProviderUsage(context, {
      agent: "opencode",
      rememberSnapshot: true,
    })
      .then((result) => showUsage(result?.text || ""))
      .catch(() => {})
      .finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, task);
    return await task;
  }

  return {
    "chat.params": async (input) => {
      contexts.set(input.sessionID, providerContext(input));
    },
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        void refreshSession(event.properties.sessionID);
      } else if (event.type === "session.deleted") {
        contexts.delete(event.properties.sessionID);
      }
    },
  };
};
