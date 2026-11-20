import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { agentConfig, readTextIfExists } from "./lib/config.mjs";
import { usageContext } from "./lib/context.mjs";
import { agentOutputSpeed } from "./lib/output-speed.mjs";
import { queryCachedProviderUsage } from "./lib/query.mjs";
import { isOfficialBaseUrl } from "./lib/urls.mjs";
import { agentUsage } from "./paseo-rpc.mjs";

const empty = { available: false, gateway: "", speed: "" };

async function sessionGateway(harness, profile, settings) {
  // Paseo injects named Codex gateways directly into the app-server thread config.
  const baseUrl = profile?.extends === "codex" ? profile.env?.OPENAI_BASE_URL?.trim().replace(/\/+$/, "") : "";
  if (baseUrl) {
    return {
      label: profile.label,
      baseUrl: baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`,
      key: profile.env.OPENAI_API_KEY ? settings.OPENAI_API_KEY : "",
    };
  }
  if (harness === "claude") {
    // Paseo enables Claude's user settings source. Its env block overlays the launch env.
    const file = join(settings.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
    const personal = parseJsonc(await readTextIfExists(file));
    return usageContext(harness, { env: { ...settings, ...personal?.env } });
  }
  return usageContext(harness, { env: settings });
}

async function launchContext({ provider, cwd, env }, paseo) {
  const { config } = await paseo.config.get();
  const profile = Object.hasOwn(config.providers, provider) ? config.providers[provider] : null;
  const harness = profile?.extends || provider;
  if (harness !== "claude" && harness !== "codex") return null;

  const settings = { ...process.env, ...profile?.env, ...env };
  const context = await sessionGateway(harness, profile, settings).catch(() => null);
  let gateway = null;
  if (context?.key && !isOfficialBaseUrl(context.baseUrl)) {
    gateway = profile?.extends ? { ...context, providerName: provider, label: profile.label || provider } : context;
  }
  const agentHome = harness === "codex" ? settings.CODEX_HOME : settings.CLAUDE_CONFIG_DIR;
  return { provider, harness, cwd, agentHome, gateway };
}

export default function contribute(server) {
  const launches = new Map();
  const removeOpen = server.before("agent.session_open", async ({ request }, { paseo, signal }) => {
    if (request.purpose !== "interactive") return;
    launches.delete(request.agentId);
    const launch = await launchContext(request, paseo).catch(() => null);
    if (launch && !signal.aborted) launches.set(request.agentId, launch);
  });
  const removeArchive = server.on("agent.archived", ({ agent }) => { launches.delete(agent.id); });
  server.handle(agentUsage, async ({ agentId, check }, { paseo }) => {
    const launch = launches.get(agentId);
    if (!launch) return empty;
    const showSpeed = (await agentConfig()).outputSpeed === true;
    if (!launch.gateway && !showSpeed) return empty;
    const available = { ...empty, available: true };
    if (check) return available;

    const agent = paseo.agents.ref(agentId);
    await agent.refresh();
    const snapshot = agent.current();
    if (!snapshot || snapshot.archivedAt || snapshot.provider !== launch.provider) return empty;
    const sessionId = snapshot.runtimeInfo?.sessionId;
    const speed = showSpeed && sessionId && /^[a-z0-9-]+$/i.test(sessionId) ? agentOutputSpeed(launch.harness, {
      cwd: launch.cwd, agentHome: launch.agentHome, sessionId,
    }) : "";
    const gateway = launch.gateway ? await queryCachedProviderUsage(launch.gateway, { agent: launch.harness }) : "";
    if (launches.get(agentId) !== launch) return empty;
    return { available: true, gateway, speed };
  });
  return () => { removeOpen(); removeArchive(); launches.clear(); };
}
