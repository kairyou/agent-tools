#!/usr/bin/env node
// agent-tools installer: wires statusline / usage into each agent's config.
// Runtime-dependent skills are installed with their capability. Standalone
// workflow/integration skills are still handled by `npx skills add`.
//
// Capabilities (all global for now — they target the user-level config):
//   statusline  Claude Code statusLine script (claude only).
//   usage       Active API provider quota/balance (all agents).
//   vision      inspect_image MCP server + at-vision skill (all agents).
//
// Standalone commands (dispatched before capability parsing):
//   inspect-image <path|url> --question "..."   Human diagnostic for vision.
//   mcp-vision                                  Run the vision MCP stdio server.
//
// Targets:
//   claude   -> ~/.claude/settings.json (statusLine key)
//               + ~/.claude/skills/at-usage
//               ~/.claude.json (vision MCP) + ~/.claude/skills (at-vision)
//   codex    -> ~/.codex/hooks.json (standalone hooks file)
//               + ~/.agents/skills/at-usage
//               ~/.codex/config.toml (vision MCP) + ~/.agents/skills (at-vision)
//   opencode -> ~/.config/opencode/ (server + TUI plugins,
//               vision MCP in opencode.json + skills/at-vision)
// Runtime scripts are copied into ~/.agent-tools so this installer can be
// run via npx from GitHub without requiring a persistent local clone.
//
// NOTE: Codex will not run a freshly-installed hook until you trust it — run
// `/hooks` inside Codex and approve the agent-tools usage hooks.
//
// Usage:
//   agent-tools <capabilities> [options]
//
// Options:
//   -a, --agent <names>       Target agents: claude | codex | opencode.
//                             Default: claude.
//   --settings <path>         Override the Claude settings.json (for testing).
//   --codex-hooks <path>      Override the Codex hooks.json (for testing).
//   --opencode-config-dir <p> Override the opencode config dir (for testing).
//   --claude-json <path>      Override ~/.claude.json for vision MCP (for testing).
//   --claude-skills-dir <p>   Override ~/.claude/skills (for testing).
//   --codex-config <path>     Override ~/.codex/config.toml (for testing).
//   --codex-skills-dir <p>    Override ~/.agents/skills (for testing).
//   --uninstall               Remove what this installer added, restoring backups.
//   --dry-run                 Print planned changes without writing anything.
//   -h, --help                Show this help.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_ROOT =
  process.env.AGENT_TOOLS_HOME || path.join(os.homedir(), ".agent-tools");
const META_KEY = "_agentTools";
const META_VERSION = 1;
// Everything copied into ~/.agent-tools is built output from dist/ (see
// scripts/build.mjs); integrations/ holds the sources.
const SOURCE = {
  codexUsageHook: path.join(REPO_ROOT, "dist", "usage", "codex-hook.mjs"),
  usageScript: path.join(REPO_ROOT, "dist", "usage", "core.mjs"),
  usageCli: path.join(REPO_ROOT, "dist", "usage", "cli.mjs"),
  config: path.join(REPO_ROOT, "config.default.jsonc"),
  claudeStatusline: path.join(REPO_ROOT, "dist", "statusline", "claude-statusline.mjs"),
  opencodeUsagePlugin: path.join(REPO_ROOT, "dist", "usage", "opencode-plugin.mjs"),
  opencodeUsageTui: path.join(REPO_ROOT, "dist", "usage", "opencode-tui.mjs"),
};
const RUNTIME = {
  codexUsageHook: path.join(INSTALL_ROOT, "dist", "usage", "codex-hook.mjs"),
  usageScript: path.join(INSTALL_ROOT, "dist", "usage", "core.mjs"),
  usageCli: path.join(INSTALL_ROOT, "dist", "usage", "cli.mjs"),
  config: path.join(INSTALL_ROOT, "config.jsonc"),
  claudeStatusline: path.join(INSTALL_ROOT, "dist", "statusline", "claude-statusline.mjs"),
  opencodeUsagePlugin: path.join(INSTALL_ROOT, "dist", "usage", "opencode-plugin.mjs"),
  opencodeUsageTui: path.join(INSTALL_ROOT, "dist", "usage", "opencode-tui.mjs"),
};
const ALL_CAPS = ["statusline", "usage", "vision"];
const ALL_AGENTS = ["claude", "codex", "opencode"];
const AGENT_CAPS = {
  claude: ["statusline", "usage", "vision"],
  codex: ["usage", "vision"],
  opencode: ["usage", "vision"],
};
const VISION_MCP_NAME = "agent-tools-vision";
const VISION_SKILL_NAME = "at-vision";
// The at-vision skill ships inside the vision capability dir (integrations/vision),
// not skills/: it is unusable without the MCP server, so it must not surface
// as an independently installable skill.
const VISION_SKILL_SRC = path.join(REPO_ROOT, "integrations", "vision", "skills", VISION_SKILL_NAME);
const USAGE_SKILL_NAME = "at-usage";
const USAGE_SKILL_SRC = path.join(REPO_ROOT, "integrations", "usage", "skills", USAGE_SKILL_NAME);
const VISION_BUNDLED_MCP_SERVER = path.join(REPO_ROOT, "dist", "vision", "mcp-server.mjs");
const VISION_BUNDLED_CLI = path.join(REPO_ROOT, "dist", "vision", "cli.mjs");

