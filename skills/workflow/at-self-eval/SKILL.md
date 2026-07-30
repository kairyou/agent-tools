---
name: at-self-eval
description: "Summarize a contributor's git history into a concise, review-friendly self-evaluation for performance cycles (quarterly / semi-annual / promotion). Use when the user asks for a PBC, self-review, or work summary. A daily/weekly log may be pasted or a path provided to enrich the result; other repos or branches may be mentioned to aggregate across projects (all optional)."
argument-hint: "[<author>] [--from yyyy-mm-dd] [--to yyyy-mm-dd]"
---

# Self-Evaluation Summary

`git log → group by business line → dedupe → ≤8 concise output points → human review`

## Phase 0 — Gather the evidence

Normalize every input form — flags, partial flags, or plain language like
`统计 1-3月的产出` / `统计上半年的工作` — into a **determined** `(author, from,
to)` triple, then query. The user's explicit date range always wins; defaults
only fill what the user did not say. Re-state the resolved window in the output
header so the user can catch a wrong inference at a glance.

```bash
# author — default to the current git identity, do NOT guess variants
AUTHOR=$(git config user.name)
# --until is EXCLUSIVE of its date, so push it +1 day to include the last day
git log --author="$AUTHOR" --since="<from>" --until="<to + 1 day>" --no-merges --format="%ad %s" --date=short
```

**Author — do not guess:**

1. Default `<author>` to `git config user.name`. Query only with that name; do
   not infer or try variants. Note that `git log --author` uses regex matching,
   so this rule limits identity guessing rather than promising strict equality.
2. If 0 commits come back, do NOT auto-try pinyin/Chinese variants (risk of
   mismatching a different person or inflating counts). Tell the user nothing
   was found and show how to self-identify:
   ```bash
   git log --format='%an' | sort -u
   ```
3. If results come back, end the output with a one-line hint: the user may have
   commits under other names and can rerun with `--author "name1\|name2"`.

**Date range — `--until` is exclusive, `--since` is inclusive:**

`git log --until=2026-06-30` means *before 2026-06-30 00:00:00* — it silently
drops every commit on June 30. Always pass `<to + 1 day>` as `--until`.

