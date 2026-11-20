#!/usr/bin/env node
// agent-tools installer: wires statusline / usage into each agent's config.
// Runtime-dependent skills are installed with their capability. Standalone
// skills are still handled by `npx skills add`.
//
// Capabilities (all global for now — they target the user-level config):
//   statusline  Claude Code statusLine script (claude only).
//   usage       API provider quota/balance via per-agent hooks or plugins.
//   vision      inspect_image host adapter + at-vision skill.
//   log         AI session work log via per-agent hooks or plugins.
//
// Standalone commands (dispatched before capability parsing):
//   inspect-image <path|url> --question "..."   Human diagnostic for vision.
//   mcp-vision                                  Run the vision MCP stdio server.
//
// Targets:
//   claude   -> ~/.claude/settings.json (statusLine key + log hooks)
//               + ~/.claude/skills/at-usage
//               ~/.claude.json (vision MCP) + ~/.claude/skills (at-vision)
//   codex    -> ~/.codex/hooks.json (usage + log hooks)
//               + ~/.agents/skills/at-usage
//               ~/.codex/config.toml (vision MCP) + ~/.agents/skills (at-vision)
//   opencode -> ~/.config/opencode/ (usage + log plugins,
//               vision MCP in opencode.json + skills/at-vision)
//   pi       -> ~/.pi/agent/extensions/ (usage footer + session log + native vision tool)
//               + ~/.pi/agent/skills/at-vision
//   zcode    -> Desktop usage extension + ~/.zcode/cli/config.json (log hooks + vision MCP)
//               + ~/.zcode/skills (at-usage, at-vision)
//   dsh      -> ~/.dsh/cordis.patch.yml (usage/log plugins + vision MCP client)
//               + ~/.dsh/skills (at-vision)
//   paseo    -> Paseo daemon plugin (usage only)
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
//   -a, --agent <names>       Target agents: claude | codex | opencode | pi | zcode | dsh | paseo.
//                             Default: claude.
//   --settings <path>         Override the Claude settings.json (for testing).
//   --codex-hooks <path>      Override the Codex hooks.json (for testing).
//   --opencode-config-dir <p> Override the opencode config dir (for testing).
//   --claude-json <path>      Override ~/.claude.json for vision MCP (for testing).
//   --claude-skills-dir <p>   Override ~/.claude/skills (for testing).
//   --codex-config <path>     Override ~/.codex/config.toml (for testing).
//   --codex-skills-dir <p>    Override ~/.agents/skills (for testing).
//   --pi-agent-dir <path>     Override ~/.pi/agent (for testing).
//   --zcode-config <path>     Override ~/.zcode/cli/config.json (for testing).
//   --zcode-skills-dir <path> Override ~/.zcode/skills (for testing).
//   --zcode-cli <path>        Use this ZCode executable or bundled zcode.cjs.
//   --dsh-home <path>         Override ~/.dsh (for testing).
//   --uninstall               Remove what this installer added, restoring backups.
//   --dry-run                 Print planned changes without writing anything.
//   -h, --help                Show this help.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import crossSpawn from "cross-spawn";
import { applyEdits, createScanner, findNodeAtLocation, modify, parse as parseJsonc, parseTree, SyntaxKind } from "jsonc-parser";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_ROOT =
  process.env.AGENT_TOOLS_HOME || path.join(os.homedir(), ".agent-tools");
