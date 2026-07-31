---
name: at-self-eval
description: "Summarize a contributor's Git history, a provided work log, or both into a concise, review-friendly self-evaluation for quarterly, semi-annual, or promotion cycles."
argument-hint: "[<author>] [--from yyyy-mm-dd] [--to yyyy-mm-dd]"
---

# Self-Evaluation Summary

`resolve evidence -> group by business line -> deduplicate -> <=8 outcomes -> review`

## Author and date window

Normalize flags or plain language such as `统计1-3月的产出` and `统计上半年的工作`
into `(author, from, to)`. Explicit input wins; fill only missing values:

| User gave | Resolve to |
| --- | --- |
| `from` and `to` | use both |
| only `from` | `to` = today |
| only `to` | `from` = Jan 1 of that year |
| no range | current quarter |

Parse half-years, calendar quarters, month ranges, and rolling periods. A spoken
period without a year means the current year, except months still ahead of today,
which mean the previous year. Query through `<to + 1 day>` because Git's `--until` is exclusive.
Always exclude merge commits.

Use an explicit author when supplied; otherwise resolve it independently per repository
with `git -C <root> config user.name`. Never infer aliases or use the remote login as
the author. Filter commits by comparing `%an` literally, not via an `--author` regex. If no commits match, report that and suggest listing known commit authors;
do not try spelling or language variants. When results exist, mention once that the
user can provide other author names if needed.

## Project evidence

Read optional `workProjects` from `~/.agent-tools/config.jsonc`. An entry is a path
or `{ "path", "rules" }`, where the rules are free text this skill follows for that
project, such as how to label items or which commits to skip.

- No project named: current Git repository plus configured projects.
- Projects named directly: only those projects.
- "Also include" / `另外包含`: add them to the default scope.

Resolve paths to Git roots and deduplicate them. Report invalid paths; a non-Git current
directory does not block other valid projects. Do not clone remote URLs without consent.

Inspect all local branches, current HEAD, user-named branches, and configured upstreams.
Unless the user requests local-only data, refresh only the configured upstream
branches, grouped into one best-effort `git fetch --no-tags <remote> <branch...>` per
involved remote. Fetch failure is non-fatal. Do not change the working tree or local
branch history. Deduplicate commits by hash.

Begin the result with the resolved author/window and, for multiple repositories, a
plain-language list of the repositories checked. Mention remote-update failures without
Git jargon. Do not show commit counts or a generic source line.

## Optional logs

A pasted daily/weekly log or explicit file path provides business context. If neither is
supplied, optionally read `dailyLog.output` from config. Explicit conversation input
always wins; a missing log is non-fatal.

Commit-backed items may be summarized directly. Keep log-only work separate for user
confirmation; include it only after confirmation, using only dates stated in the log or
by the user. Never turn undated log text into work inside the selected window.

When the user asks for a summary from a log alone, skip project scanning; when the
window has no Git evidence, fall back to the log. Either way the log becomes the
primary source: say so in the result and skip per-item confirmation, as the whole
draft is the user's own account.

If the user supplies a remote repository URL, ask before cloning it to a temporary
directory and remove it afterward unless asked to keep it. Confirm before scanning every
remote branch.

## Group the work

Group related commits into business-line or module outcomes. Fold lint, formatting,
version bumps, repeated syncs, and follow-up fixes into the outcome they supported.
Drop isolated trivial housekeeping. Similar subjects alone are not duplicates; use the
repository, changed paths, and intent, and surface uncertain attribution for review.

## Write the summary

Output a numbered list with no more than 8 top-level outcomes. Each item starts with the
business line/module and states a concrete result with 2-4 key points or one concise
sentence. Prefer high-impact delivery, architecture, and key fixes; condense or omit
routine work. Do not distribute the quota evenly if that hides standout results.

Mention a concentrated month only when it adds useful distribution context, never as a
productivity score. Match the user's language. Every confirmed outcome must trace to a
commit or a user-confirmed log item.

```text
> 作者: <author> · 窗口: 2026-01-01 ~ 2026-06-30 · (自动推断, 如不对请指正)
> 项目: <repo1> · <repo2>

1. <业务线A>: <结果>; <关键点>
2. <业务线B>: <结果>
```

End with one reminder that this is a draft requiring review. Do not write it to a file
unless asked. Add at most one extra hint, and only when evidence is likely incomplete:

- unconfirmed log-only work exists;
- terse commits lack business context and no log was available;
- the conversation or log provides concrete evidence of unscanned projects/branches.
