import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function configuredDbPath(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))?.storage?.sessionDbPath : undefined;
}

export function zcodeSessionDbPath({ cwd = process.env.ZCODE_PROJECT_DIR || process.cwd(), home = homedir(), env = process.env } = {}) {
  let configured = configuredDbPath(join(home, ".zcode", "cli", "config.json")) || "~/.zcode/cli/db/db.sqlite";
  // Match ZCode's project discovery: root to cwd within a worktree, or cwd
  // alone when no .git marker exists. Environment overrides are applied last.
  const directories = [];
  let current = resolve(cwd);
  while (true) {
    directories.push(current);
    if (existsSync(join(current, ".git"))) { directories.reverse(); break; }
    const parent = dirname(current);
    if (parent === current) { directories.splice(0, directories.length, resolve(cwd)); break; }
    current = parent;
  }
  for (const directory of directories) {
    for (const file of [join(directory, "zcode.json"), join(directory, ".zcode", "config.json")]) {
      configured = configuredDbPath(file) ?? configured;
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (["ZCODE_SESSION_DB_PATH", "ZCODE_SESSION_DB"].includes(name) && value !== undefined) configured = value;
  }
  return configured.startsWith("~/") ? join(home, configured.slice(2)) : resolve(cwd, configured);
}

function readZcodeSession({ sessionId = process.env.ZCODE_SESSION_ID, cwd, dbPath }, read) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  let db;
  try {
    const file = dbPath || zcodeSessionDbPath({ cwd });
    if (!existsSync(file)) return null;
    // Load only for ZCode. Older Node releases without node:sqlite simply hide
    // this optional measurement; other agents never load the SQLite runtime.
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    db = new DatabaseSync(file, { readOnly: true });
    // A usage hook must not wait behind a database writer.
    db.exec("PRAGMA busy_timeout = 0");
    return read(db, sessionId);
  } catch { return null; }
  finally { db?.close(); }
}

export function readZcodeSessionProvider() {
  return readZcodeSession({}, (db, sessionId) => {
    const row = db.prepare(`
      SELECT data FROM session_entry
      WHERE session_id = ? AND type = 'runtime/model_selection'
      ORDER BY time_created DESC, rowid DESC LIMIT 1
    `).get(sessionId);
    const provider = row && JSON.parse(row.data)?.modelSelection?.providerId;
    return typeof provider === "string" && provider ? provider : null;
  });
}

export function readZcodeModelUsage({ turnId, ...session } = {}) {
  return readZcodeSession(session, (db, sessionId) => {
    const row = db.prepare(`
      SELECT turn_id, status, started_at, first_token_at, completed_at,
             output_tokens, retry_count, tool_call_count, cancelled_by_user
      FROM model_usage
      WHERE session_id = ? AND query_source = 'main_turn'
      ORDER BY started_at DESC, completed_at DESC, id DESC LIMIT 1
    `).get(sessionId);
    return row && (!turnId || row.turn_id === turnId) ? row : null;
  });
}
