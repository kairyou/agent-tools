import { spawn } from "node:child_process";
import { canRefreshUsage } from "./cache.mjs";
import { HOOK_SNAPSHOT_MAX_AGE_MS, REFRESH_INTERVAL_MS } from "./config.mjs";
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

export async function runUsageStatusline(agent, resolveContext) {
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    if (!raw.trim()) return;
    const data = JSON.parse(raw);
    if (process.argv[2] === "--refresh") {
      await queryCachedProviderUsage(data, { agent });
      return;
    }

    const context = await resolveContext(data);
    if (!context?.key || !/^https?:\/\//i.test(context.baseUrl) || isOfficialBaseUrl(context.baseUrl)) return;
    const snapshot = await cachedUsage(context);
    if ((!snapshot || snapshot.ageMs >= REFRESH_INTERVAL_MS) && await canRefreshUsage(context, REFRESH_INTERVAL_MS)) {
      refreshInBackground(context);
    }
    if (snapshot?.ageMs < HOOK_SNAPSHOT_MAX_AGE_MS) process.stdout.write(snapshot.text);
  } catch {
    // An unavailable provider should leave the footer blank.
  }
}
