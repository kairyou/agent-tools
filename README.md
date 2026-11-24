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

Use `/at-commit [<language>]` to set the language of the text after the colon in the commit title.

### at-review

Review local changes or a hosted PR/MR for bugs, regressions, and convention violations.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-review -g -y
```

`/at-review [--fix] [<pr-or-mr-url|branch|path>]`. Private PRs and MRs require read access. `--fix` applies to the matching working tree only.

### at-simplify

Simplify changed code to reduce redundancy and complexity.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-simplify -g -y
```

`/at-simplify [<pr|branch|path>]`

### at-zentao

Handle ZenTao bugs, tasks, and time logs. Review linked stories. Confirm before committing or writing back.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-zentao -g -y
```

- `/at-zentao bugs` / `/at-zentao tasks` — list assigned items and select one or more.
- `/at-zentao bug <id> [request]` — work a bug or add a request such as `only analyze the cause`.
- `/at-zentao task <id> [request]` — start, pause, resume, or log hours in natural language.
- `/at-zentao story <id>` — read requirements and acceptance criteria.

Configure `~/.agent-tools/config.jsonc`:

```jsonc
{
  "zentao": {
    "url": "https://zentao.example.com",
    "account": "user",
    "password": "your-password",
    // "password": { "env": "ZENTAO_PASSWORD" }, // Or read the password from an environment variable.
    // "commentPrompt": "For fixed bugs, write in English:\nCause: ...\nFix: ...\nImpact: ...\nCommit: <actual hash>\nOmit Impact when there is nothing substantive to add."
  }
}
```

## Capabilities

Runtime capabilities, installed per agent:

```bash
npx -y @kairyou/agent-tools@latest <capability> -a <agent...>
# npx -y github:kairyou/agent-tools <capability> -a <agent...>  # Or the latest code from GitHub (needs Git)
```

| Feature | Install | Agent (`-a`) |
| --- | :---: | --- |
| Claude Code CLI status line | `statusline` | `claude` |
| Gateway usage | `usage` | `claude`, `codex`, `opencode`, `pi`, `zcode`, `dsh` (DeepSeek Harness), `paseo`, `copilot`, `qwen` |
| Cross-model image understanding | `vision` | `claude`, `codex`, `opencode`, `pi`, `zcode`, `dsh` |
| Session work logs | `log` | `claude`, `codex`, `opencode`, `pi`, `zcode`, `dsh` |

### Status and usage

#### Claude Code

| Interface | Install command |
| --- | --- |
| CLI status line (includes gateway usage) | `npx -y @kairyou/agent-tools@latest statusline -a claude` |
| Claude Desktop (local Code session) | `npx -y @kairyou/agent-tools@latest usage -a claude` |
| Both | `npx -y @kairyou/agent-tools@latest statusline usage -a claude` |

In a new Desktop session, click usage above the input box (bundled Claude Code 2.1.286+).

CLI setup writes `statusLine` to `~/.claude/settings.json`.

```text
# Claude subscription:
⎇ main | Opus 4.8 | 5h 7% ⟳ 2h54m | w 41% ⟳ 3d1h

# API relay:
⎇ main | Opus 4.8 | balance $362 | today $61.7 | 30d $566
```

`5h` and `w` show rolling 5-hour and 7-day usage. `⟳` shows the reset countdown.

In `~/.agent-tools/config.jsonc`, use `statusline.fields` to order CLI fields and
`statusline.showProviderUsage: false` to hide gateway usage.

For estimated output speed (`tok/s`), add `"outputSpeed"` to `statusline.fields` (CLI)
or set `providerUsage.outputSpeed` to `true` (Desktop).

#### Provider usage

View gateway balance and usage in your agent. These settings also apply to Claude.
Built-in routes include Sub2API, One API (including OneHub and DoneHub), New API,
Claude Code Hub, OpenRouter, and Command Code. Compatibility depends on the
gateway version and enabled usage endpoints.

```bash
npx -y @kairyou/agent-tools@latest usage -a codex
```

- **Codex CLI** — 0.171.0+ uses the footer when compatible. Approve usage notices in `/hooks` if prompted. Query anytime with `$at-usage`.
- **ChatGPT desktop app** — In a local Codex conversation, choose **+ → More tools → Agent Tools usage** in the right panel. If `web-sandbox.oaiusercontent.com` is blocked, check gateway usage with `$at-usage`.
- **OpenCode** — shows a toast when the session goes idle, or on demand with `/at-usage`.
- **Pi** — displays usage in the footer.
- **ZCode** — the desktop footer shows gateway usage and optional `tok/s`.
- **DeepSeek Harness** — shows gateway usage in the footer or on demand with `/at-usage`.
- **Paseo** — enable plugins, then start or reload a Claude or Codex session. Click the usage above the input box for details.
- **Copilot CLI** — adds gateway usage and optional `tok/s` alongside its built-in footer items.
- **Qwen Code** — shows gateway usage for models with a unique display name in user settings. The footer can also show `tok/s`.

Restart your agent after installing or updating. In Pi, you can use `/reload`.

The endpoint and key come from the agent's current model or existing configuration.
Direct connections to OpenAI or Anthropic skip gateway queries. If a query returns
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

##### Custom gateway routes

Gateways not covered by the built-in probes can use a custom route. See
[Custom gateway routes](docs/en/custom-gateway-routes.md).

### Vision (cross-model image understanding)

Use a multimodal model to read screenshots and design mockups.

#### Install

```bash
npx -y @kairyou/agent-tools@latest vision -a claude
```

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

Pass an image path or URL in your message. To test image recognition directly, use the CLI.

```bash
npx -y @kairyou/agent-tools@latest inspect-image <path|url> -q "What are the navbar background color and height?"
```

## More tools and documentation

- [Work utilities](docs/en/extras.md) — Work reports, session logs, and self-evaluations.
- [Output speed](docs/en/output-speed.md)
- [Repository structure](docs/en/repository-structure.md)

## FAQ

### Why does installing skills report PromptScript as unsupported?

`PromptScript does not support global skill installation` applies only to
PromptScript; installation for other agents is unaffected. See [`skills` issue #1352](https://github.com/vercel-labs/skills/issues/1352).

### How do I install skills without GitHub access?

In Bash, install from the npm package (swap `at-commit` for the skills you want):

```bash
cd "$(mktemp -d)" && tar -xf "$(npm pack @kairyou/agent-tools --silent)" && npx -y skills@latest add ./package --skill at-commit -g -y
```

## Acknowledgements

- `at-commit` draws on commit-message generation ideas from
  [OpenCommit](https://github.com/di-sukharev/opencommit) and
  [GitLens](https://github.com/gitkraken/vscode-gitlens), reimplemented for an
  Agent Skill workflow.
- `at-review` and `at-simplify` are installable Agent Skills derived and
  adapted from Claude Code's built-in `code-review` and `simplify` workflow
  prompts.
  The [sync workflow](tools/claude-skill-sync/README.md) describes how upstream prompts are tracked.
