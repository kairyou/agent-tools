# Agent Tools

Reusable skills and runtime integrations for Codex, Claude Code, and opencode. This repository keeps each capability in predictable locations so projects can opt into only what they need.

[中文](README.zh-CN.md)

## Directory Layout

```text
agent-tools/
├── .claude-plugin/    # Claude Code/plugin ecosystem manifest.
├── .codex-plugin/     # Codex plugin manifest.
├── hooks/             # Shared and agent-specific hook integrations.
├── plugins/           # Runtime plugins loaded by supported agents.
├── scripts/           # Install, sync, validation, and maintenance scripts.
├── skills/            # Reusable Agent Skills for CLI discovery and plugin manifests.
│   ├── workflow/      # Workflow-oriented skills.
│   │   ├── at-commit/   # Conventional Commit message skill.
│   │   ├── at-review/   # Review changes for bugs and regressions.
│   │   └── at-simplify/ # Reduce complexity and duplication in changes.
│   └── integrations/  # Skills that integrate external systems.
│       └── zentao/      # ZenTao bug/task fixing workflow.
├── statusline/        # Statusline scripts/templates, grouped by agent.
│   └── claude/        # Claude command-backed statusLine script + example config.
└── lib/               # Shared implementation used by hooks, statuslines, and installers.
```

## Current Skills

### at-commit

Generate a Conventional Commits message from staged changes and wait for user confirmation before committing.

- Usage: `/at-commit [<language>]` — language for the commit description (Conventional Commits tokens stay in English)

### at-review

Review changes for correctness bugs, regressions, convention violations, and high-value cleanup findings.

- Usage: `/at-review [--fix] [<pr|branch|path>]` — reports findings; `--fix` also applies them

### at-simplify

Refactor changes to reduce duplication, lower complexity, and improve code quality.

- Usage: `/at-simplify [<pr|branch|path>]`

### zentao

Work ZenTao (禅道) bugs/tasks end to end: fix, verify, stage; asks before committing and before writing status back.

Usage:

- `/zentao bugs` — list bugs assigned to you (the configured account); pick one or several (several = batch mode)
- `/zentao tasks` — same, for tasks
- `/zentao bug <id>` — work a specific bug
- `/zentao task <id>` — work a specific task

Config: `~/.agent-tools/config.jsonc` → `"zentao": { "url", "account", "password" }`. First run guides you; fill `password` in the file yourself (or env `ZENTAO_PASSWORD`), never in chat.

## Usage

List available skills:

```bash
npx -y skills@latest add kairyou/agent-tools --list
```

Install skills globally:

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-commit -g -y
npx -y skills@latest add kairyou/agent-tools --skill at-review -g -y
npx -y skills@latest add kairyou/agent-tools --skill at-simplify -g -y
npx -y skills@latest add kairyou/agent-tools --skill zentao -g -y
```

Pass multiple skills after `--skill`, for example `--skill at-commit at-review at-simplify`.

## Runtime integrations

### Claude Code

#### Statusline

```bash
# Install or update
npx -y @kairyou/agent-tools@latest statusline -a claude

# Preview or uninstall
npx -y @kairyou/agent-tools@latest statusline -a claude --dry-run
npx -y @kairyou/agent-tools@latest statusline -a claude --uninstall
```

The installer writes `statusLine` to `~/.claude/settings.json`. The default
output is:

```text
⎇ main | Opus 4.8 | 5h 7% ⟳2h54m | w 41% ⟳3d1h
```

Here `5h` and `w` are Claude's rolling usage windows; `⟳` is the reset countdown.
When a compatible API relay is active, the statusline also appends provider usage.

To choose what appears, edit `statusline.fields` in
`~/.agent-tools/config.jsonc`. The installer may add new default keys on update;
it preserves top-of-file comments and existing values.

### Codex

#### Provider usage hook

```bash
# Install or update
npx -y @kairyou/agent-tools@latest usage -a codex

# Preview or uninstall
npx -y @kairyou/agent-tools@latest usage -a codex --dry-run
npx -y @kairyou/agent-tools@latest usage -a codex --uninstall
```

The installer adds the hook to `UserPromptSubmit` and `Stop` in
`~/.codex/hooks.json`. After installation, run `/hooks` inside Codex and approve
the agent-tools usage hooks.

Output examples:

```text
# Subscription / plan quota.
warning: API | D $0.0/$100 | W $0.0/$300 | Exp 07-08

# Wallet balance.
warning: API | balance $362 | today $61.7 | 30d $566
```

Fields: `D/W/M` are daily/weekly/monthly spend against plan limits; `Exp` is
the plan expiry; `balance` is wallet credit; `today` and `30d` are API spend.

### OpenCode

#### Provider usage plugin

```bash
# Install or update
npx -y @kairyou/agent-tools@latest usage -a opencode

# Preview or uninstall
npx -y @kairyou/agent-tools@latest usage -a opencode --dry-run
npx -y @kairyou/agent-tools@latest usage -a opencode --uninstall
```

The installer adds global server and TUI plugins. After the active session
becomes idle, the server plugin refreshes usage and shows it as a toast. The TUI
plugin also registers `/at-usage` for the latest cached value. Restart opencode
after installing or updating the plugins.

Toast example:

```text
Provider usage
balance $244 | today $45.8 | 30d $604
```

### Supported gateways

Balance, quota, and plan usage queries support compatible Sub2API-like,
NewAPI/OneAPI/OneHub/DoneHub/Veloera/AnyRouter-like, and OpenRouter gateways.

### Run from Git

To run directly from the repository, replace the npm package name with
`github:kairyou/agent-tools` (Git required):

```bash
npx -y github:kairyou/agent-tools usage -a codex
```

## FAQ

### Why does global installation fail for PromptScript?

`PromptScript does not support global skill installation` means that the
PromptScript agent does not support global installation. It does not affect
other agents and can be ignored. See [`skills` issue #1352](https://github.com/vercel-labs/skills/issues/1352).

## References

- [OpenCommit](https://github.com/di-sukharev/opencommit)
- [GitLens](https://github.com/gitkraken/vscode-gitlens)
- [claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts)

## Notes

- The installer marks and removes only the config entries it owns.
- Run local checks with `npm test`.
