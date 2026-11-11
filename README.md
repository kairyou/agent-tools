# Agent Tools

Reusable Agent Skills for compatible coding agents, plus per-agent runtime capabilities for statusline, provider usage, vision, and session logging.

Requires Node.js >= 22.

[中文](README.zh-CN.md)

## Skills

### Install

```bash
# List available skills
npx -y skills@latest add kairyou/agent-tools --list

# Install globally (pass one or more names after --skill)
npx -y skills@latest add kairyou/agent-tools --skill <name...> -g -y
```

The Skills installer automatically detects and installs to the Skill directories
of most supported agents.

### at-commit

Generate a Conventional Commits message from staged changes and wait for user confirmation before committing.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-commit -g -y
```

Usage:

- `/at-commit [<language>]` — language for the commit description (Conventional Commits tokens stay in English)

### at-review

Review local changes or a hosted PR/MR for correctness bugs, regressions, convention violations, and high-value cleanup findings.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-review -g -y
```

Usage:

- `/at-review [--fix] [<pr-or-mr-url|branch|path>]` — reports review findings; private hosted targets require locally available read access, and `--fix` applies fixes only to a matching working tree

### at-simplify

Refactor changes to reduce duplication, lower complexity, and improve code quality.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-simplify -g -y
```

Usage:

- `/at-simplify [<pr|branch|path>]`

### at-zentao

Work ZenTao (禅道) bugs/tasks end to end, manage task status and hours, or read linked story context; asks before committing and before writing back.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-zentao -g -y
```

Usage:

- `/at-zentao bugs` — list bugs assigned to you (the configured account); pick one or several (several = batch mode)
- `/at-zentao tasks` — same, for tasks
- `/at-zentao bug <id>` — work a specific bug
- `/at-zentao task <id> [request]` — work a task, start/pause/resume it, or log hours with a natural-language request
- `/at-zentao story <id>` — read requirement scope and acceptance context without writing back

Configure `~/.agent-tools/config.jsonc`:

```jsonc
{
  "zentao": {
    "url": "https://zentao.example.com",
    "account": "user",
    "password": "your-password",
    // "password": { "env": "ZENTAO_PASSWORD" }, // Or read the password from an environment variable.
    // Optional. Without this, labels follow the item or user's language.
    // "commentPrompt": "For fixed Bugs, write in English using this format:\nCause: ...\nFix: ...\nScope: ...\nTest suggestions: ...\nCommit: <hash>\nKeep each field brief. Omit Scope and Test suggestions when there is nothing useful to add. Use a real commit hash."
  }
}
```

## Capabilities

Runtime capabilities, installed per agent:

```bash
npx -y @kairyou/agent-tools@latest <capability> -a <agent...>
# npx -y github:kairyou/agent-tools <capability> -a <agent...>  # Or the latest code from GitHub (needs Git)
```

`--dry-run` previews, `--uninstall` removes the capability from the agent, and
re-running the install command updates. Updates to `config.jsonc` add missing
defaults while preserving your values and comments.

| Runtime capability | Supported agents |
| --- | --- |
| `statusline` | Claude Code |
| `usage` | Claude Code, Codex, OpenCode, Pi |
| `vision` | Claude Code, Codex, OpenCode, Pi, ZCode, DeepSeek Harness |
| `log` | Claude Code, Codex, OpenCode, Pi |

### Statusline

```bash
npx -y @kairyou/agent-tools@latest statusline -a claude
```

The installer writes `statusLine` to `~/.claude/settings.json`. Example output:

```text
# Claude subscription:
⎇ main | Opus 4.8 | 5h 7% ⟳ 2h54m | w 41% ⟳ 3d1h

# API relay:
⎇ main | Opus 4.8 | balance $362 | today $61.7 | 30d $566
```

`5h` / `w`: Claude's rolling 5-hour / 7-day usage windows; `⟳`: time until reset.

Set visible fields and order via `statusline.fields` in `~/.agent-tools/config.jsonc`;
add `"outputSpeed"` for estimated output speed (e.g. `38.2 tok/s`).

