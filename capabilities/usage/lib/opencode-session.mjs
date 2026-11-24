import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CACHE_DIR } from "./config.mjs";
import { readUsageSnapshotByKey, updateJsonCache } from "./cache.mjs";
import { withOutputSpeed } from "./output-speed.mjs";

const SESSION_PATH = join(CACHE_DIR, "opencode-sessions.json");
// The TUI can only use the account association recently confirmed by the session plugin.
const SESSION_REFERENCE_MAX_AGE_MS = 10 * 60_000;

function displayKey(cwd, sessionID) {
  return createHash("sha256").update(JSON.stringify([resolve(cwd), sessionID])).digest("hex");
}

// The server owns resolved credentials and stream timing; the TUI only needs
// an account reference and session speed. Quota stays in usage-snapshot.json.
export async function rememberOpenCodeSession(cwd, sessionID, state, isCurrent = () => true) {
  if (!sessionID) return;
  await updateJsonCache(SESSION_PATH, "items", "opencode-session", (items) => {
    if (!isCurrent()) return;
    const key = displayKey(cwd, sessionID);
    if (state === null) delete items[key];
    else items[key] = {
      accountKey: state.accountKey || "",
      outputSpeed: state.outputSpeed || "",
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function readOpenCodeUsage(cwd, sessionID) {
  if (!sessionID) return "";
  try {
    const item = JSON.parse(readFileSync(SESSION_PATH, "utf8"))?.items?.[displayKey(cwd, sessionID)];
    const age = Date.now() - Date.parse(item?.updatedAt || "");
    if (!(age < SESSION_REFERENCE_MAX_AGE_MS)) return "";
    const snapshot = await readUsageSnapshotByKey(item.accountKey);
    return withOutputSpeed(snapshot?.text, item.outputSpeed);
  } catch { return ""; }
}