const META_KEY = "_agentTools";
const META_VERSION = 1;
// Stamped into install-state.json so a later install can tell which release
// wrote the current layout. Purely informational today.
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version || "";
  } catch {
    return "";
  }
})();
// Everything copied into ~/.agent-tools is built output from dist/ (see
// scripts/build.mjs); capabilities/ holds the sources.
const SOURCE = {
  logHook: path.join(REPO_ROOT, "dist", "log", "hook.mjs"),
  logOpencodePlugin: path.join(REPO_ROOT, "dist", "log", "opencode-plugin.mjs"),
  logPiExtension: path.join(REPO_ROOT, "dist", "log", "pi-extension.mjs"),
  logZcodeHook: path.join(REPO_ROOT, "dist", "log", "zcode-hook.mjs"),
  logDshPlugin: path.join(REPO_ROOT, "dist", "log", "dsh-plugin.mjs"),
  codexUsageHook: path.join(REPO_ROOT, "dist", "usage", "codex-hook.mjs"),
  usageScript: path.join(REPO_ROOT, "dist", "usage", "core.mjs"),
  usageCli: path.join(REPO_ROOT, "dist", "usage", "cli.mjs"),
  config: path.join(REPO_ROOT, "config.default.jsonc"),
  claudeStatusline: path.join(REPO_ROOT, "dist", "statusline", "claude-statusline.mjs"),
  opencodeUsagePlugin: path.join(REPO_ROOT, "dist", "usage", "opencode-plugin.mjs"),
  opencodeUsageTui: path.join(REPO_ROOT, "dist", "usage", "opencode-tui.mjs"),
  piUsageExtension: path.join(REPO_ROOT, "dist", "usage", "pi-extension.mjs"),
  dshUsagePlugin: path.join(REPO_ROOT, "dist", "usage", "dsh-plugin.mjs"),
  dshUsageClient: path.join(REPO_ROOT, "dist", "usage", "dsh-client.mjs"),
  dshUsagePackage: path.join(REPO_ROOT, "dist", "usage", "package.json"),
};
const RUNTIME = {
  logHook: path.join(INSTALL_ROOT, "dist", "log", "hook.mjs"),
  logOpencodePlugin: path.join(INSTALL_ROOT, "dist", "log", "opencode-plugin.mjs"),
  logPiExtension: path.join(INSTALL_ROOT, "dist", "log", "pi-extension.mjs"),
  logZcodeHook: path.join(INSTALL_ROOT, "dist", "log", "zcode-hook.mjs"),
  logDshPlugin: path.join(INSTALL_ROOT, "dist", "log", "dsh-plugin.mjs"),
  codexUsageHook: path.join(INSTALL_ROOT, "dist", "usage", "codex-hook.mjs"),
  usageScript: path.join(INSTALL_ROOT, "dist", "usage", "core.mjs"),
  usageCli: path.join(INSTALL_ROOT, "dist", "usage", "cli.mjs"),
  config: path.join(INSTALL_ROOT, "config.jsonc"),
  claudeStatusline: path.join(INSTALL_ROOT, "dist", "statusline", "claude-statusline.mjs"),
  opencodeUsagePlugin: path.join(INSTALL_ROOT, "dist", "usage", "opencode-plugin.mjs"),
  opencodeUsageTui: path.join(INSTALL_ROOT, "dist", "usage", "opencode-tui.mjs"),
  piUsageExtension: path.join(INSTALL_ROOT, "dist", "usage", "pi-extension.mjs"),
  dshUsagePlugin: path.join(INSTALL_ROOT, "dist", "usage", "dsh-plugin.mjs"),
  dshUsageClient: path.join(INSTALL_ROOT, "dist", "usage", "dsh-client.mjs"),
  dshUsagePackage: path.join(INSTALL_ROOT, "dist", "usage", "package.json"),
};
const ALL_CAPS = ["statusline", "usage", "vision", "log"];
const ALL_AGENTS = ["claude", "codex", "opencode", "pi", "zcode", "dsh", "paseo"];
const AGENT_CAPS = {
  claude: ["statusline", "usage", "vision", "log"],
  codex: ["usage", "vision", "log"],
  opencode: ["usage", "vision", "log"],
  pi: ["usage", "vision", "log"],
  zcode: ["usage", "vision", "log"],
  dsh: ["usage", "vision", "log"],
  paseo: ["usage"],
};
const VISION_MCP_NAME = "agent-tools-vision";
const VISION_SKILL_NAME = "at-vision";
// The at-vision skill ships inside the vision capability dir (capabilities/vision),
// not skills/: it is unusable without the MCP server, so it must not surface
// as an independently installable skill.
const VISION_SKILL_SRC = path.join(REPO_ROOT, "capabilities", "vision", "skills", VISION_SKILL_NAME);
const USAGE_SKILL_NAME = "at-usage";
const USAGE_SKILL_SRC = path.join(REPO_ROOT, "capabilities", "usage", "skills", USAGE_SKILL_NAME);
const VISION_BUNDLED_MCP_SERVER = path.join(REPO_ROOT, "dist", "vision", "mcp-server.mjs");
const VISION_BUNDLED_CLI = path.join(REPO_ROOT, "dist", "vision", "cli.mjs");
const INSTALL_STATE_PATH = path.join(INSTALL_ROOT, "install-state.json");

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
  if (wants(opts, "log")) {
    addFile(SOURCE.logHook, RUNTIME.logHook);
    if (opts.agents.includes("zcode")) addFile(SOURCE.logZcodeHook, RUNTIME.logZcodeHook);
    if (opts.agents.includes("dsh")) addFile(SOURCE.logDshPlugin, RUNTIME.logDshPlugin);
    if (opts.agents.includes("pi")) {
      addFile(SOURCE.logPiExtension, RUNTIME.logPiExtension);
    }
    if (opts.agents.includes("opencode")) {
      addFile(SOURCE.logOpencodePlugin, RUNTIME.logOpencodePlugin);
    }
    addFile(SOURCE.config, RUNTIME.config, { mergeJsonc: true });
  }
  if (wants(opts, "usage")) {
    if (opts.agents.includes("paseo")) {
      for (const file of PASEO_USAGE_FILES) {
        addFile(path.join(REPO_ROOT, PASEO_USAGE_DIR, file), path.join(INSTALL_ROOT, PASEO_USAGE_DIR, file));
      }
    }
    if (opts.agents.includes("zcode")) {
      for (const file of ["marketplace.json", "agent-tools-usage/.zcode-plugin/plugin.json", "agent-tools-usage/zcode-extension.mjs"]) {
        addFile(path.join(REPO_ROOT, ZCODE_USAGE_MARKETPLACE, file), path.join(INSTALL_ROOT, ZCODE_USAGE_MARKETPLACE, file));
      }
    }
    if (opts.agents.includes("dsh")) {
      addFile(SOURCE.dshUsagePlugin, RUNTIME.dshUsagePlugin);
      addFile(SOURCE.dshUsageClient, RUNTIME.dshUsageClient);
      addFile(SOURCE.dshUsagePackage, RUNTIME.dshUsagePackage);
    }
    if (opts.agents.includes("pi")) {
      addFile(SOURCE.piUsageExtension, RUNTIME.piUsageExtension);
    }
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
const ZCODE_USAGE_MARKETPLACE = path.join("dist", "usage", "zcode-marketplace");
const PASEO_USAGE_DIR = path.join("dist", "usage", "paseo");
const PASEO_USAGE_FILES = ["index.client.tsx", "index.server.ts", "paseo-plugin.json"];

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
    capabilities: [],
    settings: null,
    codexHooks: null,
    opencodeConfigDir: null,
    claudeJson: null,
    claudeSkillsDir: null,
    codexConfig: null,
    codexSkillsDir: null,
    piAgentDir: null,
    zcodeConfig: null,
    zcodeSkillsDir: null,
    zcodeCli: null,
    dshHome: null,
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
      case "--pi-agent-dir": opts.piAgentDir = argv[++i]; break;
      case "--zcode-config": opts.zcodeConfig = argv[++i]; break;
      case "--zcode-skills-dir": opts.zcodeSkillsDir = argv[++i]; break;
      case "--zcode-cli": {
        opts.zcodeCli = argv[++i];
        if (!opts.zcodeCli || opts.zcodeCli.startsWith("--")) throw new Error("Missing path for --zcode-cli");
        break;
      }
      case "--dsh-home": opts.dshHome = argv[++i]; break;
      case "--uninstall": opts.uninstall = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        if (a.startsWith("-")) {
          console.error(`Unknown option: ${a}`);
          process.exit(2);
        }
        opts.capabilities.push(a);
    }
  }
  if (opts.agents.length === 0) opts.agents = ["claude"];
  if (opts.capabilities.length === 0 && opts.agents.every((agent) => agent === "paseo")) opts.capabilities = ["usage"];
  if (!opts.help && opts.capabilities.length === 0) {
    console.error(`Missing capability (available: ${ALL_CAPS.join(", ")})`);
    process.exit(2);
  }
  for (const name of opts.capabilities) {
    if (!ALL_CAPS.includes(name)) {
      console.error(`Unknown capability: ${name} (available: ${ALL_CAPS.join(", ")})`);
      process.exit(2);
    }
  }
  return opts;
}

