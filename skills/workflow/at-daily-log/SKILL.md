---
name: at-daily-log
description: "Summarize each day's Git activity into a concise daily work log, for a single date or a range. Uses the current repository, optional configured work projects, or paths named in conversation; configuration is never required."
argument-hint: "[<date>|<range>]"
---

# Daily Work Log

`resolve evidence -> group related commits -> draft or record`

## Date and evidence scope

Default to today. Accept plain-language dates or ranges (`2026-07-31`, yesterday, last
week, this month) and normalize to `[from, to]`; query through `<to + 1 day>` because
Git's `--until` boundary is exclusive. State the resolved date or range.

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

Uncommitted changes are not work items. At most, note them factually in a chat draft
for today (project and files, no invented progress); never write them to the file:
their dates are unverifiable, and a project left dirty for weeks would reappear as in
progress every day. User-provided non-code work must remain clearly identified as user
context.

## Output

Match the user's language:

```markdown
+ 2026-07-31
  1. agent-tools: 完成多项目日报规则和 skill 落地.
  2. vscode-plugin: 修复 Webview 刷新后状态丢失问题, 补充回归验证.
```

Start each item with the label that best locates the work for a reader: the project
name when the day spans projects, a module or feature within a single one.

Keep entries compact: the file accumulates for months, so every recurring line must
earn its place. Do not add per-day summary, total, or section-header lines; the
numbered items already show project and count.

Prefer outcomes over raw Git metrics. If no verified activity exists, say so rather
than fabricate an entry. For a range, output one entry per day with activity, oldest
first, and skip empty days.

## Draft or record

"Generate" / `生成日报` returns a draft. "Record" / `记录日报`, or an explicit
write request, writes after previewing the entry. Resolve the destination in order:

1. a path supplied in conversation;
2. optional `dailyLog.output` in `~/.agent-tools/config.jsonc`;
3. no destination: return the draft without writing.

Read the destination before editing. Wrap each date's generated content in that date's
own markers, `<!-- log:2026-07-31:start 5,a1b2c3d -->` / `<!-- log:2026-07-31:end -->`,
where the start marker stores the day's commit count and newest commit hash across the
scanned projects; the date line and every line outside the markers belong to the user.
Refresh an existing block when either value changed or the user explicitly asks;
otherwise leave it alone, because regenerated wording varies between runs. For an existing date, show
the current block and the regenerated one before writing, then replace only that
date's block. If the date exists without markers, append a marked block below the
user's lines instead of editing them. Do not duplicate the date. Insert a new date
among the existing dated entries at its date-order position, inferring ascending or
descending from the dates already present (ascending when that is ambiguous); content
above or below the dated entries, such as notes or todo lists, stays where it is. On duplicate or
unpaired markers, stop and propose the edit instead of writing. When Git shows no
activity, leave the file unchanged and say so; the user can add a manual entry
themselves. Recording a range applies these rules to each day's block independently.

Scheduling is separate; set it up only when the user asks. Prefer the OS scheduler
(Task Scheduler, cron, launchd) over agent-internal timers, which stop with the agent:
schedule a headless run of the CLI this skill is executing in, invoking the skill with
the recording request the user asked for (in Claude Code,
`claude -p "/at-daily-log record the log"`; other CLIs have their own headless form).
Keep projects and output in config so the command stays stable. Before registering,
confirm the schedule, make sure the output file is resolvable, and run the exact
command once; register only after that test run records correctly, and show how to
remove the task. Headless auth
differs from the interactive session, so a failed test run means stop instead of
registering, and show the exact command, its error output, and the likely fix (log in
for headless use, adjust the output path). An unattended run has nobody to confirm
with, so it must follow the marker rules exactly and skip any file it cannot edit that
way: it fills missing days and refreshes days whose stored count or hash moved,
nothing else.
