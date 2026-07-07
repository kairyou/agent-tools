#!/usr/bin/env node
// agent-tooling installer: wires hooks / statusline into each agent's config.
// Skills are NOT handled here — install those with `npx skills add`.
//
// Capabilities (all global for now — they target the user-level config):
//   statusline  Claude Code statusLine script (claude only).
//   guard       PreToolUse hook blocking catastrophic shell commands (claude + codex).
//
// Targets:
//   claude   -> ~/.claude/settings.json          (statusLine key + hooks key)
//   codex    -> ~/.codex/hooks.json              (standalone hooks file)
//   opencode -> ~/.config/opencode/plugin/agent-tooling-guard.js (generated stub)
// Runtime scripts are copied into ~/.agent-tooling so this installer can be
// run via npx from GitHub without requiring a persistent local clone.
//
// statusLine is global because it is a personal UI preference; the guard is
// global because a safety net should apply to every session.
//
// NOTE: Codex will not run a freshly-installed hook until you trust it — run
// `/hooks` inside Codex and approve the agent-tooling guard. opencode needs a
// restart to load the plugin.
//
// Usage:
//   agent-tooling <capabilities> [options]
//
// Options:
//   -a, --agent <names>       Target agents: claude | codex | opencode.
//                             Default: claude.
//   --settings <path>         Override the Claude settings.json (for testing).
//   --codex-hooks <path>      Override the Codex hooks.json (for testing).
//   --opencode-plugin-dir <p> Override the opencode plugin dir (for testing).
//   --uninstall               Remove what this installer added, restoring backups.
//   --dry-run                 Print planned changes without writing anything.
//   --force                   Overwrite a pre-existing, non-managed statusLine.
//   -h, --help                Show this help.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_ROOT =
  process.env.AGENT_TOOLING_HOME || path.join(os.homedir(), ".agent-tooling");
const META_KEY = "_agentTooling";
const META_VERSION = 1;
const SOURCE = {
  guardCommand: path.join(REPO_ROOT, "hooks", "common", "guard-command.mjs"),
  guardRules: path.join(REPO_ROOT, "hooks", "common", "guard-rules.mjs"),
  opencodeGuard: path.join(REPO_ROOT, "hooks", "opencode", "guard.mjs"),
  config: path.join(REPO_ROOT, "config.example.jsonc"),
  claudeStatusline: path.join(REPO_ROOT, "statusline", "claude", "statusline.mjs"),
};
const RUNTIME = {
  guardCommand: path.join(INSTALL_ROOT, "hooks", "common", "guard-command.mjs"),
  guardRules: path.join(INSTALL_ROOT, "hooks", "common", "guard-rules.mjs"),
  opencodeGuard: path.join(INSTALL_ROOT, "hooks", "opencode", "guard.mjs"),
  config: path.join(INSTALL_ROOT, "config.jsonc"),
  claudeStatusline: path.join(INSTALL_ROOT, "statusline", "claude", "statusline.mjs"),
};
const ALL_CAPS = ["statusline", "guard"];
const ALL_AGENTS = ["claude", "codex", "opencode"];

function fwd(p) {
  return p.replace(/\\/g, "/");
}

function nodeCmd(absScript) {
  return `node "${fwd(absScript)}"`;
}

