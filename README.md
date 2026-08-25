# Agent Tools

Reusable Agent Skills, plus runtime capabilities (statusline, provider usage, vision) for Codex, Claude Code, and opencode.

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
    // Configure commentPrompt to customize bug/task comment formatting.
    // "commentPrompt": "Use exactly this multiline format and field order:\nRoot cause: ...\nFix: ...\nBranch: ...\nVerification: ... (omit when not performed)\nCommit: ..."
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
re-running the install command updates. The installer only touches config
entries it wrote itself, and `config.jsonc` updates only add missing default
keys without touching your edits or comments.

| Capability | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| `statusline` | ✓ | – | – |
| `usage` | `/at-usage` skill | hook + `$at-usage` skill | toast + `/at-usage` command |
| `vision` | ✓ | ✓ | ✓ |

### Statusline

```bash
npx -y @kairyou/agent-tools@latest statusline -a claude
```

The installer writes `statusLine` to `~/.claude/settings.json`. Example output:

```text
# Pick and order the fields via statusline.fields in ~/.agent-tools/config.jsonc:
⎇ main | Opus 4.8 | 5h 7% ⟳2h54m | w 41% ⟳3d1h

# With a compatible API relay, quota info is shown too:
⎇ main | Opus 4.8 | balance $362 | today $61.7 | 30d $566

```

Here `5h` and `w` are Claude's rolling usage windows and `⟳` is the reset
countdown; see [Provider usage](#provider-usage) below for relay quota
compatibility and configuration.

### Provider usage

Shows API relay / gateway balance and quota inside the agent. Supports Sub2API,
One API (including OneHub and DoneHub), New API, Claude Code Hub, OpenRouter, and
Command Code; compatibility depends on the gateway version and enabled usage
endpoints.

```bash
npx -y @kairyou/agent-tools@latest usage -a claude codex opencode
```

- **Claude Code** — invoke `/at-usage` to show the current usage.
- **Codex** — run `/hooks` once after installation to approve it. The Codex CLI
  displays usage automatically; clients that hide hook output can use `$at-usage`.
- **OpenCode** — usage refreshes when the session goes idle and appears as a
  toast; `/at-usage` shows it on demand. Restart opencode after installing or updating.

The relay endpoint is auto-discovered from the existing Codex and Claude Code
configuration; official (non-relay) endpoints are skipped. If it reports
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
    "debug": false    // true: log probes to ~/.agent-tools/logs/usage-debug.log
  }
}
```

Keep `preset` set to `auto` for automatic detection. Select a specific protocol
only when you know which usage endpoint the gateway exposes; a configured custom
route id is also accepted. Command Code usage relies on a version-sensitive
endpoint that is not part of its documented Provider API.

Output examples:

```text
# Plan limits (sub2api / openai-compatible).
D $0.0/$100 | W $0.0/$300 ⟳3d1h | Exp 07-08

# Multi-window limits (claude-code-hub).
5h $2.1/$10.0 | D $8.0/$20.0 | T $19.0/$100 | Exp 08-31

# Balance and usage (one-api / one-hub / done-hub / new-api / openrouter).
balance $15.0 | used $5.0/$20.0 | ⟳3d1h

# Wallet and recent spend (sub2api).
balance $362 | today $61.7 | 30d $566
```

Fields: `5h/D/W/M/T` are five-hour/daily/weekly/monthly/total spend against
limits; `⟳` is the time until a known limit reset; `Exp` is the plan expiry;
`balance` is wallet credit; `used` is consumed credit; `today` and `30d` are
today's and the last 30 days' API spend. A reset countdown is shown only when
the gateway returns enough timing information to determine it reliably.

#### Custom gateway routes

Gateways not covered by the built-in probes can use a custom route. See
[Custom gateway routes](docs/en/custom-gateway-routes.md).

### Vision (cross-model image understanding)

Lets a main model that cannot see images use a multimodal model to analyze error screenshots, implement UI from design mockups, and inspect bug-report screenshots.

#### Install

```bash
npx -y @kairyou/agent-tools@latest vision -a claude codex opencode
```

Uninstalling keeps your vision provider config by default.

#### Configure

`~/.agent-tools/config.jsonc` is the only config entry point:

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

`apiKey` can be a key string such as `"apiKey": "sk-..."`, or an environment variable reference such as `{ "env": "OPENAI_API_KEY" }`. Omit it if your gateway requires no key. Prefer an environment variable to avoid storing the key in the config file.

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

`PromptScript does not support global skill installation` means that the
PromptScript agent does not support global installation. It does not affect
other agents and can be ignored. See [`skills` issue #1352](https://github.com/vercel-labs/skills/issues/1352).

### How do I install skills without GitHub access?

Install from the npm package instead (swap `at-commit` for the skills you want):

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
  Automated upstream tracking uses versioned prompt data from
  [tweakcc](https://github.com/Piebald-AI/tweakcc); human-readable prompt
  history comes from
  [claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts).
