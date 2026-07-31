---
name: at-daily-log
description: "Summarize one day's Git activity into a concise daily work log. Uses the current repository, optional configured work projects, or paths named in conversation; configuration is never required."
argument-hint: "[<date>]"
---

# Daily Work Log

`resolve evidence -> group related commits -> draft or record`

## Date and evidence scope

Default to today. Accept plain-language dates or `YYYY-MM-DD`; query through the next
day because Git's `--until` boundary is exclusive. State the resolved date.

Read optional `workProjects` from `~/.agent-tools/config.jsonc`.

- No project named: current Git repository plus configured projects.
- Projects named directly: only those projects.
- "Also include" / `另外包含`: add them to the default scope.

Resolve paths to Git roots and deduplicate them. Report invalid paths; a non-Git current
directory does not block other valid projects. Do not clone remote URLs without consent.

For each repository, resolve the author with `git -C <root> config user.name`; never
infer aliases or use the remote login as the author. Filter commits by comparing `%an`
literally, not via an `--author` regex. Inspect all local branches, current
HEAD, user-named branches, and configured upstreams. Unless the user requests local-only
data, refresh only the configured upstream branches, grouped into one best-effort
`git fetch --no-tags <remote> <branch...>` per involved remote. Fetch failure is
non-fatal. Do not change the working tree or local branch history. Deduplicate commits
by hash.

## Build work items

Collect non-merge commits for the resolved author and day. Use subjects and changed
paths to turn related commits into concrete completed work items. Fold formatting,
version bumps, and follow-up fixes into the outcome they supported; do not inflate one
change into several deliverables.

Use file counts and added/deleted lines only when they meaningfully support the work
item. Generated files, lockfile churn, renames, and bulk formatting often make those
numbers misleading. Metrics are evidence, never hours, difficulty, impact, or a
productivity score.

Current uncommitted changes may be shown separately as **in progress**, but never as
proof of work on a past date. User-provided non-code work must remain clearly identified
as user context.

## Output

Match the user's language and omit empty sections:

```markdown
+ 2026-07-31
  完成 2 项:
  1. agent-tools: 完成多项目日报规则和 skill 落地.
  2. vscode-plugin: 修复 Webview 刷新后状态丢失问题, 补充回归验证.

  进行中 1 项:
  - iunit-web: 推进导入流程重构, 已完成数据解析.

  汇总: 3 个项目, 2 项完成, 1 项进行中.
```

Prefer outcomes over raw Git metrics. If no verified activity exists, say so rather
than fabricate an entry.

## Draft or record

"Generate" / `生成日报` returns a draft. "Record" / `记录日报`, or an explicit
write request, writes after previewing the entry. Resolve the destination in order:

1. a path supplied in conversation;
2. optional `dailyLog.output` in `~/.agent-tools/config.jsonc`;
3. no destination: return the draft without writing.

Read the destination before editing. Wrap each date's generated content in that date's
own markers, `<!-- log:2026-07-31:start -->` / `<!-- log:2026-07-31:end -->`; the date
line and every line outside the markers belong to the user. For an existing date, show
the current block and the regenerated one before writing, then replace only that
date's block. If the date exists without markers, append a marked block below the
user's lines instead of editing them. Do not duplicate the date. On duplicate or
unpaired markers, stop and propose the edit instead of writing. When Git shows no
activity, leave the file unchanged and say so; the user can add a manual entry
themselves.

Scheduling is separate; set it up only when the user asks. Prefer the OS scheduler
(Task Scheduler, cron, launchd) over agent-internal timers, which stop with the agent:
schedule a headless run of the CLI this skill is executing in, invoking the skill with
a recording request (in Claude Code, `claude -p "/at-daily-log record the log"`; other
CLIs have their own headless form). Keep projects and output in config so the command
stays stable. Before registering, confirm the schedule (suggest workdays),
make sure the output file is resolvable, and run the exact command once; register only
after that test run records correctly, and show how to remove the task. Headless auth
differs from the interactive session, so a failed test run means stop instead of
registering, and show the exact command, its error output, and the likely fix (log in
for headless use, adjust the output path). An unattended run has nobody to confirm with, so it must follow the
marker rules exactly and skip any file it cannot edit that way.