function fwd(p) {
  return p.replace(/\\/g, "/");
}

function nodeCmd(absScript) {
  return `node "${fwd(absScript)}"`;
}

function readJsonc(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (!raw.trim()) return {};
  const errors = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`Cannot parse ${file} as JSONC`);
  return parsed ?? {};
}

function writeText(file, text, dryRun) {
  if (dryRun) {
    console.log(`  [dry-run] would write ${file}:`);
    console.log(text.split("\n").map((l) => "    " + l).join("\n"));
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`  wrote ${file}`);
}

function isOpenCodeUsageTuiEntry(entry) {
  const spec = Array.isArray(entry) ? entry[0] : entry;
  return (
    typeof spec === "string" &&
    /\/dist\/usage\/opencode-tui\.mjs$/i.test(spec.replace(/\\/g, "/"))
  );
}

function updateOpenCodeTuiConfig(file, { remove, dryRun }) {
  const exists = fs.existsSync(file);
  const currentText = exists ? fs.readFileSync(file, "utf8") : "{}\n";
  const errors = [];
  const current = parseJsonc(currentText, errors, { allowTrailingComma: true }) || {};
  if (errors.length > 0 || typeof current !== "object" || Array.isArray(current)) {
    throw new Error(`Cannot parse ${file} as JSONC`);
  }

  const plugins = Array.isArray(current.plugin) ? current.plugin : [];
  const next = plugins.filter((entry) => !isOpenCodeUsageTuiEntry(entry));
  if (!remove) next.push(pathToFileURL(RUNTIME.opencodeUsageTui).href);
  if (JSON.stringify(plugins) === JSON.stringify(next)) {
    console.log(`  kept existing ${file}`);
    return;
  }

  const eol = currentText.includes("\r\n") ? "\r\n" : "\n";
  const edits = modify(currentText, ["plugin"], next.length > 0 ? next : undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  });
  const updated = applyEdits(currentText, edits).replace(/\s*$/, "") + eol;
  writeText(file, updated, dryRun);
}

// Keys present in defaults but absent in current, as jsonc-parser edit paths.
function missingDefaultPaths(current, defaults, basePath = []) {
  const out = [];
  for (const [key, value] of Object.entries(defaults)) {
    const existing = current?.[key];
    if (existing === undefined) {
      out.push({ path: [...basePath, key], value });
    } else if (
      value && typeof value === "object" && !Array.isArray(value) &&
      existing && typeof existing === "object" && !Array.isArray(existing)
    ) {
      out.push(...missingDefaultPaths(existing, value, [...basePath, key]));
    }
  }
  return out;
}

// Updates only add missing default keys via surgical jsonc-parser edits, so
// the user's comments, formatting, and key order survive installer updates.
function mergeJsoncFile(src, dest, dryRun) {
  if (!fs.existsSync(dest) || !fs.readFileSync(dest, "utf8").trim()) {
    writeText(dest, fs.readFileSync(src, "utf8"), dryRun);
    return;
  }
  const defaults = readJsonc(src);
  const currentText = fs.readFileSync(dest, "utf8");
  const additions = missingDefaultPaths(readJsonc(dest), defaults);
  if (additions.length === 0) {
    console.log(`  kept existing ${dest}`);
    return;
  }
  const eol = currentText.includes("\r\n") ? "\r\n" : "\n";
  let updated = currentText;
  for (const { path: keyPath, value } of additions) {
    const edits = modify(updated, keyPath, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol },
    });
    updated = applyEdits(updated, edits);
  }
  writeText(dest, updated, dryRun);
}

