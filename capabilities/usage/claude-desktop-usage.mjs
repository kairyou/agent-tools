import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { queryCachedProviderUsage } from "./core.mjs";
import { agentConfig, debugLog } from "./lib/config.mjs";
import { usageContext } from "./lib/context.mjs";
import { readCcSwitchDesktopProfileToken, readCcSwitchRoutedProvider } from "./lib/cc-switch.mjs";
import { isOfficialBaseUrl } from "./lib/urls.mjs";

const STATIC_KEY_FIELDS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"];

function httpUrl(value) {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
}

function isCcSwitchDesktopRoute(url) {
  return !!url && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    url.pathname.replace(/\/+$/, "") === "/claude-desktop";
}

function desktopSessionId() {
  if (process.ppid <= 0) return "";
  const directory = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    // The worker is launched directly by the Claude Code process.
    const session = JSON.parse(readFileSync(join(directory, "sessions", `${process.ppid}.json`), "utf8"));
    return session?.pid === process.ppid && typeof session.sessionId === "string" ? session.sessionId : "";
  } catch {
    return "";
  }
}

function ccSwitchContext(endpoint, sessionId) {
  // Desktop may pass the proxy address to the worker without its host-managed token.
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || readCcSwitchDesktopProfileToken(endpoint);
  const { provider, status, localToken, confirmed } = readCcSwitchRoutedProvider("claude-desktop", {
    token,
    tokenSetting: "claude_desktop_gateway_token",
    sessionId,
  });
  if (!provider) return { status };
  const { config } = provider;
  const providerEnv = config.env || {};
  const baseUrl = providerEnv.ANTHROPIC_BASE_URL ?? config.base_url ?? config.baseURL ?? config.apiEndpoint;
  const key = [...STATIC_KEY_FIELDS.map((field) => providerEnv[field]), config.apiKey ?? config.api_key]
    .find((value) => typeof value === "string" && value.trim())?.trim();
  const upstream = httpUrl(baseUrl);
  if (!key || key === token || key === localToken) return { status: "cc-switch-upstream-key-unavailable" };
  if (!upstream || isCcSwitchDesktopRoute(upstream)) return { status: "cc-switch-upstream-address-invalid" };
  return { context: { baseUrl: baseUrl.trim(), key, providerName: provider.id, label: provider.name }, confirmed };
}

// Claude launches this with the current Desktop session's environment.
const env = process.env;
const endpoint = httpUrl(env.ANTHROPIC_BASE_URL);
const routed = isCcSwitchDesktopRoute(endpoint);
const reportedSessionId = process.argv[2] === "--session-id" ? process.argv[3]?.trim() : "";

async function gatewayUsage() {
  const { PROVIDER_USAGE_BASE_URL: addressOverride, PROVIDER_USAGE_API_KEY: keyOverride } = env;
  if (!routed || (addressOverride && keyOverride)) {
    return await queryGateway(await usageContext("claude"));
  }
  // Never pair a manually supplied upstream address with the local proxy token.
  if (addressOverride || keyOverride) return { status: "incomplete-usage-override" };
  const { context, status, confirmed } = ccSwitchContext(endpoint, reportedSessionId || desktopSessionId());
  if (!context) return { status };
  const result = await queryGateway(context);
  if (!result.gateway) return result;
  // CC Switch can change routes while the gateway answers.
  const current = ccSwitchContext(endpoint, reportedSessionId || desktopSessionId());
  if (current.context?.providerName !== context.providerName || current.context.baseUrl !== context.baseUrl ||
      current.context.key !== context.key) return { status: "cc-switch-route-changed" };
  return confirmed ? { ...result, status: "quota-available-from-session-route" } : result;
}

async function queryGateway(context) {
  if (!context.baseUrl) return { status: "session-endpoint-missing" };
  if (isOfficialBaseUrl(context.baseUrl)) return { status: "official-endpoint" };
  if (!context.key) return { status: "session-key-missing" };
  const gateway = await queryCachedProviderUsage(context, { agent: "claude" });
  return gateway ? { gateway, status: "quota-available" } : { status: "quota-unavailable" };
}

if (process.argv[2] === "--settings") {
  const config = await agentConfig();
  process.stdout.write(JSON.stringify({ outputSpeed: config.outputSpeed === true, routed }));
} else {
  const { gateway = "", status } = await gatewayUsage().catch(() => ({ status: "usage-check-failed" }));
  await debugLog({ source: "claude-desktop-usage", status, routed }).catch(() => {});
  process.stdout.write(JSON.stringify({ gateway, routed }));
}
