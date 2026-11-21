import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { usageCliHome } from "./lib/cli-settings.mjs";
import { readTextIfExists } from "./lib/config.mjs";
import { qwenOutputSpeed } from "./lib/output-speed.mjs";
import { runUsageStatusline } from "./lib/statusline-command.mjs";

async function settingsAt(file) {
  const raw = await readTextIfExists(file);
  if (!raw.trim()) return {};
  const errors = [];
  const settings = parseJsonc(raw.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error("Invalid Qwen settings");
  return settings || {};
}

function settingValue(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] || "");
}

async function resolveContext({ model, workspace }) {
  const label = model?.display_name;
  const cwd = workspace?.current_dir;
  if (typeof label !== "string" || !label || typeof cwd !== "string" || !isAbsolute(cwd)) return;
  const [settings, project] = await Promise.all([
    settingsAt(join(usageCliHome("qwen"), "settings.json")),
    settingsAt(join(cwd, ".qwen", "settings.json")),
  ]);
  // The command payload does not identify which settings scope was accepted.
  if (Object.hasOwn(project, "modelProviders")) return;
  const matches = [];
  for (const [name, models] of Object.entries(settings.modelProviders || {})) {
    if (!Array.isArray(models)) continue;
    for (const entry of models) {
      if (entry && settingValue(entry.name || entry.id) === label) matches.push({ name, entry });
    }
  }
  if (matches.length !== 1) return;
  const { name, entry } = matches[0];
  return { providerName: name, baseUrl: settingValue(entry.baseUrl), key: process.env[settingValue(entry.envKey)] };
}

async function readSpeed({ session_id: sessionId, workspace, worktree }) {
  const cwd = workspace?.current_dir;
  if (typeof sessionId !== "string" || !/^[a-f0-9-]+$/i.test(sessionId) ||
      typeof cwd !== "string" || !isAbsolute(cwd)) return "";
  const home = usageCliHome("qwen");
  const settings = await settingsAt(join(home, "settings.json"));
  const project = await settingsAt(join(cwd, ".qwen", "settings.json"));
  const runtimeDir = process.env.QWEN_RUNTIME_DIR ||
    settingValue(project.advanced?.runtimeOutputDir ?? settings.advanced?.runtimeOutputDir);
  const runtime = runtimeDir.startsWith("~/") || runtimeDir.startsWith("~\\")
    ? resolve(homedir(), runtimeDir.slice(2))
    : runtimeDir ? resolve(cwd, runtimeDir) : home;
  // Qwen derives its per-project transcript directory from the workspace path.
  const projectCwd = worktree?.original_cwd || cwd;
  const projectPath = (process.platform === "win32" ? projectCwd.toLowerCase() : projectCwd).replace(/[^a-zA-Z0-9]/g, "-");
  return qwenOutputSpeed(join(runtime, "projects", projectPath, "chats", `${sessionId}.jsonl`), sessionId);
}

await runUsageStatusline("qwen", resolveContext, readSpeed);