function stripJsonComments(input) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (inString) {
      out += ch;
      escaped = ch === "\\" ? !escaped : false;
      if (ch === "\"" && !escaped) inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function readJsonc(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return raw.trim() ? JSON.parse(stripJsonComments(raw)) : {};
}

function headerComments(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = [];
  for (const line of lines) {
    if (/^\s*(?:\/\/.*)?$/.test(line)) {
      header.push(line);
      continue;
    }
    break;
  }
  return header.length ? header.join("\n").replace(/\s+$/, "") + "\n" : "";
}

function mergeDefaults(target, defaults) {
  if (Array.isArray(defaults)) return target === undefined ? defaults : target;
  if (!defaults || typeof defaults !== "object") {
    return target === undefined ? defaults : target;
  }
  const out = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(defaults)) {
    out[key] = mergeDefaults(out[key], value);
  }
  return out;
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

function mergeJsoncFile(src, dest, dryRun) {
  const defaults = readJsonc(src);
  const defaultHeader = headerComments(fs.readFileSync(src, "utf8"));
  if (!fs.existsSync(dest)) {
    writeText(dest, fs.readFileSync(src, "utf8"), dryRun);
    return;
  }
  const currentText = fs.readFileSync(dest, "utf8");
  const current = readJsonc(dest);
  const merged = mergeDefaults(current, defaults);
  const currentHeader = headerComments(currentText) || defaultHeader;
  const mergedText = currentHeader + JSON.stringify(merged, null, 2) + "\n";
  if (stripJsonComments(currentText).trim() === JSON.stringify(merged, null, 2)) {
    console.log(`  kept existing ${dest}`);
    return;
  }
  writeText(dest, mergedText, dryRun);
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
  if (wants(opts, "guard")) {
    files.push(
      [SOURCE.guardCommand, RUNTIME.guardCommand],
      [SOURCE.guardRules, RUNTIME.guardRules],
      [SOURCE.opencodeGuard, RUNTIME.opencodeGuard]
    );
  }
  if (wants(opts, "statusline")) {
    files.push(
      [SOURCE.claudeStatusline, RUNTIME.claudeStatusline],
      [SOURCE.config, RUNTIME.config, { mergeJsonc: true }]
    );
  }
  if (files.length === 0) return;
  console.log(`runtime: ${INSTALL_ROOT}`);
  for (const [src, dest, options] of files) copyRuntimeFile(src, dest, opts.dryRun, options);
}

function parseArgs(argv) {
  const opts = {
    agents: [],
    capabilities: [],
    settings: null,
    codexHooks: null,
    opencodePluginDir: null,
    uninstall: false,
    dryRun: false,
    force: false,
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
      case "--opencode-plugin-dir": opts.opencodePluginDir = argv[++i]; break;
      case "--uninstall": opts.uninstall = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--force": opts.force = true; break;
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
    console.log(`  [dry-run] would remove now-empty ${file}`);
    return;
  }
  fs.rmSync(file, { force: true });
  console.log(`  removed now-empty ${file}`);
}

// The guard hook entry, identified across configs by its command signature.
function guardEntry(matcher) {
  return { matcher, hooks: [{ type: "command", command: nodeCmd(RUNTIME.guardCommand) }] };
}

function isOurGuardEntry(entry) {
  return (
    entry &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some(
      (h) => typeof h?.command === "string" && h.command.includes("guard-command.mjs")
    )
  );
}

// Add/remove our guard in a `hooks.PreToolUse` array, coexisting with the
// user's own hooks. Returns nothing; mutates cfg in place.
function applyGuard(cfg, { matcher, remove }) {
  cfg.hooks = cfg.hooks || {};
  if (remove) {
    if (cfg.hooks.PreToolUse) {
      cfg.hooks.PreToolUse = cfg.hooks.PreToolUse.filter((e) => !isOurGuardEntry(e));
      if (cfg.hooks.PreToolUse.length === 0) delete cfg.hooks.PreToolUse;
    }
    if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
    return;
  }
  cfg.hooks.PreToolUse = cfg.hooks.PreToolUse || [];
  cfg.hooks.PreToolUse = cfg.hooks.PreToolUse.filter((e) => !isOurGuardEntry(e)); // idempotent
  cfg.hooks.PreToolUse.push(guardEntry(matcher));
}

// ---- Claude: statusLine (backed up in _agentTooling) + guard hook. ----

function runClaude(opts) {
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
      if (cfg.statusLine && !alreadyOurs && !opts.force) {
        console.error(
          "  statusline: refusing to overwrite an existing non-managed statusLine; " +
            "re-run with --force (the old value will be backed up)."
        );
        process.exit(1);
      }
      managed.statusLine = {
        backup: alreadyOurs ? managed.statusLine.backup ?? null : cfg.statusLine ?? null,
      };
      cfg.statusLine = { type: "command", command, padding: 0, refreshInterval: 60 };
      console.log("  + statusline");
    }
  }

  if (wants(opts, "guard")) {
    if (opts.uninstall) {
      applyGuard(cfg, { remove: true });
      delete managed.guard;
      console.log("  - guard");
    } else {
      applyGuard(cfg, { matcher: "Bash" });
      managed.guard = { event: "PreToolUse", matcher: "Bash" };
      console.log("  + guard (PreToolUse Bash)");
    }
  }

  if (Object.keys(managed).length === 0) delete cfg[META_KEY];
  writeJson(settings, cfg, opts.dryRun);
}

