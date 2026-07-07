# Agent Tooling

Personal and team tooling for coding agents. The repository keeps reusable skills, hook scripts, statusline snippets, and install helpers in predictable locations so each project can opt into only what it needs.

中文版本: [README.zh-CN.md](README.zh-CN.md)

## Directory Layout

```text
agent-tooling/
├── .claude-plugin/    # Claude Code/plugin ecosystem manifest.
├── .codex-plugin/     # Codex plugin manifest.
├── hooks/             # Hook scripts and config snippets, split by shared logic and agent wiring.
│   ├── common/        # Cross-agent hook logic: guard-rules.mjs + guard-command.mjs (Claude/Codex CLI).
│   ├── opencode/      # opencode plugin wiring (guard.mjs) that reuses common/ rules.
│   ├── claude/        # Claude Code hook material (wiring is generated into settings.json).
│   └── codex/         # Codex hook material (wiring is generated into hooks.json).
├── scripts/           # Install, sync, validation, and maintenance scripts.
├── skills/            # Reusable Agent Skills for CLI discovery and plugin manifests.
│   └── workflow/      # Workflow-oriented skills.
│       └── commit/    # Conventional Commit message skill.
└── statusline/        # Statusline snippets/templates, grouped by agent.
    ├── claude/        # Claude command-backed statusLine script.
    └── codex/         # Codex tui.status_line snippet (built-in fields only; no script).
```

## Current Skills

- `commit`: Generate a Conventional Commits message from staged changes and wait for user confirmation before committing.

## Usage

List available skills:

```bash
npx skills@latest add D:\dev\agent-tooling --list
```

Install the `commit` skill globally for Codex:

```bash
npx skills@latest add D:\dev\agent-tooling -g -a codex --skill commit -y
```

For project-level installs that may be committed to Git, prefer `--copy` over symlinks:

```bash
npx skills@latest add D:\dev\agent-tooling --copy -a codex --skill commit -y
```

## Installing hooks & statusline

Skills are installed with `npx skills` (above). Hooks and statusline are **not**
auto-loaded by the plugin manifests, so they are wired into each agent's config
by `scripts/install.mjs` (Node, no dependencies).

Capabilities (all global for now — they target the user-level config):

