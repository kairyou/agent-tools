# Agent Tools

Reusable skills, hooks, statusline tools, and installers for Codex, Claude Code, and opencode. This repository keeps each capability in predictable locations so projects can opt into only what they need.

[中文](README.zh-CN.md)

## Directory Layout

```text
agent-tools/
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
├── statusline/        # Statusline scripts/templates, grouped by agent.
│   └── claude/        # Claude command-backed statusLine script + example config.
└── lib/               # Shared implementation used by hooks, statuslines, and installers.
```

## Current Skills

- `commit`: Generate a Conventional Commits message from staged changes and wait for user confirmation before committing.

## Usage

List available skills:

```bash
npx -y skills@latest add kairyou/agent-tools --list
```

Install skills globally:

```bash
npx -y skills@latest add kairyou/agent-tools --skill commit -g -y
```

Project-level install:

```bash
# Prefer --copy when installed files may be committed to Git.
npx -y skills@latest add kairyou/agent-tools --skill commit --copy -y
```

Pass multiple skills after `--skill`, for example `--skill commit other-skill`.

## Installing hooks & statusline

Install hooks and statusline with the repo installer:

```bash
# Claude: statusLine + guard
npx -y github:kairyou/agent-tools statusline guard -a claude

# Codex: guard + API usage
npx -y github:kairyou/agent-tools guard usage -a codex

# opencode: guard plugin
npx -y github:kairyou/agent-tools guard -a opencode

# Multiple agents
npx -y github:kairyou/agent-tools guard -a claude codex opencode

# Preview or uninstall
npx -y github:kairyou/agent-tools guard usage -a codex --dry-run
npx -y github:kairyou/agent-tools guard usage -a codex --uninstall
```

The installer copies runtime scripts into `~/.agent-tools/` and points agent
configs there.

Installed capabilities:

- **Claude** — `statusLine` + the `guard` PreToolUse hook, in `~/.claude/settings.json`.
- **Codex** — the `guard` hook and `usage` hook, in `~/.codex/hooks.json`.
- **opencode** — the `guard`, as a plugin stub dropped into `~/.config/opencode/plugin/`.

The `guard` hook blocks a small deny-list of catastrophic shell commands.
The `usage` runtime shows the active API provider's balance, quota, or plan
usage for compatible Sub2API-like, NewAPI/OneAPI/OneHub/DoneHub/Veloera/
AnyRouter-like, and OpenRouter gateways. Codex displays it through a hook;
Claude statusLine appends it automatically when a compatible relay is active.

Output examples:

```text
# Subscription / plan quota.
warning: API | D $0.0/$100 | W $0.0/$300 | Exp 07-08

# Wallet balance.
warning: API | balance $362 | today $61.7 | 30d $566
```

Fields: `D/W/M` are daily/weekly/monthly spend against plan limits; `Exp` is
the plan expiry; `balance` is wallet credit; `today` and `30d` are API spend.

After installing Codex hooks, run `/hooks` inside Codex and approve the
agent-tools hooks. After installing the opencode plugin, restart opencode.

Claude statusLine defaults to:

```text
⎇ main | Opus 4.8 | 5h 7% ⟳2h54m | w 41% ⟳3d1h
```

Here `5h` and `w` are Claude's rolling usage windows; `⟳` is the reset countdown.

To choose what appears, edit `statusline.fields` in
`~/.agent-tools/config.jsonc`.
The installer may add new default keys on update; it preserves top-of-file
comments and existing values.

## Notes

- `skills/` contains reusable `SKILL.md` capabilities.
- `hooks/common/` contains shared guard logic; agent-specific wiring lives under `hooks/<agent>/`.
- `statusline/claude/` contains the command-backed Claude statusLine script.
- `lib/` contains shared implementation such as API usage query logic.
- The installer marks and removes only the config entries it owns.

Run local checks with `npm test`.