Fill missing dimensions (user's explicit range always wins):

| User gave | resolved to |
| --- | --- |
| Both `--from` and `--to` | use as-is (apply the `--until +1 day` fix) |
| Only `--from` | `to` = today |
| Only `--to` | `from` = Jan 1 of `to`'s year |
| Neither / plain-language time | **current quarter** |

Plain-language time (`上半年` / `1-3月` / `近三个月` / `Q1` etc.) → parse to dates,
defaulting to the current year; if the current month is earlier than the spoken
months (e.g. it's Feb and the user says `统计 11-12 月`), use the previous
calendar year. `上半年/下半年` → Jan–Jun / Jul–Dec; `Q1…/一季度…` → calendar
quarter; `近三个月/最近一个月` → rolling window ending today. No time given →
current quarter.

`--no-merges` always — merge commits are not deliverables.

**Re-state the window (required):** the output MUST begin with a one-line header
so the user can verify or correct an auto-inferred window:

```
> 作者: <author> · 窗口: 2026-01-01 ~ 2026-03-31 · (时间窗口为自动推断, 如不对请指正后重跑)
```

When aggregating multiple repos, append a second line listing each repo and the
branch used. Use plain words, never git jargon like "HEAD":

```
> 仓库: <repo1> (分支 next) · <repo2> (分支 main) · (未指定的均用各仓库当前分支, 如不对请指正)
```

No commit count, no "source" line — they add noise without review value.

### Supplementary context (optional, conversation-driven)

Daily/weekly logs, other repos, and other branches are all **optional
supplementary context**, handled the same way — never via flags. The user offers
them in conversation; the skill asks to clarify only when the user has already
expressed intent. Do not prompt for these at the start.

**Daily/weekly log** (pasted text or a provided file path) is background context:
1. Format-agnostic — do not assume any date sectioning or schema; read as
   continuous text to pick up business-line attribution and intent that commit
   messages lack.
2. No fabrication — commit-backed items may be summarized directly. Log-only
   items must not be mixed into confirmed deliverables; if one appears to be a
   real non-code outcome (design, research, review, training, delivery support,
   coordination), list it separately for user confirmation. Include it in the
   final summary only after the user confirms it.
3. No time re-attribution — dates come from git log only; for a confirmed
   log-only outcome, use only a date explicitly present in the log or provided
   by the user.

**Other repos** (user pastes a path or a remote URL):
- **Local path** → query with `git -C <path> log ...`; resolve that repo's author
  independently (same no-guessing rule as the primary repo). Default to that
  repo's current branch, surfaced in the header for correction.
- **Remote URL** → do NOT auto-clone. Ask the user whether to clone into a temp
  dir for this run; only clone on explicit yes. On yes, clone to a temp dir,
  query it, then delete the temp dir when done (keep it only if the user asks).
  On no, ask for a local path or have them clone it themselves. Never clone
  silently — clone has side effects (disk, auth, slow, may fail).
- Path does not exist / not a git repo → ask, do not guess.

**Other branches** (user names them, e.g. "也包含 dev 分支"):
- Query those branches explicitly. Never run `git log --all` unprompted — on
  large repos it pulls tens of thousands of commits and overruns context.
- Confirm scope with the user before scanning all branches.

**Dedup across repos/branches:** identical commit hashes count once. Do not
mechanically delete commits by date/subject — separate work can share a generic
message, while cherry-picked work can have different dates. During grouping,
merge likely duplicates only when repository, subject, files, and change intent
show they represent the same work; surface uncertain cases for user confirmation.

### Language for user-facing text

All output and prompts to the user use plain words. Avoid git jargon ("HEAD",
"ref", "upstream", "cherry-pick") — users who say "I also worked on the dev
branch" may not know what HEAD means. Keep "commit" and branch names (with
context) as those are widely understood.

## Phase 1 — Group and dedupe

Group commits into **business lines / modules** and merge related commits into
one deliverable. Collapse many commits into the 1–3 outcomes they achieved —
`fix: lint`, `chore: fmt`, repeated `feat: sync` fold into the larger deliverable
they supported. If a group has only trivial housekeeping, merge it into a
related group or drop it. Do not inflate a single commit into a "deliverable."

## Phase 2 — Write the summary

Output a **numbered list**, one deliverable per line, grouped by business line.
Each line:

- starts with the business line / module, a colon, then 2–4 sub-points or a
  one-sentence outcome;
- is verb-led and outcome-oriented (built / shipped / refactored / migrated),
  not a feature-name dump;
- is concrete enough to be credible but concise enough to scan.

- **≤8 top-level items — prioritize impact.** When work exceeds 8 lines, keep
  the high-impact deliverables (built from scratch, major customer delivery,
  architectural refactor, key fix) and merge or drop routine housekeeping
  (lint, format, version bumps, repeated sync). Do not split 8 evenly across
  business lines if that dilutes the standout work.
- A volume/peak note is worth citing inline **only when a business line clearly
  concentrated in one month** (e.g. "5月密集完成 <业务线>"), as a distribution
  cue — not as a self-justifying metric.
- Match the user's language (Chinese request → Chinese output). Identifiers and
  product names stay as-is.
- Do NOT fabricate. Every confirmed deliverable must trace back to a commit or
  to a user-confirmed log entry. Surface uncertain or log-only outcomes as
  candidates for confirmation rather than stating it as fact.

Example shape (header + numbered list, placeholders only):

```
> 作者: <author> · 窗口: 2026-01-01 ~ 2026-06-30 · (时间窗口为自动推断, 如不对请指正后重跑)

1. <业务线A>: <动词开头的产出>; <2–4 个关键点或一句成果>
2. <业务线B>: ...
```

End with a one-line reminder: this is a draft — verify before submitting, since
AI may merge or misattribute work. Do not write the summary to any file unless
the user asks.

**Conditional hints — only when this run likely under-represents the work.**
Do NOT prompt every time; a clean, complete result ends with just the draft
reminder above. Append ONE short line only in these cases:

- A log-only item looks like real work but lacks user confirmation → "日志中还有未对应到 commit 的工作; 如属有效产出, 确认后可纳入总结."
- No daily/weekly log was given AND commit messages are terse / hard to
  attribute → "本次仅基于 commit 归纳; 若有日报/周报可粘贴文本或提供路径, 能补充业务背景使产出更准."
- There is concrete evidence that other repos/branches may contain relevant
  work (the user mentioned them, or the supplied log names work absent from the
  scanned repo) → "可能还有其他仓库或分支的工作未覆盖; 告知路径/分支后可继续聚合统计."

One line, never a follow-up question. Accept pasted text or a path equally —
log formats vary widely, never assume a schema.
