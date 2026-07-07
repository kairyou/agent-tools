# Agent Tooling

Reusable agent tooling for Codex, Claude Code, and opencode. This repository packages skills, hooks, statusline support, and install helpers in predictable locations so each project can opt into only what it needs.

[中文](README.zh-CN.md)

## Directory Layout

```text
agent-tooling/
├── .claude-plugin/    # Claude Code/plugin ecosystem manifest.
├── .codex-plugin/     # Codex plugin manifest.
├── hooks/             # Hook scripts and config fragments, split by shared logic and agent wiring.
│   ├── common/        # Cross-agent hook logic: guard-rules.mjs + guard-command.mjs (Claude/Codex CLI).
│   ├── opencode/      # opencode plugin wiring (guard.mjs) that reuses common/ rules.
│   ├── claude/        # Claude Code hook material (wiring is generated into settings.json).
│   └── codex/         # Codex hook material (wiring is generated into hooks.json).
├── scripts/           # Install, sync, validation, and maintenance scripts.
├── skills/            # Reusable Agent Skills for CLI discovery and plugin manifests.
│   └── workflow/      # Workflow-oriented skills.
│       └── commit/    # Conventional Commit message skill.
└── statusline/        # Statusline scripts/templates, grouped by agent.
    ├── claude/        # Claude command-backed statusLine script.
    └── codex/         # Codex tui.status_line snippet (built-in fields only; no script).
```

## Current Skills

- `commit`: Generate a Conventional Commits message from staged changes and wait for user confirmation before committing.

## Usage

List available skills:

```bash
npx -y skills@latest add kairyou/agent-tooling --list
```

Install skills globally:

```bash
npx -y skills@latest add kairyou/agent-tooling --skill commit -g -y
```

Project-level install:

```bash
# Prefer --copy when installed files may be committed to Git.
npx -y skills@latest add kairyou/agent-tooling --skill commit --copy -y
```

Pass multiple skills after `--skill`, for example `--skill commit other-skill`.
By default, `skills@latest` detects the current agent.

## Installing hooks & statusline

Skills are installed with `npx -y skills@latest` (above). Hooks and statusline
are installed separately with `scripts/install.mjs` because agent plugin
manifests do not auto-load them.

```bash
# Claude: statusLine + guard
node scripts/install.mjs -a claude

# Codex: guard
node scripts/install.mjs -a codex

# opencode: guard plugin
node scripts/install.mjs -a opencode

# Multiple agents
node scripts/install.mjs -a claude -a codex -a opencode

# Only one capability, preview, or uninstall
node scripts/install.mjs --only guard
node scripts/install.mjs --dry-run
node scripts/install.mjs --uninstall
```

Installed capabilities:

- **Claude** — `statusLine` + the `guard` PreToolUse hook, in `~/.claude/settings.json`.
- **Codex** — the `guard` hook, in `~/.codex/hooks.json`.
- **opencode** — the `guard`, as a plugin stub dropped into `~/.config/opencode/plugin/`.

The `guard` hook blocks a small deny-list of catastrophic shell commands. It is
a safety net, not a sandbox, and it fails open.

After installing Codex hooks, run `/hooks` inside Codex and approve the
agent-tooling guard. After installing the opencode plugin, restart opencode.

## Notes

- `skills/` contains reusable `SKILL.md` capabilities.
- `hooks/common/` contains shared guard logic; agent-specific wiring lives under `hooks/<agent>/`.
- `statusline/claude/` contains the command-backed Claude statusLine script.
- The installer marks and removes only the config entries it owns.
