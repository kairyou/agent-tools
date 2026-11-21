import { isAbsolute, join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { usageCliHome } from "./lib/cli-settings.mjs";
import { readTextIfExists } from "./lib/config.mjs";
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

await runUsageStatusline("qwen", async ({ model, workspace }) => {
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
});