function copyRuntimeFile(src, dest, dryRun, options = {}) {
  if (options.mergeJsonc) {
    mergeJsoncFile(src, dest, dryRun);
    return;
  }
  if (dryRun) {
    console.log(`  [dry-run] would copy ${src} -> ${dest}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function installRuntimeAssets(opts) {
  if (opts.uninstall) return;
  const files = [];
  function addFile(src, dest, options) {
    if (!files.some(([, existingDest]) => existingDest === dest)) files.push([src, dest, options]);
  }
  if (wants(opts, "statusline")) {
    addFile(SOURCE.claudeStatusline, RUNTIME.claudeStatusline);
    addFile(SOURCE.usageScript, RUNTIME.usageScript);
    addFile(SOURCE.config, RUNTIME.config, { mergeJsonc: true });
  }
  if (wants(opts, "usage")) {
    if (opts.agents.includes("codex")) {
      addFile(SOURCE.codexUsageHook, RUNTIME.codexUsageHook);
    }
    if (opts.agents.includes("opencode")) {
      addFile(SOURCE.opencodeUsagePlugin, RUNTIME.opencodeUsagePlugin);
      addFile(SOURCE.opencodeUsageTui, RUNTIME.opencodeUsageTui);
    }
    addFile(SOURCE.usageScript, RUNTIME.usageScript);
    addFile(SOURCE.usageCli, RUNTIME.usageCli);
    addFile(SOURCE.config, RUNTIME.config, { mergeJsonc: true });
  }
  if (files.length === 0) return;
  for (const [src] of files) {
    if (!fs.existsSync(src)) {
      throw new Error(`Missing built artifact ${src}. Run npm run build.`);
    }
  }
  console.log(`runtime: ${INSTALL_ROOT}`);
  for (const [src, dest, options] of files) copyRuntimeFile(src, dest, opts.dryRun, options);
  // The statusline refreshes via the usage engine, so it needs packaged
  // routes too.
  if (wants(opts, "usage") || wants(opts, "statusline")) syncUsageRoutesDir(opts.dryRun);
}

// Repo-shipped usage routes are replaced wholesale so routes removed from the
// repo do not linger (a stale file would still be loaded).
const SOURCE_USAGE_ROUTES_DIR = path.join(REPO_ROOT, "dist", "usage", "routes");
const RUNTIME_USAGE_ROUTES_DIR = path.join(INSTALL_ROOT, "dist", "usage", "routes");

function syncUsageRoutesDir(dryRun) {
  const hasSource = fs.existsSync(SOURCE_USAGE_ROUTES_DIR);
  if (dryRun) {
    if (hasSource) {
      console.log(`  [dry-run] would copy ${SOURCE_USAGE_ROUTES_DIR} -> ${RUNTIME_USAGE_ROUTES_DIR}`);
    } else if (fs.existsSync(RUNTIME_USAGE_ROUTES_DIR)) {
      console.log(`  [dry-run] would remove ${RUNTIME_USAGE_ROUTES_DIR}`);
    }
    return;
  }
  fs.rmSync(RUNTIME_USAGE_ROUTES_DIR, { recursive: true, force: true });
  if (hasSource) fs.cpSync(SOURCE_USAGE_ROUTES_DIR, RUNTIME_USAGE_ROUTES_DIR, { recursive: true });
}

function parseArgs(argv) {
  const opts = {
    agents: [],
    integrations: [],
    settings: null,
    codexHooks: null,
    opencodeConfigDir: null,
    claudeJson: null,
    claudeSkillsDir: null,
    codexConfig: null,
    codexSkillsDir: null,
    uninstall: false,
    dryRun: false,
    help: false,
  };
  function readAgentValues(index, option) {
    const values = [];
    let i = index + 1;
    while (i < argv.length && ALL_AGENTS.includes(argv[i])) {
      values.push(argv[i]);
      i++;
    }
    if (values.length === 0) {
      console.error(`Missing value for ${option}`);
      process.exit(2);
    }
    return { values, next: i - 1 };
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-a":
      case "--agent": {
        const parsed = readAgentValues(i, a);
        opts.agents.push(...parsed.values);
        i = parsed.next;
        break;
      }
      case "--settings": opts.settings = argv[++i]; break;
      case "--codex-hooks": opts.codexHooks = argv[++i]; break;
      case "--opencode-config-dir": opts.opencodeConfigDir = argv[++i]; break;
      case "--claude-json": opts.claudeJson = argv[++i]; break;
      case "--claude-skills-dir": opts.claudeSkillsDir = argv[++i]; break;
      case "--codex-config": opts.codexConfig = argv[++i]; break;
      case "--codex-skills-dir": opts.codexSkillsDir = argv[++i]; break;
      case "--uninstall": opts.uninstall = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        if (a.startsWith("-")) {
          console.error(`Unknown option: ${a}`);
          process.exit(2);
        }
        opts.integrations.push(a);
    }
  }
  if (opts.agents.length === 0) opts.agents = ["claude"];
  if (!opts.help && opts.integrations.length === 0) {
    console.error(`Missing capability (available: ${ALL_CAPS.join(", ")})`);
    process.exit(2);
  }
  for (const name of opts.integrations) {
    if (!ALL_CAPS.includes(name)) {
      console.error(`Unknown capability: ${name} (available: ${ALL_CAPS.join(", ")})`);
      process.exit(2);
    }
  }
  return opts;
}

function wants(opts, cap) {
  return opts.integrations.length === 0 || opts.integrations.includes(cap);
}

function validateAgentCapabilities(opts) {
  const invalid = [];
  for (const agent of opts.agents) {
    const supported = AGENT_CAPS[agent] || [];
    for (const cap of opts.integrations) {
      if (!supported.includes(cap)) invalid.push(`${cap} -a ${agent}`);
    }
  }
  if (invalid.length === 0) return;

  console.error(`Unsupported capability/agent combination: ${invalid.join(", ")}`);
  console.error("Supported combinations:");
  for (const agent of ALL_AGENTS) {
    console.error(`  ${agent}: ${AGENT_CAPS[agent].join(", ")}`);
  }
  process.exit(2);
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  // Strip a UTF-8 BOM (common on Windows-authored files) before parsing.
  let raw = fs.readFileSync(file, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip UTF-8 BOM
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot parse ${file} as JSON: ${err.message}`);
  }
}

