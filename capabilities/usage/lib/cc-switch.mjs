import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { HOOK_SNAPSHOT_MAX_AGE_MS } from "./config.mjs";

const MANAGED_AUTH = new Set(["github_copilot", "codex_oauth", "xai_oauth"]);
const DESKTOP_PROFILE_ID = "00000000-0000-4000-8000-000000157210";

function desktopProfileLibrary(home) {
  const { LOCALAPPDATA, XDG_CONFIG_HOME } = process.env;
  const root = process.platform === "win32" ? LOCALAPPDATA || join(home, "AppData", "Local") :
    process.platform === "darwin" ? join(home, "Library", "Application Support") :
      XDG_CONFIG_HOME && isAbsolute(XDG_CONFIG_HOME) ? XDG_CONFIG_HOME : join(home, ".config");
  let directory = join(root, "Claude-3p");
  if (process.platform === "win32" && !existsSync(directory)) {
    // CC Switch also recognizes Windows installations with a suffixed directory.
    const [candidate] = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("Claude") && entry.name.includes("-3p"))
      .map((entry) => entry.name).sort();
    if (candidate) directory = join(root, candidate);
  }
  return join(directory, "configLibrary");
}

export function readCcSwitchDesktopProfileToken(endpoint) {
  try {
    const library = desktopProfileLibrary(homedir());
    const meta = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8"));
    if (meta.appliedId !== DESKTOP_PROFILE_ID) return "";
    const profile = JSON.parse(readFileSync(join(library, `${DESKTOP_PROFILE_ID}.json`), "utf8"));
    if (profile.inferenceProvider !== "gateway" || typeof profile.inferenceGatewayBaseUrl !== "string") return "";
    const address = new URL(profile.inferenceGatewayBaseUrl);
    if (address.href.replace(/\/+$/, "") !== endpoint.href.replace(/\/+$/, "")) return "";
    return typeof profile.inferenceGatewayApiKey === "string" ? profile.inferenceGatewayApiKey.trim() : "";
  } catch {
    return "";
  }
}

function databaseDirectory(home, fallback) {
  // CC Switch stores this machine's database override in its Tauri app data.
  const appData = process.platform === "win32" ? process.env.APPDATA || join(home, "AppData", "Roaming") :
    process.platform === "darwin" ? join(home, "Library", "Application Support") :
      process.env.XDG_DATA_HOME || join(home, ".local", "share");
  let storedPath;
  try {
    const settings = JSON.parse(readFileSync(join(appData, "com.ccswitch.desktop", "app_paths.json"), "utf8"));
    storedPath = settings?.app_config_dir_override;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const override = typeof storedPath === "string" ? storedPath.trim() : "";
  if (!override) return fallback;
  const directory = override === "~" ? home :
    /^~[/\\]/.test(override) ? join(home, override.slice(2)) : override;
  if (!isAbsolute(directory)) return null;
  // CC Switch ignores a saved override whose path no longer exists.
  return statSync(directory, { throwIfNoEntry: false }) ? directory : fallback;
}

function latestSuccessfulRequests(db, app, sessionId) {
  if (!sessionId) return [];
  // Several requests can finish in the same second. Treat different providers
  // at that timestamp as ambiguous instead of trusting SQLite insertion order.
  return db.prepare(`
    WITH successful AS (
      SELECT provider_id, created_at FROM proxy_request_logs
      WHERE session_id = ? AND app_type = ? AND data_source = 'proxy'
        AND status_code BETWEEN 200 AND 299 AND COALESCE(error_message, '') = ''
    )
    SELECT DISTINCT provider_id, created_at FROM successful
    WHERE created_at = (SELECT MAX(created_at) FROM successful)
    LIMIT 2
  `).all(sessionId, app);
}

export function readCcSwitchRoutedProvider(app, { token, tokenSetting, sessionId }) {
  // Match CC Switch's device-local route pointer, which is independent of the
  // direct provider selected in settings.json and providers.is_current.
  let db;
  let stage = "cc-switch-state-unreadable";
  try {
    const home = homedir();
    const directory = join(home, ".cc-switch");
    const state = JSON.parse(readFileSync(join(directory, "live-state.json"), "utf8"));
    const route = state.apps?.[app];
    if (state.version !== 1 || route?.mode !== "proxy" || route.attached !== true ||
        typeof route.proxy_route !== "string" || !route.proxy_route) return { status: "cc-switch-no-active-route" };
    if (route.pending) return { status: "cc-switch-route-changing" };
    if (route.stack?.enabled) return { status: "cc-switch-stack-enabled" };

    stage = "cc-switch-database-unreadable";
    const dbDir = databaseDirectory(home, directory);
    if (!dbDir) return { status: "cc-switch-database-path-invalid" };
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    db = new DatabaseSync(join(dbDir, "cc-switch.db"), { readOnly: true });
    // A repaint can retry after CC Switch finishes writing.
    db.exec("PRAGMA busy_timeout = 0");
    const settings = db.prepare("SELECT auto_failover_enabled FROM proxy_config WHERE app_type = ?").get(app);
    if (settings?.auto_failover_enabled) return { status: "cc-switch-auto-failover-enabled" };

    stage = "cc-switch-session-log-unreadable";
    const requests = latestSuccessfulRequests(db, app, sessionId);
    const [latest] = requests;
    if (requests.length > 1) return { status: "cc-switch-session-provider-ambiguous" };
    if (latest && latest.provider_id !== route.proxy_route) return { status: "cc-switch-session-route-mismatch" };
    // Recent successful requests identify the provider even when Desktop
    // keeps the local proxy credential out of the usage worker's environment.
    const age = latest ? Date.now() - latest.created_at * 1_000 : Infinity;
    const confirmed = age >= 0 && age < HOOK_SNAPSHOT_MAX_AGE_MS;
    stage = "cc-switch-database-unreadable";
    const storedToken = db.prepare("SELECT value FROM settings WHERE key = ?").get(tokenSetting)?.value;
    const localToken = typeof storedToken === "string" ? storedToken.trim() : "";
    if (!confirmed) {
      if (!token) return { status: sessionId ? "cc-switch-session-request-missing" : "cc-switch-session-token-missing" };
      if (!localToken) return { status: "cc-switch-database-token-missing" };
      if (token !== localToken) return { status: "cc-switch-session-token-mismatch" };
    }
    const provider = db.prepare(`
      SELECT id, name, settings_config, meta FROM providers WHERE app_type = ? AND id = ?
    `).get(app, route.proxy_route);
    if (!provider) return { status: "cc-switch-provider-missing" };
    stage = "cc-switch-provider-config-invalid";
    if (MANAGED_AUTH.has(JSON.parse(provider.meta || "{}")?.providerType)) return { status: "cc-switch-managed-auth" };

    const config = JSON.parse(provider.settings_config);
    if (!config || typeof config !== "object") return { status: stage };
    return { provider: { id: provider.id, name: provider.name, config }, localToken, confirmed };
  } catch {
    return { status: stage };
  } finally {
    db?.close();
  }
}
