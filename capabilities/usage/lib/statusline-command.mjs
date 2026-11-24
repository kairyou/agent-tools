import { spawn } from "node:child_process";
import { canRefreshUsage } from "./cache.mjs";
import { agentConfig, REFRESH_INTERVAL_MS } from "./config.mjs";
import { withOutputSpeed } from "./output-speed.mjs";
import { cachedUsage, queryCachedProviderUsage } from "./query.mjs";
import { isOfficialBaseUrl } from "./urls.mjs";

// A new process renders each update. Run network requests separately so neither
// the UI nor its command timeout waits for a slow gateway.
function refreshInBackground(context) {
  const child = spawn(process.execPath, [process.argv[1], "--refresh"], {
    detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
  });
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(context));
  child.unref();
}

async function gatewayUsage(data, resolveContext) {
  const context = await resolveContext(data);
  if (!context?.key || !/^https?:\/\//i.test(context.baseUrl) || isOfficialBaseUrl(context.baseUrl)) return "";
  const snapshot = await cachedUsage(context);
  if ((!snapshot || snapshot.ageMs >= REFRESH_INTERVAL_MS) && await canRefreshUsage(context, REFRESH_INTERVAL_MS)) {
    refreshInBackground(context);
  }
  return snapshot?.text || "";
}

export async function runUsageStatusline(agent, resolveContext, readSpeed) {
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    if (!raw.trim()) return;
    const data = JSON.parse(raw);
    if (process.argv[2] === "--refresh") {
      await queryCachedProviderUsage(data, { agent });
      return;
    }

    const [quota, speed] = await Promise.all([
      gatewayUsage(data, resolveContext).catch(() => ""),
      agentConfig().then((config) => config.outputSpeed === true ? readSpeed(data) : "").catch(() => ""),
    ]);
    process.stdout.write(withOutputSpeed(quota, speed));
  } catch {
    // An unavailable provider should leave the footer blank.
  }
}