function writeJson(file, data, dryRun) {
  const text = JSON.stringify(data, null, 2) + "\n";
  if (dryRun) {
    console.log(`  [dry-run] would write ${file}:`);
    console.log(text.split("\n").map((l) => "    " + l).join("\n"));
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`  wrote ${file}`);
}

function removeFile(file, dryRun) {
  if (dryRun) {
    console.log(`  [dry-run] would remove ${file}`);
    return;
  }
  fs.rmSync(file, { force: true });
  console.log(`  removed ${file}`);
}

function usageEntry() {
  return {
    hooks: [
      {
        type: "command",
        command: nodeCmd(RUNTIME.codexUsageHook),
        timeout: 5,
        statusMessage: "Refreshing API usage",
      },
    ],
  };
}

function isOurProviderUsageEntry(entry) {
  return (
    entry &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some(
      (h) =>
        typeof h?.command === "string" &&
        /(?:^|[/\\])codex-hook\.mjs(?:["\s]|$)/.test(h.command)
    )
  );
}

function applyProviderUsage(cfg, { remove }) {
  cfg.hooks = cfg.hooks || {};
  const events = ["UserPromptSubmit", "Stop"];
  for (const event of events) {
    if (remove) {
      if (cfg.hooks[event]) {
        cfg.hooks[event] = cfg.hooks[event].filter((entry) => !isOurProviderUsageEntry(entry));
        if (cfg.hooks[event].length === 0) delete cfg.hooks[event];
      }
      continue;
    }
    cfg.hooks[event] = cfg.hooks[event] || [];
    cfg.hooks[event] = cfg.hooks[event].filter((entry) => !isOurProviderUsageEntry(entry));
    cfg.hooks[event].push(usageEntry());
  }
  if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
}

// ---- Vision capability helpers. ----

// The installed tree mirrors the package tree, so the bundled runtime lands in
// dist/vision just like in the package.
const VISION_RUNTIME_DIR = path.join(INSTALL_ROOT, "dist", "vision");
const VISION_RATE_LIMIT_STATE = path.join(INSTALL_ROOT, "cache", "vision-rate-limit.json");
const VISION_DIST_DIR = path.join(REPO_ROOT, "dist", "vision");
const VISION_RUNTIME_SERVER = path.join(VISION_RUNTIME_DIR, "mcp-server.mjs");
const VISION_RUNTIME_CLI = path.join(VISION_RUNTIME_DIR, "cli.mjs");
const SKILL_MARKER = ".agent-tools-managed.json";
const VISION_SKILL_MARKER_DATA = Object.freeze({
  owner: "@kairyou/agent-tools",
  capability: "vision",
  artifact: "skill",
});
const USAGE_SKILL_MARKER_DATA = Object.freeze({
  owner: "@kairyou/agent-tools",
  capability: "usage",
  artifact: "skill",
});
// Vision is bundled at release time. Install atomically swaps two self-contained
// entry files into ~/.agent-tools/dist/vision, so hosts never run npm and a
// failed update cannot destroy the previously working runtime.
function visionMcpCommand() {
  return { command: "node", args: [fwd(VISION_RUNTIME_SERVER)] };
}

function sameFilePath(left, right) {
  function canonical(value) {
    const resolved = path.resolve(String(value));
    try {
      return fs.realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  }
  const a = canonical(left);
  const b = canonical(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isVisionServerPath(value) {
  return sameFilePath(value, VISION_RUNTIME_SERVER);
}

function isClaudeVisionMcp(value, mcp = visionMcpCommand()) {
  return Boolean(
    value &&
      value.command === mcp.command &&
      Array.isArray(value.args) &&
      value.args.length === 1 &&
      isVisionServerPath(value.args[0])
  );
}

function isOpenCodeVisionMcp(value, mcp = visionMcpCommand()) {
  return Boolean(
    value &&
      value.type === "local" &&
      Array.isArray(value.command) &&
      value.command.length === 2 &&
      value.command[0] === mcp.command &&
      isVisionServerPath(value.command[1])
  );
}

function installVisionRuntime(opts) {
  if (opts.uninstall) return;
  console.log(`vision runtime: ${VISION_RUNTIME_DIR}`);
  if (opts.dryRun) {
    console.log(`  [dry-run] would atomically install ${VISION_DIST_DIR} -> ${VISION_RUNTIME_DIR}`);
    return;
  }
  for (const name of ["mcp-server.mjs", "cli.mjs"]) {
    if (!fs.existsSync(path.join(VISION_DIST_DIR, name))) {
      throw new Error(`Missing bundled vision runtime ${path.join(VISION_DIST_DIR, name)}. Run npm run build.`);
    }
  }

  fs.mkdirSync(path.dirname(VISION_RUNTIME_DIR), { recursive: true });
  const suffix = `${process.pid}-${Date.now()}`;
  const stage = `${VISION_RUNTIME_DIR}.stage-${suffix}`;
  const backup = `${VISION_RUNTIME_DIR}.backup-${suffix}`;
  let movedCurrent = false;
  try {
    fs.cpSync(VISION_DIST_DIR, stage, { recursive: true });
    writeText(
      path.join(stage, "runtime.json"),
      JSON.stringify({ owner: "@kairyou/agent-tools", capability: "vision", version: 1 }, null, 2) + "\n",
      false
    );
    for (const name of ["mcp-server.mjs", "cli.mjs"]) {
      const check = spawnSync(process.execPath, ["--check", path.join(stage, name)], {
        encoding: "utf8",
      });
      if (check.status !== 0) {
        throw new Error(`Bundled vision runtime failed syntax validation (${name}): ${check.stderr || check.stdout}`);
      }
    }

    if (fs.existsSync(VISION_RUNTIME_DIR)) {
      fs.renameSync(VISION_RUNTIME_DIR, backup);
      movedCurrent = true;
    }
    if (process.env.AGENT_TOOLS_VISION_TEST_FAIL_SWAP === "1") {
      throw new Error("Simulated vision runtime swap failure");
    }
    fs.renameSync(stage, VISION_RUNTIME_DIR);
    fs.rmSync(backup, { recursive: true, force: true });
    console.log("  installed bundled vision runtime");
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    if (movedCurrent && !fs.existsSync(VISION_RUNTIME_DIR) && fs.existsSync(backup)) {
      fs.renameSync(backup, VISION_RUNTIME_DIR);
    }
    throw error;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    if (fs.existsSync(VISION_RUNTIME_DIR)) fs.rmSync(backup, { recursive: true, force: true });
  }
}

function isManagedSkillDir(dest, markerData) {
  const marker = path.join(dest, SKILL_MARKER);
  if (!fs.existsSync(marker)) return false;
  try {
    const value = JSON.parse(fs.readFileSync(marker, "utf8"));
    return Object.entries(markerData).every(([key, expected]) => value?.[key] === expected);
  } catch {
    return false;
  }
}

function installManagedSkillDir(
  skillsRoot,
  { name, source, markerData, replacements, remove, dryRun }
) {
  const dest = path.join(skillsRoot, name);
  const isManaged = () => isManagedSkillDir(dest, markerData);
  if (remove) {
    if (!fs.existsSync(dest)) return;
    if (!isManaged()) {
      console.log(`  kept unmanaged ${dest}`);
      return;
    }
    if (dryRun) {
      console.log(`  [dry-run] would remove ${dest}`);
      return;
    }
    fs.rmSync(dest, { recursive: true, force: true });
    console.log(`  removed ${dest}`);
    return;
  }
  if (fs.existsSync(dest) && !isManaged()) {
    console.error(
      `  Refusing to overwrite existing unowned skill directory ${dest}. ` +
        `Move or remove it, then re-run the install.`
    );
    process.exit(1);
  }
  if (dryRun) {
    console.log(`  [dry-run] would copy ${source} -> ${dest}`);
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(source, dest, { recursive: true });
  const skillFile = path.join(dest, "SKILL.md");
  let skill = fs.readFileSync(skillFile, "utf8");
  for (const [token, value] of Object.entries(replacements)) {
    if (!skill.includes(token)) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw new Error(`${name} skill template is missing ${token}`);
    }
    skill = skill.replaceAll(token, value);
  }
  fs.writeFileSync(skillFile, skill);
  fs.writeFileSync(
    path.join(dest, SKILL_MARKER),
    JSON.stringify(markerData, null, 2) + "\n"
  );
  console.log(`  wrote ${dest}`);
}

function installVisionSkillDir(skillsRoot, { remove, dryRun }) {
  installManagedSkillDir(skillsRoot, {
    name: VISION_SKILL_NAME,
    source: VISION_SKILL_SRC,
    markerData: VISION_SKILL_MARKER_DATA,
    replacements: { "{{VISION_CLI_PATH}}": fwd(VISION_RUNTIME_CLI) },
    remove,
    dryRun,
  });
}

function installUsageSkillDir(skillsRoot, agent, { remove, dryRun }) {
  installManagedSkillDir(skillsRoot, {
    name: USAGE_SKILL_NAME,
    source: USAGE_SKILL_SRC,
    markerData: USAGE_SKILL_MARKER_DATA,
    replacements: {
      "{{USAGE_CLI_PATH}}": fwd(RUNTIME.usageCli),
      "{{USAGE_AGENT}}": agent,
    },
    remove,
    dryRun,
  });
}

const CODEX_VISION_BEGIN = "# >>> agent-tools vision >>>";
const CODEX_VISION_END = "# <<< agent-tools vision <<<";

// Codex config.toml is user-owned free-form TOML; we manage exactly one
// marker-delimited block so install/update/uninstall never touch other keys.
function updateCodexVisionBlock(file, { remove, dryRun, mcp }) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(
    `\\r?\\n?${escape(CODEX_VISION_BEGIN)}[\\s\\S]*?${escape(CODEX_VISION_END)}\\r?\\n?`
  );
  let next = current.replace(blockRe, "\n").replace(/^\n+/, "");
  if (!remove) {
    // A same-named table outside our marker block would make the appended
    // TOML a duplicate declaration and break the ENTIRE config.toml parse.
    const manualRe = new RegExp(`^\\s*\\[mcp_servers\\.["']?${escape(VISION_MCP_NAME)}["']?\\]`, "m");
    if (manualRe.test(next)) {
      console.error(
        `  Found an existing [mcp_servers.${VISION_MCP_NAME}] entry in ${file} that was not ` +
          "written by this installer. Remove or rename that entry, then re-run the install."
      );
      process.exit(1);
    }
    const args = mcp.args.map((a) => JSON.stringify(a)).join(", ");
    const block = [
      CODEX_VISION_BEGIN,
      `[mcp_servers.${VISION_MCP_NAME}]`,
      `command = ${JSON.stringify(mcp.command)}`,
      `args = [${args}]`,
      CODEX_VISION_END,
      "",
    ].join("\n");
    next = next.trim() === "" ? block : next.replace(/\s*$/, "\n\n") + block;
  }
  if (next === current) {
    console.log(`  kept existing ${file}`);
    return;
  }
  if (remove && next.trim() === "" && fs.existsSync(file) && current.trim() !== "") {
    // The file only ever contained our block; leave an empty file rather than
    // deleting config.toml, which Codex may expect to exist.
    writeText(file, "", dryRun);
    return;
  }
  writeText(file, next, dryRun);
}

// ---- Claude: statusLine backed up in _agentTools. ----

function runClaudeVision(opts) {
  const claudeJson = opts.claudeJson || path.join(os.homedir(), ".claude.json");
  const skillsDir = opts.claudeSkillsDir || path.join(os.homedir(), ".claude", "skills");
  console.log(`claude vision: ${claudeJson}`);
  const cfg = readJson(claudeJson);
  const mcp = visionMcpCommand();
  const existing = cfg.mcpServers?.[VISION_MCP_NAME];
  if (opts.uninstall) {
    if (isClaudeVisionMcp(existing, mcp)) {
      delete cfg.mcpServers[VISION_MCP_NAME];
      if (Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers;
      writeJson(claudeJson, cfg, opts.dryRun);
    } else if (existing) {
      console.log(`  kept unmanaged ${VISION_MCP_NAME} entry in ${claudeJson}`);
    } else {
      console.log(`  no ${VISION_MCP_NAME} MCP entry found; nothing to remove.`);
    }
    installVisionSkillDir(skillsDir, { remove: true, dryRun: opts.dryRun });
    console.log("  - vision");
    return;
  }
  if (existing && !isClaudeVisionMcp(existing, mcp)) {
    throw new Error(
      `Found an existing unmanaged ${VISION_MCP_NAME} entry in ${claudeJson}. ` +
        "Remove or rename it, then re-run the install."
    );
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers[VISION_MCP_NAME] = { type: "stdio", command: mcp.command, args: mcp.args };
  writeJson(claudeJson, cfg, opts.dryRun);
  installVisionSkillDir(skillsDir, { remove: false, dryRun: opts.dryRun });
  console.log("  + vision (inspect_image MCP + at-vision skill)");
}

function runClaude(opts) {
  if (wants(opts, "vision")) runClaudeVision(opts);
  if (wants(opts, "usage")) {
    const skillsDir = opts.claudeSkillsDir || path.join(os.homedir(), ".claude", "skills");
    console.log(`claude usage: ${skillsDir}`);
    installUsageSkillDir(skillsDir, "claude", {
      remove: opts.uninstall,
      dryRun: opts.dryRun,
    });
    console.log(opts.uninstall ? "  - usage skill" : "  + usage skill (at-usage)");
  }
  if (!wants(opts, "statusline")) return;
  const settings = opts.settings || path.join(os.homedir(), ".claude", "settings.json");
  console.log(`claude (global): ${settings}`);
  const cfg = readJson(settings);
  cfg[META_KEY] = cfg[META_KEY] || { version: META_VERSION, managed: {} };
  cfg[META_KEY].managed = cfg[META_KEY].managed || {};
  const managed = cfg[META_KEY].managed;

  if (wants(opts, "statusline")) {
    if (opts.uninstall) {
      if (managed.statusLine) {
        if (managed.statusLine.backup) {
          cfg.statusLine = managed.statusLine.backup;
          console.log("  - statusline (restored previous)");
        } else {
          delete cfg.statusLine;
          console.log("  - statusline");
        }
        delete managed.statusLine;
      }
    } else {
      const command = nodeCmd(RUNTIME.claudeStatusline);
      const alreadyOurs = Boolean(managed.statusLine);
      managed.statusLine = {
        backup: alreadyOurs ? managed.statusLine.backup ?? null : cfg.statusLine ?? null,
      };
      cfg.statusLine = { type: "command", command, padding: 0, refreshInterval: 60 };
      console.log("  + statusline");
    }
  }

  if (Object.keys(managed).length === 0) delete cfg[META_KEY];
  writeJson(settings, cfg, opts.dryRun);
}

// ---- Codex: hooks in a standalone hooks.json. No meta key is
// written (Codex validates hooks.json against a schema); our hook is found by
// command signature instead. ----

function runCodexVision(opts) {
  const file = opts.codexConfig || path.join(os.homedir(), ".codex", "config.toml");
  const skillsDir = opts.codexSkillsDir || path.join(os.homedir(), ".agents", "skills");
  console.log(`codex vision: ${file}`);
  updateCodexVisionBlock(file, {
    remove: opts.uninstall,
    dryRun: opts.dryRun,
    mcp: visionMcpCommand(),
  });
  installVisionSkillDir(skillsDir, { remove: opts.uninstall, dryRun: opts.dryRun });
  console.log(opts.uninstall ? "  - vision" : "  + vision (inspect_image MCP + at-vision skill)");
}

function runCodex(opts) {
  if (wants(opts, "vision")) runCodexVision(opts);
  if (!wants(opts, "usage")) {
    return;
  }
  const skillsDir = opts.codexSkillsDir || path.join(os.homedir(), ".agents", "skills");
  console.log(`codex usage skill: ${skillsDir}`);
  installUsageSkillDir(skillsDir, "codex", {
    remove: opts.uninstall,
    dryRun: opts.dryRun,
  });
  const file = opts.codexHooks || path.join(os.homedir(), ".codex", "hooks.json");
  console.log(`codex (global): ${file}`);
  const cfg = readJson(file);

  if (wants(opts, "usage")) {
    if (opts.uninstall) {
      applyProviderUsage(cfg, { remove: true });
      console.log("  - usage");
    } else {
      applyProviderUsage(cfg, { remove: false });
      console.log("  + usage (UserPromptSubmit + Stop)");
    }
  }

  if (opts.uninstall && Object.keys(cfg).length === 0 && fs.existsSync(file)) {
    removeFile(file, opts.dryRun);
    return;
  }

  writeJson(file, cfg, opts.dryRun);

  if (!opts.uninstall && !opts.dryRun) {
    console.log(
      "  NOTE: Codex will not run this hook until you trust it — run `/hooks` " +
        "inside Codex and approve the agent-tools hooks."
    );
  }
}

// ---- opencode: a server plugin captures the resolved provider and refreshes
// usage after a session goes idle. A TUI plugin displays the shared snapshot. ----

const OPENCODE_STUB_NAME = "agent-tools-usage.js";

function opencodeConfigDir(opts) {
  return (
    opts.opencodeConfigDir ||
    process.env.OPENCODE_CONFIG_DIR ||
    path.join(os.homedir(), ".config", "opencode")
  );
}

// opencode.json may be JSONC with user comments — edit only our key in place.
function updateOpencodeVisionMcp(file, { remove, dryRun, mcp }) {
  const exists = fs.existsSync(file);
  const currentText = exists ? fs.readFileSync(file, "utf8") : "{}\n";
  const errors = [];
  const current = parseJsonc(currentText, errors, { allowTrailingComma: true }) || {};
  if (errors.length > 0 || typeof current !== "object" || Array.isArray(current)) {
    throw new Error(`Cannot parse ${file} as JSONC`);
  }
  const existing = current.mcp && current.mcp[VISION_MCP_NAME];
  if (existing && !isOpenCodeVisionMcp(existing, mcp)) {
    if (remove) {
      console.log(`  kept unmanaged ${VISION_MCP_NAME} entry in ${file}`);
      return;
    }
    throw new Error(
      `Found an existing unmanaged ${VISION_MCP_NAME} entry in ${file}. ` +
        "Remove or rename it, then re-run the install."
    );
  }
  const desired = remove
    ? undefined
    : { type: "local", command: [mcp.command, ...mcp.args], enabled: true };
  if (JSON.stringify(existing) === JSON.stringify(desired)) {
    console.log(`  kept existing ${file}`);
    return;
  }
  const eol = currentText.includes("\r\n") ? "\r\n" : "\n";
  const edits = modify(currentText, ["mcp", VISION_MCP_NAME], desired, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  });
  const updated = applyEdits(currentText, edits).replace(/\s*$/, "") + eol;
  writeText(file, updated, dryRun);
}

function runOpencodeVision(opts) {
  const configDir = opencodeConfigDir(opts);
  const file = path.join(configDir, "opencode.json");
  const skillsDir = path.join(configDir, "skills");
  console.log(`opencode vision: ${file}`);
  updateOpencodeVisionMcp(file, {
    remove: opts.uninstall,
    dryRun: opts.dryRun,
    mcp: visionMcpCommand(),
  });
  installVisionSkillDir(skillsDir, { remove: opts.uninstall, dryRun: opts.dryRun });
  console.log(opts.uninstall ? "  - vision" : "  + vision (inspect_image MCP + at-vision skill)");
}

function runOpencode(opts) {
  if (wants(opts, "vision")) runOpencodeVision(opts);
  if (!wants(opts, "usage")) {
    return;
  }

  const configDir = opencodeConfigDir(opts);
  const stub = path.join(configDir, "plugins", OPENCODE_STUB_NAME);
  const tuiConfig = path.join(configDir, "tui.json");
  console.log(`opencode (global): ${configDir}`);

  if (opts.uninstall) {
    if (fs.existsSync(stub)) removeFile(stub, opts.dryRun);
    else console.log("  no agent-tools server plugin found; nothing to remove.");
    updateOpenCodeTuiConfig(tuiConfig, { remove: true, dryRun: opts.dryRun });
    console.log("  - usage plugin");
    return;
  }

  const target = pathToFileURL(RUNTIME.opencodeUsagePlugin).href;
  const contents =
    "// Generated by agent-tools installer; do not edit.\n" +
    `export { AgentToolsUsage } from ${JSON.stringify(target)};\n`;
  writeText(stub, contents, opts.dryRun);
  updateOpenCodeTuiConfig(tuiConfig, { remove: false, dryRun: opts.dryRun });
  console.log("  + usage plugin (session idle + TUI)");
  if (!opts.dryRun) console.log("  NOTE: restart opencode to load the agent-tools usage plugin.");
}

function visionRuntimeHasRemainingReference(opts) {
  const removed = new Set(opts.agents);
  if (!removed.has("claude")) {
    const file = opts.claudeJson || path.join(os.homedir(), ".claude.json");
    try {
      if (isClaudeVisionMcp(readJson(file).mcpServers?.[VISION_MCP_NAME])) return true;
    } catch {
      return true;
    }
  }
  if (!removed.has("codex")) {
    const file = opts.codexConfig || path.join(os.homedir(), ".codex", "config.toml");
    try {
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const start = text.indexOf(CODEX_VISION_BEGIN);
      const end = text.indexOf(CODEX_VISION_END, start + CODEX_VISION_BEGIN.length);
      if (start !== -1 && end !== -1) {
        const block = text.slice(start, end);
        if (block.includes(fwd(VISION_RUNTIME_SERVER))) {
          return true;
        }
      }
    } catch {
      return true;
    }
  }
  if (!removed.has("opencode")) {
    const file = path.join(opencodeConfigDir(opts), "opencode.json");
    try {
      if (fs.existsSync(file)) {
        const errors = [];
        const config = parseJsonc(fs.readFileSync(file, "utf8"), errors, { allowTrailingComma: true });
        if (errors.length > 0) return true;
        if (isOpenCodeVisionMcp(config?.mcp?.[VISION_MCP_NAME])) return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

function cleanupVisionRuntimeIfUnused(opts) {
  if (!opts.uninstall || !wants(opts, "vision") || !fs.existsSync(VISION_RUNTIME_DIR)) return;
  if (visionRuntimeHasRemainingReference(opts)) {
    console.log(`  kept shared vision runtime ${VISION_RUNTIME_DIR} (another agent still references it)`);
    return;
  }
  if (opts.dryRun) {
    console.log(`  [dry-run] would remove unused vision runtime ${VISION_RUNTIME_DIR}`);
    return;
  }
  fs.rmSync(VISION_RUNTIME_DIR, { recursive: true, force: true });
  if (!fs.existsSync(`${VISION_RATE_LIMIT_STATE}.lock`)) {
    fs.rmSync(VISION_RATE_LIMIT_STATE, { force: true });
    try {
      fs.rmdirSync(path.dirname(VISION_RATE_LIMIT_STATE));
    } catch {
      // The shared cache directory may contain state for other integrations.
    }
  }
  console.log(`  removed unused vision runtime ${VISION_RUNTIME_DIR}`);
}

const AGENTS = { claude: runClaude, codex: runCodex, opencode: runOpencode };

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    // Print only the top-of-file header comment block (stop at the first
    // non-comment line so internal `// ----` section dividers don't leak).
    const help = [];
    for (const line of fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n")) {
      if (line.startsWith("#!")) continue;
      if (line.startsWith("//")) help.push(line.replace(/^\/\/ ?/, ""));
      else if (help.length) break;
    }
    console.log(help.join("\n"));
    return;
  }
  validateAgentCapabilities(opts);
  installRuntimeAssets(opts);
  if (wants(opts, "vision")) installVisionRuntime(opts);
  for (const name of opts.agents) {
    const run = AGENTS[name];
    if (!run) {
      console.error(`Unsupported agent: ${name} (supported: ${Object.keys(AGENTS).join(", ")})`);
      process.exit(2);
    }
    run(opts);
  }
  cleanupVisionRuntimeIfUnused(opts);
}

// Standalone vision commands dispatch before capability parsing so image
// paths and questions are never mistaken for integrations.
const subcommand = process.argv[2];
if (subcommand === "inspect-image") {
  const { runInspectImageCli } = await import(
    pathToFileURL(VISION_BUNDLED_CLI).href
  );
  process.exitCode = await runInspectImageCli(process.argv.slice(3));
} else if (subcommand === "mcp-vision") {
  await import(pathToFileURL(VISION_BUNDLED_MCP_SERVER).href);
} else {
  main();
}
