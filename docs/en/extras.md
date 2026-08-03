# Extras

Fully usable, just situational. Install each on demand.

## at-self-eval

Summarize git history, a work log you provide, or both into a self-evaluation
for performance cycles (quarterly, semi-annual, promotion).

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-self-eval -g -y
```

Usage:

- `/at-self-eval` — the current Git user's work this quarter
- `/at-self-eval [<author>] [--from yyyy-mm-dd] [--to yyyy-mm-dd]` — pick author and range
- Plain language works too: say "summarize the first half of the year" instead of writing flags
- `/at-self-eval summarize July for C:\projects\project-a and C:\projects\project-b` — only those projects
- `/at-self-eval also include C:\projects\project-c` — add to the default scope
- Paste a daily/weekly log, or give a file path, to add business context
- `/at-self-eval summarize from C:\logs\daily-log.md only` — log only, Git is not read

Review the generated result before use.

## at-daily-log

Distill each day's Git commits across projects into a work report; runs when invoked.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-daily-log -g -y
```

Usage:

- `/at-daily-log` — print today's log
- `/at-daily-log 2026-07-31` — pick the date
- `/at-daily-log last week` / `/at-daily-log the last two weeks` — one entry per active day, empty days skipped
- `/at-daily-log summarize today for C:\projects\project-a` — only that project
- `/at-daily-log also include C:\projects\project-c` — add to the default scope
- `/at-daily-log record the log` — record to the configured file; rerunning a day only refreshes the generated part
- `/at-daily-log record it to C:\logs\daily-log.md` — record to that file
- `/at-daily-log record daily at 18:00` — guides you through an OS scheduled task; days without commits are not written

Recorded output example:

```markdown
+ 2026-08-03
<!-- daily-log:2026-08-03:start 5,a1b2c3d -->
  1. project-a: finished the login module refactor with regression coverage.
  2. project-b: fixed the timezone offset in report exports.
<!-- daily-log:2026-08-03:end -->
```

The `<!-- ... -->` comments are boundary markers: an update rewrites only what sits
between them, and everything else in the file (such as your own notes) is left alone.

Paired with the `log` capability below, work that ships no code, such as troubleshooting, also reaches the report.
Review the generated result before use.

## log

Record each day's AI sessions across projects into a work log; runs automatically
once installed.

Independent of and complementary to `at-daily-log` above; use them together or alone.

```bash
npx -y @kairyou/agent-tools@latest log -a claude codex opencode
```

- `format: "daily"` (default): a single markdown file, one dated entry per day, each turn summarized into one line
- `format: "detailed"`: one full report per day with each turn's request and outcome, the files changed, and approximate lines added/removed (measured against the current file when several turns touch one)
- Codex: run `/hooks` once after installing to approve it; opencode: restart after installing or updating

`daily` output example:

```markdown
+ 2026-08-03
<!-- log:2026-08-03:start -->
  1. project-a: traced the login timeout to sessions never renewing.
  2. project-a: fixed the login timeout, added regression tests.
  3. project-b: traced empty report exports to an inverted permission filter.
<!-- log:2026-08-03:end -->
```

One line per turn, written from the AI's own summary at the end of that turn; no
cross-turn consolidation. Updates likewise rewrite only what sits between the markers.

`detailed` output example (excerpt):

```markdown
# AI Log - 2026-08-03

## Overview

- Prompts: 5
- Changed files: 3
- Line changes: +120/-30

## Sessions

- Time: 2026-08-03 10:12:01 -> 2026-08-03 10:20:45
- Project: project-a

Request
(request excerpt)

Outcome
(outcome summary)

Changes
- src/auth/session.ts | diff +42/-8 | 3 ops
```

## Configuration

All in `~/.agent-tools/config.jsonc`:

```jsonc
{
  // log capability: AI session log
  "log": {
    "enabled": true,                // false: pause recording without uninstalling
    "output": "C:\\logs\\ai-log.md",  // daily: one file; detailed: a directory
    "language": "zh",                 // zh | en
    "format": "daily",                // daily | detailed
    "projects": [                     // optional: record only these; entries may override the keys above
      "C:\\projects\\project-a",
      { "path": "C:\\projects\\project-b", "format": "detailed", "output": "C:\\logs\\project-b" }
    ]
  },
  // at-self-eval, at-daily-log: default projects (otherwise just the current repo);
  // prompt: free text that tunes how that project is summarized
  "workProjects": [
    "C:\\projects\\project-a",
    { "path": "C:\\projects\\project-b", "prompt": "refer to `phoenix` as `Shop App` in the output; skip commits starting with `test:`" }
    // "C:\\projects\\temporarily-disabled"
  ],
  // at-daily-log: default file when asked to record; at-self-eval also reads it as fallback
  "dailyLog": {
    "output": "C:\\logs\\daily-log.md"
  }
}
```