For supported relay gateways and usage configuration, see [Provider usage](#provider-usage).

### Provider usage

Shows API relay / gateway balance and quota inside the agent. Supports Sub2API,
One API (including OneHub and DoneHub), New API, Claude Code Hub, OpenRouter, and
Command Code; compatibility depends on the gateway version and enabled usage
endpoints.

```bash
npx -y @kairyou/agent-tools@latest usage -a claude codex opencode pi
```

- **Claude Code** — `/at-usage` shows usage in chat; installing `statusline` also adds it to the status line.
  Set `statusline.showProviderUsage` to `false` to hide relay gateway usage from the status line.
- **Codex** — run `/hooks` once after installation to approve it. The Codex CLI
  displays usage automatically; clients that hide hook output can use `$at-usage`.
- **OpenCode** — usage refreshes when the session goes idle and appears as a
  toast; `/at-usage` shows it on demand. Restart opencode after installing or updating.
- **Pi** — displays usage in the footer. Restart Pi or run `/reload` after installing or updating.

The endpoint and key come from the agent's current model or existing configuration;
official endpoints are skipped. If it reports
`Provider usage is unavailable.`, set `PROVIDER_USAGE_BASE_URL` and
`PROVIDER_USAGE_API_KEY` to override the endpoint and key. Configure
`providerUsage` in `~/.agent-tools/config.jsonc` only when needed:

```jsonc
{
  "providerUsage": {
    // auto | sub2api | openai-compatible | one-api | one-hub |
    // done-hub | new-api | claude-code-hub | openrouter | commandcode | <custom-route-id>
    "preset": "auto", // auto-detect, or select one protocol listed above
    "days": 30,       // how many recent days of spend to count
    "outputSpeed": false, // true: show estimated output speed (tok/s)
    "debug": false    // true: log probes to ~/.agent-tools/logs/usage-debug.log
  }
}
```

Speed includes wait time (and tool time in Codex) and is hidden until timing data is available.

Command Code uses an undocumented usage endpoint that may change between versions.

Output examples:

```text
# Plan limits:
D $0.0/$100 | W $0.0/$300 ⟳ 3d1h | Exp 07-08

# Multi-window limits:
5h $2.1/$10.0 | D $8.0/$20.0 | T $19.0/$100 | Exp 08-31

# Balance and usage:
balance $15.0 | used $5.0/$20.0 | ⟳ 3d1h

# Wallet and recent spend:
balance $362 | today $61.7 | 30d $566
```

Fields: `5h/D/W/M/T` are five-hour/daily/weekly/monthly/total spend against
limits; `⟳` is the time until a known limit reset; `Exp` is the plan expiry;
`balance` is wallet credit; `used` is consumed credit; `today` and `30d` are
today's and the last 30 days' API spend. Reset countdowns require gateway timing data.

#### Custom gateway routes

Gateways not covered by the built-in probes can use a custom route. See
[Custom gateway routes](docs/en/custom-gateway-routes.md).

### Vision (cross-model image understanding)

Lets a main model that cannot see images use a multimodal model to analyze error screenshots, implement UI from design mockups, and inspect bug-report screenshots.

#### Install

```bash
npx -y @kairyou/agent-tools@latest vision -a claude codex opencode pi zcode dsh
```

Uninstalling keeps your vision provider config by default.

#### Configure

Configure `vision` in `~/.agent-tools/config.jsonc`:

```jsonc
{
  "vision": {
    "provider": "openai-compatible",       // or "anthropic-compatible"
    "baseUrl": "https://gateway.example.com/v1",  // anthropic-compatible: gateway root, /v1/messages is appended
    "model": "internal-vlm",
    "apiKey": { "env": "OPENAI_API_KEY" }  // read from the OPENAI_API_KEY environment variable
    // , "timeoutMs": 30000, "maxImageBytes": 20971520, "maxOutputTokens": 8192
    // , "maxConcurrentRequests": 2, "maxRequestsPerMinute": 30
  }
}
```

`apiKey` accepts a key string or an environment variable reference as above. Omit it for gateways that require no key.

#### Use

Pass a local image path or URL in your message. If the main model cannot accept
pasted images, save the image first and pass its file path instead.

To diagnose the provider setup or test recognition quality manually:

```bash
npx -y @kairyou/agent-tools@latest inspect-image <path|url> -q "What are the navbar background color and height?"
```

## Extras

See [extras](docs/en/extras.md) for optional tools outside the day-to-day development workflow.

## FAQ

### Why does installing skills report PromptScript as unsupported?

`PromptScript does not support global skill installation` applies only to
PromptScript; installation for other agents is unaffected. See [`skills` issue #1352](https://github.com/vercel-labs/skills/issues/1352).

### How do I install skills without GitHub access?

In Bash, install from the npm package (swap `at-commit` for the skills you want):

```bash
cd "$(mktemp -d)" && tar -xf "$(npm pack @kairyou/agent-tools --silent)" && npx -y skills@latest add ./package --skill at-commit -g -y
```

### Want to contribute?

See the [repository structure](docs/en/repository-structure.md).

## Acknowledgements

- `at-commit` draws on commit-message generation ideas from
  [OpenCommit](https://github.com/di-sukharev/opencommit) and
  [GitLens](https://github.com/gitkraken/vscode-gitlens), reimplemented for an
  Agent Skill workflow.
- `at-review` and `at-simplify` are installable Agent Skills derived and
  adapted from Claude Code's built-in `code-review` and `simplify` workflow
  prompts.

For upstream skill updates, review the generated draft PR; see the [sync workflow](tools/claude-skill-sync/README.md).
