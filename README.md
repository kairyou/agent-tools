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
    └── claude/        # Claude command-backed statusLine script + example config.
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

## Installing hooks & statusline

Install hooks and statusline with the repo installer:

```bash
# Claude: statusLine + guard
npx -y github:kairyou/agent-tooling statusline guard -a claude

# Codex: guard + API usage
npx -y github:kairyou/agent-tooling guard usage -a codex

# opencode: guard plugin
npx -y github:kairyou/agent-tooling guard -a opencode

# Multiple agents
npx -y github:kairyou/agent-tooling guard -a claude codex opencode

# Preview or uninstall
npx -y github:kairyou/agent-tooling guard usage -a codex --dry-run
npx -y github:kairyou/agent-tooling guard usage -a codex --uninstall
```

The installer copies runtime scripts into `~/.agent-tooling/` and points agent
configs there.

Installed capabilities:

- **Claude** — `statusLine` + the `guard` PreToolUse hook, in `~/.claude/settings.json`.
- **Codex** — the `guard` hook and `usage` hook, in `~/.codex/hooks.json`.
- **opencode** — the `guard`, as a plugin stub dropped into `~/.config/opencode/plugin/`.

The `guard` hook blocks a small deny-list of catastrophic shell commands.
The `usage` hook shows the active API provider's balance, quota, or plan
usage for compatible Sub2API-like, NewAPI/OneAPI/OneHub/DoneHub/Veloera/
AnyRouter-like, and OpenRouter gateways.

Output examples:

```text
# Subscription / plan quota.
warning: [额度] 订阅套餐 | D $0.0/$100 | W $0.0/$300 | Exp 07-08

# Wallet balance.
warning: [额度] 钱包余额 | 余额 $362 | 今日 $61.7 | 近30天 $566
```

After installing Codex hooks, run `/hooks` inside Codex and approve the
agent-tooling hooks. After installing the opencode plugin, restart opencode.

Claude statusLine defaults to:

```text
⎇ main | Opus 4.8 | 5h 7% ⟳2h54m | w 41% ⟳3d1h
```

To choose what appears, edit `statusline.fields` in
`~/.agent-tooling/config.jsonc`.
The installer may add new default keys on update; it preserves top-of-file
comments and existing values.

## Notes

- `skills/` contains reusable `SKILL.md` capabilities.
- `hooks/common/` contains shared guard logic; agent-specific wiring lives under `hooks/<agent>/`.
- `statusline/claude/` contains the command-backed Claude statusLine script.
- The installer marks and removes only the config entries it owns.

Run local checks with `npm test`.