// ---- Codex: guard hook only, in a standalone hooks.json. No meta key is
// written (Codex validates hooks.json against a schema); our hook is found by
// command signature instead. ----

function runCodex(opts) {
  if (!wants(opts, "guard")) {
    console.log("codex: nothing to do (only supports: guard).");
    return;
  }
  const file = opts.codexHooks || path.join(os.homedir(), ".codex", "hooks.json");
  console.log(`codex (global): ${file}`);
  const cfg = readJson(file);

  if (opts.uninstall) {
    applyGuard(cfg, { remove: true });
    console.log("  - guard");
    if (Object.keys(cfg).length === 0 && fs.existsSync(file)) {
      removeFile(file, opts.dryRun);
      return;
    }
  } else {
    // Codex matches the tool name (normalized to "Bash") as a regex.
    applyGuard(cfg, { matcher: "^Bash$" });
    console.log("  + guard (PreToolUse Bash)");
  }

  writeJson(file, cfg, opts.dryRun);

  if (!opts.uninstall && !opts.dryRun) {
    console.log(
      "  NOTE: Codex will not run this hook until you trust it — run `/hooks` " +
        "inside Codex and approve the agent-tooling guard."
    );
  }
}

// ---- opencode: guard as a JS plugin. opencode has no declarative hook config;
// it auto-discovers plugin files from `{plugin,plugins}/*.{ts,js}` in its config
// dir. We drop a tiny generated `.js` stub there that re-exports the repo plugin
// (hooks/opencode/guard.mjs) by absolute file:// URL — so opencode loads it via
// its documented discovery path, we never touch opencode.json (avoiding JSONC
// parsing), the rules stay single-source in the repo, and repo edits are live.
// Note the stub MUST be `.js` (the discovery glob is *.{ts,js}, not .mjs). ----

const OPENCODE_STUB_NAME = "agent-tooling-guard.js";

function opencodePluginDir(opts) {
  return (
    opts.opencodePluginDir || path.join(os.homedir(), ".config", "opencode", "plugin")
  );
}

function runOpencode(opts) {
  if (!wants(opts, "guard")) {
    console.log("opencode: nothing to do (only supports: guard).");
    return;
  }
  const dir = opencodePluginDir(opts);
  const stub = path.join(dir, OPENCODE_STUB_NAME);
  console.log(`opencode (global): ${stub}`);

  if (opts.uninstall) {
    if (fs.existsSync(stub)) removeFile(stub, opts.dryRun);
    else console.log("  no agent-tooling plugin found; nothing to remove.");
    return;
  }

  const target = pathToFileURL(RUNTIME.opencodeGuard).href;
  const contents =
    `// Generated by agent-tooling installer — do not edit.\n` +
    `// Re-exports the installed guard plugin so opencode discovers it here.\n` +
    `export { AgentToolingGuard } from ${JSON.stringify(target)};\n`;

  if (opts.dryRun) {
    console.log(`  [dry-run] would write ${stub}:`);
    console.log(contents.split("\n").map((l) => "    " + l).join("\n"));
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stub, contents);
    console.log("  + guard (plugin stub)");
    console.log(
      "  NOTE: restart opencode to load the plugin. It does not cover subagent " +
        "`task`-tool calls (known opencode gap #5894)."
    );
  }
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
  installRuntimeAssets(opts);
  for (const name of opts.agents) {
    const run = AGENTS[name];
    if (!run) {
      console.error(`Unsupported agent: ${name} (supported: ${Object.keys(AGENTS).join(", ")})`);
      process.exit(2);
    }
    run(opts);
  }
}

main();