- **statusline** — the Claude Code statusLine script.
- **guard** — a `PreToolUse` hook that blocks a tiny deny-list of catastrophic
  shell commands, both Unix (`rm -rf /`, fork bomb, `mkfs`, `dd` to a raw device,
  `curl … | sh`) and Windows/PowerShell (`rm -rf C:\`, `Remove-Item -Recurse
  -Force C:\`, `del /s /q C:\`, `format C:`). It is a safety net, not a sandbox,
  and fails open. The deny-list lives once in `hooks/common/guard-rules.mjs` and
  is wired into each agent (Codex uses the same PreToolUse stdin/stdout contract;
  opencode via a plugin).

```bash
# Claude (default): all capabilities into ~/.claude/settings.json
node scripts/install.mjs

# Codex: the guard hook into ~/.codex/hooks.json
node scripts/install.mjs -a codex

# opencode: drop the guard plugin into ~/.config/opencode/plugin/
node scripts/install.mjs -a opencode

# Several agents at once
node scripts/install.mjs -a claude -a codex -a opencode

# Only one capability
node scripts/install.mjs --only guard

# Preview without writing, or remove what this installer added
node scripts/install.mjs --dry-run
node scripts/install.mjs --uninstall
node scripts/install.mjs --only guard --uninstall
```

**Codex trust step:** Codex will not run a freshly installed hook until you
review and trust it — run `/hooks` inside Codex and approve the agent-tooling
guard. (There is no file-based pre-trust for user hooks.) The installer prints
this reminder after a Codex install.

**opencode restart:** opencode loads plugins at startup, so restart it after
installing. The installer drops a tiny generated stub
(`~/.config/opencode/plugin/agent-tooling-guard.js`) that re-exports the repo
plugin by absolute `file://` URL — opencode discovers it via its normal plugin
scan, `opencode.json` is never touched, and the implementation plus shared rules
stay single-source in the repo (so editing the repo updates the guard live).

The installer only touches keys it owns, records them under an `_agentTooling`
marker, and reverses exactly that on `--uninstall`: it appends its `guard` hook
alongside any hooks you already have (removing only its own on uninstall), backs
up a replaced `statusLine` (`--force` is required to overwrite a foreign one),
and restores that backup. Use `--settings <path>` to target a settings file
other than the default.

**Scope is per capability, not one-size-fits-all:**

- **statusLine is global only.** It is a personal UI preference; a project-scoped
  `statusLine` would be committed into a shared `.claude/settings.json` and forced
  on every collaborator. So it installs into `~/.claude/settings.json`.
- **Codex has no scriptable statusLine yet.** As of Codex 0.142.x, `tui.status_line`
  only selects/orders built-in footer fields (no command or template), so there is
  no Codex statusLine script — at most a future config snippet under
  `statusline/codex/`. A command-backed statusLine is an open request
  ([openai/codex#17827](https://github.com/openai/codex/issues/17827)); if it lands,
  a Codex script can follow the Claude pattern.
- **Hooks** can be global (like `guard`) or project-scoped. A project-scoped hook
  is project-specific automation, committable, and supports `$CLAUDE_PROJECT_DIR`
  for portable project-relative paths; that scope will return when such a hook is
  added.

Currently wired:

- **Claude** — `statusLine` + the `guard` PreToolUse hook, in `~/.claude/settings.json`.
- **Codex** — the `guard` hook, in `~/.codex/hooks.json`. Codex normalizes the
  shell tool name to `Bash` and uses the same PreToolUse stdin/deny contract as
  Claude, so the single `hooks/common/guard-command.mjs` serves both; the only
  difference is where it is wired and the `/hooks` trust step.
- **opencode** — the `guard`, as a plugin stub dropped into `~/.config/opencode/plugin/`.

All three guards share one deny-list (`hooks/common/guard-rules.mjs`): Claude and
Codex through the `guard-command.mjs` stdin/stdout CLI, opencode through the
`hooks/opencode/guard.mjs` plugin. Only Claude has a scriptable statusLine, so
`--only statusline` is a no-op for Codex and opencode.

## Notes

- `skills/` contains reusable `SKILL.md` capabilities. Projects may install only the skills they need.
- `npx skills` can discover skills by scanning this layout. Plugin manifests are kept for native plugin ecosystems and should list explicit skill paths when required.
- `hooks/` and `statusline/` are not auto-loaded by the plugin manifests. Future scripts under `scripts/` should install or sync those files into each agent's expected config location.
- Keep reusable hook logic in `hooks/common/`. Put Codex and Claude-specific hook wiring, config snippets, and thin wrappers in `hooks/codex/` and `hooks/claude/`.
- **opencode, per capability:**
  - *Skills* — auto-discovered with **zero wiring**. opencode reads `.claude/skills/`,
    `.agents/skills/`, `.opencode/skills/` (project) and the `~/.claude`, `~/.agents`,
    `~/.config/opencode` equivalents (global). Install skills into a shared
    `.claude`/`.agents` dir; don't duplicate a opencode-specific copy.
  - *Hooks* — opencode does **not** read `settings.json`/`hooks.json`. It uses a
    JS/TS **plugin** system (`tool.execute.before` + `throw` to block). The guard
    is `hooks/opencode/guard.mjs` (reusing the shared `hooks/common/guard-rules.mjs`);
    the installer drops a generated `.js` stub into `~/.config/opencode/plugin/`
    that re-exports it, so opencode auto-discovers it without editing `opencode.json`.
    (Note: `tool.execute.before` does not intercept subagent `task`-tool calls —
    a known gap, opencode #5894.)
  - *Statusline* — not supported by opencode yet (open request), so nothing to wire.