function wants(opts, cap) {
  return opts.capabilities.length === 0 || opts.capabilities.includes(cap);
}

function validateAgentCapabilities(opts) {
  const invalid = [];
  for (const agent of opts.agents) {
    const supported = AGENT_CAPS[agent] || [];
    for (const cap of opts.capabilities) {
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

function usageEntry({ silent = false } = {}) {
  return {
    hooks: [
      {
        type: "command",
        command: `${nodeCmd(RUNTIME.codexUsageHook)}${silent ? " --silent" : ""}`,
        timeout: 5,
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
    cfg.hooks[event].push(usageEntry({ silent: event === "UserPromptSubmit" }));
  }
  if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
}

// ---- Log capability: agent hooks running dist/log/hook.mjs, identified by
// command signature (no meta key, mirroring the codex usage hooks). ----

const LOG_EVENTS = [
  ["UserPromptSubmit", ""],
  ["PreToolUse", "Write|Edit|MultiEdit"],
  ["PostToolUse", "Write|Edit|MultiEdit|Bash"],
  ["Stop", ""],
];

// Exact match against the command this installer writes: anything else, even a
// user's own .../dist/log/hook.mjs, is not ours and must survive uninstall.
function isOurLogEntry(entry) {
  const expected = nodeCmd(RUNTIME.logHook);
  return (
    entry &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => h?.command === expected)
  );
}

// Claude filters tool events via matchers; Codex hooks.json has no matcher
// concept, so there the hook filters by tool name itself.
function applyLogHooks(cfg, { remove, matchers }) {
  cfg.hooks = cfg.hooks || {};
  for (const [event, matcher] of LOG_EVENTS) {
    const entries = (cfg.hooks[event] || []).filter((entry) => !isOurLogEntry(entry));
    if (!remove) {
      const entry = {
        hooks: [{ type: "command", command: nodeCmd(RUNTIME.logHook), timeout: 30 }],
      };
      if (matchers && matcher) entry.matcher = matcher;
      entries.push(entry);
    }
    if (entries.length > 0) cfg.hooks[event] = entries;
    else delete cfg.hooks[event];
  }
  if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
}

function runClaudeLog(opts) {
  const settings = opts.settings || path.join(os.homedir(), ".claude", "settings.json");
  console.log(`claude log: ${settings}`);
  const cfg = readJson(settings);
  applyLogHooks(cfg, { remove: opts.uninstall, matchers: true });
  writeJson(settings, cfg, opts.dryRun);
  console.log(opts.uninstall ? "  - log" : "  + log (session work log hooks)");
}

function runCodexLog(opts) {
  const file = opts.codexHooks || path.join(os.homedir(), ".codex", "hooks.json");
  console.log(`codex log: ${file}`);
  const cfg = readJson(file);
  applyLogHooks(cfg, { remove: opts.uninstall, matchers: false });
  if (opts.uninstall && Object.keys(cfg).length === 0 && fs.existsSync(file)) {
    removeFile(file, opts.dryRun);
  } else {
    writeJson(file, cfg, opts.dryRun);
  }
  console.log(opts.uninstall ? "  - log" : "  + log (session work log hooks)");
  if (!opts.uninstall && !opts.dryRun) {
    console.log(
      "  NOTE: Codex will not run this hook until you trust it — run `/hooks` " +
        "inside Codex and approve the agent-tools hooks."
    );
  }
}

// ---- Vision capability helpers. ----

// The installed tree mirrors the package tree, so the bundled runtime lands in
// dist/vision just like in the package.
const VISION_RUNTIME_DIR = path.join(INSTALL_ROOT, "dist", "vision");
const VISION_RATE_LIMIT_STATE = path.join(INSTALL_ROOT, "cache", "vision-rate-limit.json");
const VISION_DIST_DIR = path.join(REPO_ROOT, "dist", "vision");
const VISION_RUNTIME_SERVER = path.join(VISION_RUNTIME_DIR, "mcp-server.mjs");
const VISION_RUNTIME_CLI = path.join(VISION_RUNTIME_DIR, "cli.mjs");
const VISION_RUNTIME_PI_EXTENSION = path.join(VISION_RUNTIME_DIR, "pi-extension.mjs");
const VISION_SKILL_IDENTITY = Object.freeze({
  owner: "@kairyou/agent-tools",
  capability: "vision",
  artifact: "skill",
});
const USAGE_SKILL_IDENTITY = Object.freeze({
  owner: "@kairyou/agent-tools",
  capability: "usage",
  artifact: "skill",
});
// Vision is bundled at release time. Install atomically swaps self-contained
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

function isZcodeVisionMcp(value, mcp = visionMcpCommand()) {
  return Boolean(
    value &&
      value.command === mcp.command &&
      Array.isArray(value.args) &&
      value.args.length === 1 &&
      isVisionServerPath(value.args[0])
  );
}

function installVisionRuntime(opts) {
  if (opts.uninstall) return;
  console.log(`vision runtime: ${VISION_RUNTIME_DIR}`);
  if (opts.dryRun) {
    console.log(`  [dry-run] would atomically install ${VISION_DIST_DIR} -> ${VISION_RUNTIME_DIR}`);
    return;
  }
  for (const name of ["mcp-server.mjs", "cli.mjs", "pi-extension.mjs"]) {
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
    for (const name of ["mcp-server.mjs", "cli.mjs", "pi-extension.mjs"]) {
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

function skillManifestKey(dest) {
  const resolved = fwd(path.resolve(dest));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function skillHash(skillFile) {
  if (!fs.existsSync(skillFile)) return "";
  return createHash("sha256").update(fs.readFileSync(skillFile)).digest("hex");
}

function matchesIdentity(value, identity) {
  return Object.entries(identity).every(([key, expected]) => value?.[key] === expected);
}

function readInstallState() {
  const value = readJson(INSTALL_STATE_PATH);
  if (Object.keys(value).length === 0) return { version: 1, artifacts: {} };
  if (
    value.version !== 1 ||
    !value.artifacts ||
    typeof value.artifacts !== "object" ||
    Array.isArray(value.artifacts)
  ) {
    throw new Error(`Cannot parse ${INSTALL_STATE_PATH}: unsupported install state schema`);
  }
  return value;
}

function writeInstallState(state) {
  if (Object.keys(state.artifacts).length === 0) {
    fs.rmSync(INSTALL_STATE_PATH, { force: true });
    return;
  }
  const text = JSON.stringify(state, null, 2) + "\n";
  const suffix = `${process.pid}-${Date.now()}`;
  const stage = `${INSTALL_STATE_PATH}.stage-${suffix}`;
  const backup = `${INSTALL_STATE_PATH}.backup-${suffix}`;
  let movedCurrent = false;
  fs.mkdirSync(path.dirname(INSTALL_STATE_PATH), { recursive: true });
  try {
    fs.writeFileSync(stage, text);
    if (fs.existsSync(INSTALL_STATE_PATH)) {
      fs.renameSync(INSTALL_STATE_PATH, backup);
      movedCurrent = true;
    }
    fs.renameSync(stage, INSTALL_STATE_PATH);
    fs.rmSync(backup, { force: true });
  } catch (error) {
    fs.rmSync(stage, { force: true });
    if (movedCurrent && !fs.existsSync(INSTALL_STATE_PATH) && fs.existsSync(backup)) {
      fs.renameSync(backup, INSTALL_STATE_PATH);
    }
    throw error;
  } finally {
    fs.rmSync(stage, { force: true });
    if (fs.existsSync(INSTALL_STATE_PATH)) fs.rmSync(backup, { force: true });
  }
  console.log(`  wrote ${INSTALL_STATE_PATH}`);
}

function managedSkillStatus(dest, identity) {
  const entry = readInstallState().artifacts[skillManifestKey(dest)];
  if (entry) {
    if (!matchesIdentity(entry, identity)) return "other";
    const currentHash = skillHash(path.join(dest, "SKILL.md"));
    return currentHash && currentHash === entry.sha256 ? "managed" : "modified";
  }
  return "unmanaged";
}

function recordManagedSkill(dest, identity) {
  const state = readInstallState();
  state.packageVersion = PACKAGE_VERSION;
  state.artifacts[skillManifestKey(dest)] = {
    path: fwd(path.resolve(dest)),
    ...identity,
    sha256: skillHash(path.join(dest, "SKILL.md")),
  };
  writeInstallState(state);
}

function forgetManagedSkill(dest) {
  const state = readInstallState();
  if (!state.artifacts[skillManifestKey(dest)]) return;
  delete state.artifacts[skillManifestKey(dest)];
  writeInstallState(state);
}

function installManagedSkillDir(
  skillsRoot,
  { name, source, identity, replacements, remove, dryRun }
) {
  const dest = path.join(skillsRoot, name);
  const status = fs.existsSync(dest) ? managedSkillStatus(dest, identity) : "missing";
  if (remove) {
    if (!fs.existsSync(dest)) {
      if (!dryRun) forgetManagedSkill(dest);
      return;
    }
    if (status === "modified") {
      if (!dryRun) forgetManagedSkill(dest);
      console.log(`  kept modified skill and released ownership ${dest}`);
      return;
    }
    if (status !== "managed") {
      console.log(`  kept unmanaged ${dest}`);
      return;
    }
    if (dryRun) {
      console.log(`  [dry-run] would remove ${dest}`);
      return;
    }
    fs.rmSync(dest, { recursive: true, force: true });
    forgetManagedSkill(dest);
    console.log(`  removed ${dest}`);
    return;
  }
  if (status === "modified") {
    console.error(
      `  Refusing to overwrite modified managed skill directory ${dest}. ` +
        `Move or restore it, then re-run the install.`
    );
    process.exit(1);
  }
  if (fs.existsSync(dest) && status !== "managed") {
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
  let skill = fs.readFileSync(path.join(source, "SKILL.md.tmpl"), "utf8");
  for (const [token, value] of Object.entries(replacements)) {
    if (!skill.includes(token)) {
      throw new Error(`${name} skill template is missing ${token}`);
    }
    skill = skill.replaceAll(token, value);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(source, dest, { recursive: true, filter: (entry) => !entry.endsWith(".tmpl") });
  fs.writeFileSync(path.join(dest, "SKILL.md"), skill);
  recordManagedSkill(dest, identity);
  console.log(`  wrote ${dest}`);
}

function installVisionSkillDir(skillsRoot, { remove, dryRun }) {
  installManagedSkillDir(skillsRoot, {
    name: VISION_SKILL_NAME,
    source: VISION_SKILL_SRC,
    identity: VISION_SKILL_IDENTITY,
    replacements: { "{{VISION_CLI_PATH}}": fwd(VISION_RUNTIME_CLI) },
    remove,
    dryRun,
  });
}

function installUsageSkillDir(skillsRoot, agent, { remove, dryRun }) {
  installManagedSkillDir(skillsRoot, {
    name: USAGE_SKILL_NAME,
    source: USAGE_SKILL_SRC,
    identity: USAGE_SKILL_IDENTITY,
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
  if (wants(opts, "log")) runClaudeLog(opts);
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
  if (wants(opts, "log")) runCodexLog(opts);
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
const OPENCODE_LOG_STUB_NAME = "agent-tools-log.js";

function runOpencodeLog(opts) {
  const configDir = opencodeConfigDir(opts);
  const stub = path.join(configDir, "plugins", OPENCODE_LOG_STUB_NAME);
  console.log(`opencode log: ${stub}`);
  if (opts.uninstall) {
    if (fs.existsSync(stub)) removeFile(stub, opts.dryRun);
    else console.log("  no agent-tools log plugin found; nothing to remove.");
    console.log("  - log");
    return;
  }
  const target = pathToFileURL(RUNTIME.logOpencodePlugin).href;
  const contents =
    "// Generated by agent-tools installer; do not edit.\n" +
    `export { AgentToolsLog } from ${JSON.stringify(target)};\n`;
  writeText(stub, contents, opts.dryRun);
  console.log("  + log (session work log plugin)");
  if (!opts.dryRun) console.log("  NOTE: restart opencode to load the agent-tools log plugin.");
}

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
  if (wants(opts, "log")) runOpencodeLog(opts);
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

// ---- Pi: native extension tool plus the capability-owned skill. ----

const PI_VISION_STUB_NAME = "agent-tools-vision.js";

function piAgentDir(opts) {
  return opts.piAgentDir || path.join(os.homedir(), ".pi", "agent");
}

function piVisionStubContents() {
  return (
    "// Generated by agent-tools installer; do not edit.\n" +
    `export { default } from ${JSON.stringify(pathToFileURL(VISION_RUNTIME_PI_EXTENSION).href)};\n`
  );
}

function isManagedPiVisionStub(file) {
  return fs.existsSync(file) && fs.readFileSync(file, "utf8") === piVisionStubContents();
}

function runPi(opts) {
  for (const capability of ["usage", "log"]) {
    if (!wants(opts, capability)) continue;
    const runtime = capability === "usage" ? RUNTIME.piUsageExtension : RUNTIME.logPiExtension;
    const stub = path.join(piAgentDir(opts), "extensions", `agent-tools-${capability}.js`);
    const contents = "// Generated by agent-tools installer; do not edit.\n" +
      `export { default } from ${JSON.stringify(pathToFileURL(runtime).href)};\n`;
    const managed = fs.existsSync(stub) && fs.readFileSync(stub, "utf8") === contents;
    console.log(`pi ${capability}: ${stub}`);
    if (opts.uninstall) {
      if (managed) removeFile(stub, opts.dryRun);
      else if (fs.existsSync(stub)) console.log(`  kept unmanaged ${stub}`);
    } else {
      if (fs.existsSync(stub) && !managed) {
        throw new Error(`Refusing to overwrite existing unmanaged Pi extension ${stub}. Move or remove it, then re-run the install.`);
      }
      writeText(stub, contents, opts.dryRun);
      if (!opts.dryRun) console.log(`  NOTE: restart Pi or run /reload to load the agent-tools ${capability} extension.`);
    }
  }
  if (!wants(opts, "vision")) return;
  const agentDir = piAgentDir(opts);
  const stub = path.join(agentDir, "extensions", PI_VISION_STUB_NAME);
  const skillsDir = path.join(agentDir, "skills");
  console.log(`pi vision: ${stub}`);

  if (opts.uninstall) {
    if (isManagedPiVisionStub(stub)) removeFile(stub, opts.dryRun);
    else if (fs.existsSync(stub)) console.log(`  kept unmanaged ${stub}`);
    else console.log("  no agent-tools vision extension found; nothing to remove.");
    installVisionSkillDir(skillsDir, { remove: true, dryRun: opts.dryRun });
    console.log("  - vision");
    return;
  }

  if (fs.existsSync(stub) && !isManagedPiVisionStub(stub)) {
    throw new Error(
      `Refusing to overwrite existing unmanaged Pi extension ${stub}. ` +
        "Move or remove it, then re-run the install."
    );
  }
  writeText(stub, piVisionStubContents(), opts.dryRun);
  installVisionSkillDir(skillsDir, { remove: false, dryRun: opts.dryRun });
  console.log("  + vision (native inspect_image extension + at-vision skill)");
  if (!opts.dryRun) console.log("  NOTE: restart Pi or run /reload to load the agent-tools vision extension.");
}

// ---- ZCode: native user MCP config plus the user-level skill. ----

function updateZcodeVisionMcp(file, { remove, dryRun, mcp }) {
  const exists = fs.existsSync(file);
  const currentText = exists ? fs.readFileSync(file, "utf8") : "{}\n";
  const errors = [];
  const current = parseJsonc(currentText, errors, { allowTrailingComma: true }) || {};
  if (errors.length > 0 || typeof current !== "object" || Array.isArray(current)) {
    throw new Error(`Cannot parse ${file} as JSONC`);
  }
  const existing = current.mcp?.servers?.[VISION_MCP_NAME];
  if (existing && !isZcodeVisionMcp(existing, mcp)) {
    if (remove) {
      console.log(`  kept unmanaged ${VISION_MCP_NAME} entry in ${file}`);
      return;
    }
    throw new Error(
      `Found an existing unmanaged ${VISION_MCP_NAME} entry in ${file}. ` +
        "Remove or rename it, then re-run the install."
    );
  }
  const desired = remove ? undefined : { command: mcp.command, args: mcp.args, env: {} };
  if (JSON.stringify(existing) === JSON.stringify(desired)) {
    console.log(`  kept existing ${file}`);
    return;
  }
  const eol = currentText.includes("\r\n") ? "\r\n" : "\n";
  const edits = modify(currentText, ["mcp", "servers", VISION_MCP_NAME], desired, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  });
  const updated = applyEdits(currentText, edits).replace(/\s*$/, "") + eol;
  writeText(file, updated, dryRun);
}

// Match the existing log-hook allowance: the recorder can wait five seconds
// for a shared lock before it starts filesystem and Git work.
const ZCODE_HOOK_TIMEOUT_MS = 30_000;

// Delete only the managed item and its separator. JSONC's default deletion can
// also consume comments between siblings.
function removeZcodeConfigItem(text, segments) {
  const value = findNodeAtLocation(parseTree(text), segments);
  const item = value.parent.type === "property" ? value.parent : value;
  const siblings = item.parent.children;
  const previous = siblings[siblings.indexOf(item) - 1];
  const scanner = createScanner(text, true);
  const itemEnd = item.offset + item.length;
  scanner.setPosition(itemEnd);
  let comma = scanner.scan() === SyntaxKind.CommaToken ? scanner.getTokenOffset() : -1;
  if (comma === -1 && previous) {
    scanner.setPosition(previous.offset + previous.length);
    if (scanner.scan() === SyntaxKind.CommaToken) comma = scanner.getTokenOffset();
  }
  let start = item.offset;
  let end = itemEnd;
  if (comma === end) { end++; comma = -1; }
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", end);
  if (lineEnd !== -1 && !text.slice(lineStart, start).trim() && !text.slice(end, lineEnd).trim()) {
    start = lineStart;
    end = lineEnd + 1;
  }
  const edits = [{ offset: start, length: end - start, content: "" }];
  if (comma !== -1) edits.push({ offset: comma, length: 1, content: "" });
  return applyEdits(text, edits);
}

function runZcodeLog(opts) {
  const file = opts.zcodeConfig || path.join(os.homedir(), ".zcode", "cli", "config.json");
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}\n";
  const hooks = readJsonc(file).hooks || {};
  const events = hooks.events || {};
  if (typeof hooks !== "object" || Array.isArray(hooks) ||
      typeof events !== "object" || Array.isArray(events)) {
    throw new Error(`Cannot update invalid ZCode hooks in ${file}`);
  }
  const entry = { type: "process", command: "node", args: [RUNTIME.logZcodeHook], timeoutMs: ZCODE_HOOK_TIMEOUT_MS };
  const owned = (hook) => hook?.type === "process" && hook.command === "node" &&
    fwd(hook.args?.[0] || "") === fwd(RUNTIME.logZcodeHook);
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  let updated = original;
  const set = (segments, value, isArrayInsertion = false) => {
    updated = applyEdits(updated, modify(updated, segments, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol }, isArrayInsertion,
    }));
  };
  const remove = (segments) => { updated = removeZcodeConfigItem(updated, segments); };
  const removeEmpty = (segments) => {
    const node = findNodeAtLocation(parseTree(updated), segments);
    if (node && /^\s*$/.test(updated.slice(node.offset + 1, node.offset + node.length - 1))) remove(segments);
  };

  const state = readInstallState();
  const stateKey = `zcode-log-hooks:${skillManifestKey(file)}`;
  const hasHooks = Object.values(events).some((groups) => groups.some((group) => group.hooks?.length));
  const enable = !opts.uninstall && hooks.enabled === undefined && !hasHooks;
  if (enable) set(["hooks", "enabled"], true);
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
    const eventPath = ["hooks", "events", event];
    const groups = events[event] || [];
    const keep = opts.uninstall ? -1 : groups.findIndex((group) =>
      Object.keys(group).length === 1 && group.hooks?.length === 1 && owned(group.hooks[0]));
    let removedGroup = false;
    for (let index = groups.length - 1; index >= 0; index--) {
      const entries = groups[index].hooks || [];
      const groupPath = [...eventPath, index];
      if (index === keep) {
        if (JSON.stringify(entries[0]) !== JSON.stringify(entry)) set([...groupPath, "hooks", 0], entry);
      } else if (entries.length && entries.every(owned)) {
        remove(groupPath);
        removedGroup = true;
      } else {
        for (let hook = entries.length - 1; hook >= 0; hook--) {
          if (owned(entries[hook])) remove([...groupPath, "hooks", hook]);
        }
      }
    }
    if (!opts.uninstall && keep === -1) set([...eventPath, 0], { hooks: [entry] }, true);
    if (opts.uninstall && removedGroup) removeEmpty(eventPath);
  }

  const forgetToggle = opts.uninstall && state.artifacts[stateKey];
  if (opts.uninstall && (updated !== original || forgetToggle)) {
    const remaining = parseJsonc(updated).hooks?.events || {};
    if (forgetToggle && hooks.enabled === true && !Object.values(remaining).some((groups) => groups.length)) {
      remove(["hooks", "enabled"]);
    }
    removeEmpty(["hooks", "events"]);
    removeEmpty(["hooks"]);
  }
  if (updated !== original) writeText(file, updated, opts.dryRun);
  if (!opts.dryRun && (enable || forgetToggle)) {
    if (enable) state.artifacts[stateKey] = { kind: "zcode-log-hooks" };
    else delete state.artifacts[stateKey];
    writeInstallState(state);
  }
  console.log(opts.uninstall ? "  - ZCode log hooks" : "  + ZCode log hooks (new sessions)");
  if (!opts.uninstall && !enable && hooks.enabled !== true) {
    console.log("  Enable hooks in ZCode to start recording work logs.");
  }
}

const ZCODE_USAGE_MARKET_ID = "agent-tools-local";
const ZCODE_USAGE_PLUGIN_ID = `agent-tools-usage@${ZCODE_USAGE_MARKET_ID}`;

function zcodeCliForExecutable(file) {
  if (!file || /\.[cm]?js$/i.test(file)) return file;
  // Desktop launchers can share the CLI's name, notably a symlink in PATH
  // from a Linux package. Use the bundled CLI next to the actual executable.
  let real;
  try { real = fs.realpathSync(file); } catch { return file; }
  const dir = path.dirname(real);
  const resources = process.platform === "darwin" && path.basename(dir) === "MacOS"
    ? path.join(path.dirname(dir), "Resources") : path.join(dir, "resources");
  const companion = path.join(resources, "glm", "zcode.cjs");
  return fs.existsSync(companion) ? companion : file;
}

function findZcodeCli(opts) {
  if (opts.zcodeCli) return zcodeCliForExecutable(path.resolve(opts.zcodeCli));
  // An explicit test/profile path does not retarget ZCode's own plugin CLI.
  if (opts.zcodeConfig || opts.zcodeSkillsDir) return null;
  const desktopRoots = process.platform === "win32"
    ? [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"), process.env.ProgramFiles]
      .filter(Boolean).map((root) => path.join(root, "ZCode", "resources"))
    : process.platform === "darwin"
      ? ["/Applications", path.join(os.homedir(), "Applications")]
        .map((root) => path.join(root, "ZCode.app", "Contents", "Resources"))
      : [];
  const executable = process.platform === "win32" ? "zcode.exe" : "zcode";
  // Prefer the desktop application's companion, whose plugin schema matches it.
  const bundled = desktopRoots.map((root) => path.join(root, "glm", "zcode.cjs")).find((file) => fs.existsSync(file));
  if (bundled) return bundled;
  const onPath = (process.env.PATH || "").split(path.delimiter).filter(path.isAbsolute)
    .map((dir) => path.join(dir, executable)).find((file) => fs.existsSync(file));
  return zcodeCliForExecutable(onPath);
}

function updateZcodeDesktopUsage(opts) {
  const cli = findZcodeCli(opts);
  const marketDir = path.resolve(INSTALL_ROOT, ZCODE_USAGE_MARKETPLACE);
  const fallback = opts.uninstall ? "Remove agent-tools-usage in the ZCode Plugin Marketplace if enabled." :
    `In the ZCode Plugin Marketplace, add ${marketDir}, then install and enable agent-tools-usage.`;
  if (!cli) { console.log(`  ${fallback}`); return; }
  if (opts.dryRun) {
    console.log(`  [dry-run] would ${opts.uninstall ? "remove" : "install"} ${ZCODE_USAGE_PLUGIN_ID} using ${cli}`);
    return;
  }
  const fromNode = /\.[cm]?js$/i.test(cli);
  function run(...args) {
    const command = fromNode ? process.execPath : cli;
    const child = spawnSync(command, [...(fromNode ? [cli] : []), "plugins", ...args, "--json"], {
      cwd: os.homedir(), encoding: "utf8", windowsHide: true,
      // These commands manage a local source. A GUI launcher or stalled CLI
      // should return control to the installer instead of blocking it forever.
      timeout: 30_000,
    });
    if (child.error || child.status !== 0) {
      throw new Error(child.error?.message || child.stderr?.trim() || `ZCode plugins ${args.slice(0, 2).join(" ")} failed`);
    }
    return JSON.parse(child.stdout);
  }
  try {
    const marketplace = run("marketplace", "list").find(({ id }) => id === ZCODE_USAGE_MARKET_ID);
    if (marketplace && (marketplace.source?.source !== "directory" ||
      !marketplace.source.path || path.relative(marketDir, marketplace.source.path) !== "")) {
      throw new Error(`the ${ZCODE_USAGE_MARKET_ID} marketplace already points to another source`);
    }
    if (opts.uninstall) {
      if (!marketplace) return;
      const installed = run("list", "--scope", "user").some(({ id }) => id === ZCODE_USAGE_PLUGIN_ID);
      if (installed) run("uninstall", ZCODE_USAGE_PLUGIN_ID, "--scope", "user", "--force");
      run("marketplace", "remove", ZCODE_USAGE_MARKET_ID);
      console.log("  - ZCode Desktop usage extension");
    } else {
      if (marketplace) run("marketplace", "update", ZCODE_USAGE_MARKET_ID);
      else run("marketplace", "add", marketDir, "--scope", "user");
      const result = run("install", ZCODE_USAGE_PLUGIN_ID, "--scope", "user");
      const installed = result.installed?.find(({ id }) => id === ZCODE_USAGE_PLUGIN_ID);
      if (result.ok !== true || !installed) throw new Error("ZCode did not install agent-tools-usage");
      if (!installed.enabled) run("enable", ZCODE_USAGE_PLUGIN_ID, "--scope", "user");
      console.log("  + ZCode Desktop usage extension (restart ZCode to load)");
    }
  } catch (error) {
    console.warn(`  ZCode Desktop extension: ${error.message}\n  ${fallback}`);
  }
}

function runZcode(opts) {
  if (wants(opts, "log")) runZcodeLog(opts);
  if (wants(opts, "usage")) {
    const skillsDir = opts.zcodeSkillsDir || path.join(os.homedir(), ".zcode", "skills");
    installUsageSkillDir(skillsDir, "zcode", { remove: opts.uninstall, dryRun: opts.dryRun });
    updateZcodeDesktopUsage(opts);
  }
  if (!wants(opts, "vision")) return;
  const file = opts.zcodeConfig || path.join(os.homedir(), ".zcode", "cli", "config.json");
  const skillsDir = opts.zcodeSkillsDir || path.join(os.homedir(), ".zcode", "skills");
  console.log(`zcode vision: ${file}`);
  updateZcodeVisionMcp(file, {
    remove: opts.uninstall,
    dryRun: opts.dryRun,
    mcp: visionMcpCommand(),
  });
  installVisionSkillDir(skillsDir, { remove: opts.uninstall, dryRun: opts.dryRun });
  console.log(opts.uninstall ? "  - vision" : "  + vision (inspect_image MCP + at-vision skill)");
  if (!opts.uninstall && !opts.dryRun) {
    console.log("  NOTE: start a new ZCode session to load the agent-tools vision MCP server.");
  }
}

// ---- DeepSeek Harness: official MCP client row in the global Cordis patch. ----

const DSH_VISION_BEGIN = "# >>> agent-tools vision >>>";
const DSH_VISION_END = "# <<< agent-tools vision <<<";
const DSH_VISION_ROW_ID = "agent-tools-vision";

function dshHome(opts) {
  return opts.dshHome || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function dshVisionBlock(mcp) {
  return [
    DSH_VISION_BEGIN,
    "- insert:",
    `    - id: ${DSH_VISION_ROW_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    `        serverName: ${DSH_VISION_ROW_ID}`,
    "        transport: stdio",
    `        command: ${JSON.stringify(mcp.command)}`,
    `        args: [${mcp.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    "        env: {}",
    DSH_VISION_END,
    "",
  ].join("\n");
}

function updateDshPatch(file, { remove, dryRun, capability, block }) {
  const begin = `# >>> agent-tools ${capability} >>>`;
  const end = `# <<< agent-tools ${capability} <<<`;
  const rowId = `agent-tools-${capability}`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "[]\n";
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(
    `\\r?\\n?${escape(begin)}[\\s\\S]*?${escape(end)}\\r?\\n?`
  );
  const hadManagedBlock = blockRe.test(current);
  const match = current.match(blockRe);
  const base = match ? [
    current.slice(0, match.index).trimEnd(),
    current.slice(match.index + match[0].length).trimStart(),
  ].filter(Boolean).join("\n\n") : current.trim();
  const content = base.replace(/^\s*#.*$/gm, "").trim();
  if (content !== "" && content !== "[]" && !content.startsWith("-")) {
    throw new Error(`Cannot update ${file}: the Cordis patch must be a top-level YAML array`);
  }

  if (!remove && !hadManagedBlock) {
    const conflict = new RegExp(
      `^\\s*(?:-\\s*)?(?:id|serverName):\\s*['\"]?${escape(rowId)}['\"]?\\s*$`,
      "m"
    );
    if (conflict.test(base)) {
      throw new Error(
        `Found an existing unmanaged ${rowId} Cordis row in ${file}. ` +
          "Remove or rename it, then re-run the install."
      );
    }
  }

  let next;
  if (remove) {
    if (!hadManagedBlock) {
      console.log(`  no managed ${rowId} Cordis row found; nothing to remove.`);
      return;
    }
    next = base === "" ? "[]\n" : `${base}\n`;
  } else {
    const prefix = content === "[]" ? base.replace(/^\s*\[\]\s*$/m, "").trim() : base;
    next = hadManagedBlock
      ? current.replace(blockRe, (_match, offset) => `${offset ? "\n" : ""}${block}`)
      : prefix === "" ? block : `${prefix}\n\n${block}`;
  }
  if (next === current) {
    console.log(`  kept existing ${file}`);
    return;
  }
  writeText(file, next, dryRun);
}

function runDsh(opts) {
  const home = dshHome(opts);
  const patchFile = path.join(home, "cordis.patch.yml");
  if (wants(opts, "usage")) {
    const block = [
      "# >>> agent-tools usage >>>", "- insert:", "    - id: agent-tools-usage",
      `      name: ${JSON.stringify(pathToFileURL(RUNTIME.dshUsagePlugin).href)}`,
      "# <<< agent-tools usage <<<", "",
    ].join("\n");
    updateDshPatch(patchFile, { remove: opts.uninstall, dryRun: opts.dryRun, capability: "usage", block });
    console.log(opts.uninstall ? "  - DSH usage plugin" : "  + DSH usage plugin (restart DSH to load)");
  }
  if (wants(opts, "log")) {
    const block = [
      "# >>> agent-tools log >>>", "- insert:", "    - id: agent-tools-log",
      `      name: ${JSON.stringify(pathToFileURL(RUNTIME.logDshPlugin).href)}`,
      "# <<< agent-tools log <<<", "",
    ].join("\n");
    updateDshPatch(patchFile, { remove: opts.uninstall, dryRun: opts.dryRun, capability: "log", block });
    console.log(opts.uninstall ? "  - DSH log plugin" : "  + DSH log plugin (restart DSH to load)");
  }
  if (!wants(opts, "vision")) return;
  const skillsDir = path.join(home, "skills");
  console.log(`dsh vision: ${patchFile}`);
  updateDshPatch(patchFile, {
    remove: opts.uninstall,
    dryRun: opts.dryRun,
    capability: "vision",
    block: dshVisionBlock(visionMcpCommand()),
  });
  installVisionSkillDir(skillsDir, { remove: opts.uninstall, dryRun: opts.dryRun });
  console.log(opts.uninstall ? "  - vision" : "  + vision (official MCP client row + at-vision skill)");
  if (!opts.uninstall && !opts.dryRun) {
    console.log("  NOTE: restart DSH and wait for mcp__agent-tools-vision__inspect_image to appear.");
  }
}

function runPaseo(opts) {
  const pluginId = "agent-tools-usage";
  const source = path.resolve(INSTALL_ROOT, PASEO_USAGE_DIR);
  if (opts.dryRun) {
    console.log(`  [dry-run] would ${opts.uninstall ? "remove" : "install or reload"} ${pluginId} in Paseo`);
    return;
  }
  function run(command, ...args) {
    const result = crossSpawn.sync("paseo", ["plugin", command, ...args, "--json"], {
      encoding: "utf8", windowsHide: true, timeout: 30_000,
    });
    if (result.error?.code === "ENOENT") throw new Error("Paseo CLI was not found on PATH.");
    if (result.error || result.status !== 0) {
      let message;
      try { message = JSON.parse(result.stdout)?.error?.message; } catch { /* Paseo can also print plain text. */ }
      throw new Error(result.error?.message || message || result.stderr?.trim() || `paseo plugin ${command} failed`);
    }
    return JSON.parse(result.stdout);
  }

  try {
    const existing = run("ls").find(({ id }) => id === pluginId);
    const identity = existing?.installation?.identity;
    if (existing && (identity?.kind !== "directory" || path.relative(source, identity.path) !== "")) {
      throw new Error(`The existing ${pluginId} plugin uses another source. Remove it in Paseo before replacing it.`);
    }
    if (opts.uninstall) {
      if (existing) run("remove", pluginId);
      for (const file of PASEO_USAGE_FILES) fs.rmSync(path.join(source, file), { force: true });
      console.log("  - Paseo usage plugin");
      return;
    }
    const plugin = existing ? run("reload", pluginId) : run("install", source);
    if (plugin.status === "failed") throw new Error(plugin.error || "The Paseo plugin failed to load.");
    console.log("  + Paseo usage plugin");
    if (plugin.status === "disabled") console.log("  Enable plugins in Paseo to load the usage plugin.");
  } catch (error) {
    console.error(`Paseo usage: ${error.message}`);
    process.exitCode = 1;
  }
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
  if (!removed.has("pi")) {
    const stub = path.join(piAgentDir(opts), "extensions", PI_VISION_STUB_NAME);
    try {
      if (isManagedPiVisionStub(stub)) return true;
    } catch {
      return true;
    }
  }
  if (!removed.has("zcode")) {
    const file = opts.zcodeConfig || path.join(os.homedir(), ".zcode", "cli", "config.json");
    try {
      if (isZcodeVisionMcp(readJsonc(file).mcp?.servers?.[VISION_MCP_NAME])) return true;
    } catch {
      return true;
    }
  }
  if (!removed.has("dsh")) {
    const file = path.join(dshHome(opts), "cordis.patch.yml");
    try {
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const start = text.indexOf(DSH_VISION_BEGIN);
      const end = text.indexOf(DSH_VISION_END, start + DSH_VISION_BEGIN.length);
      if (start !== -1 && end !== -1) {
        const block = text.slice(start, end);
        if (block.includes(fwd(VISION_RUNTIME_SERVER))) return true;
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
      // The shared cache directory may contain state for other capabilities.
    }
  }
  console.log(`  removed unused vision runtime ${VISION_RUNTIME_DIR}`);
}

const AGENTS = {
  claude: runClaude,
  codex: runCodex,
  opencode: runOpencode,
  pi: runPi,
  zcode: runZcode,
  dsh: runDsh,
  paseo: runPaseo,
};

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
// paths and questions are never mistaken for capabilities.
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
