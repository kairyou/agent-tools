---
name: at-zentao
description: "Handle ZenTao (禅道) Bugs and Tasks end to end, including updating or writing back an item after code changes, managing Task status and hours, and reading linked Stories. Use for referenced ZenTao items, requirements, status changes, time entries, or post-implementation synchronization."
argument-hint: "bug <id> [request] | task <id> [request] | story <id> | bugs | tasks | export bug|task <id>"
---

# ZenTao Bug/Task Workflow

## Secure CLI boundary

This Skill bundles `scripts/zentao-cli.mjs`. Resolve the Skill root as the
directory containing this `SKILL.md`, then run the script with Node using its
resolved path from any working directory:

```text
node <skill-root>/scripts/zentao-cli.mjs <command>
```

The script is the only component allowed to read ZenTao configuration,
exchange credentials for a token, send authenticated requests, or inspect raw
error responses. Run it directly without reading or copying its source into
the conversation. Never read `~/.agent-tools/config.jsonc`, print ZenTao env
vars, call the token endpoint, or construct a ZenTao `Token` header yourself.

The CLI emits only sanitized JSON. Treat a nonzero exit as a stopped ZenTao
operation and report its safe `error`, `message`, and optional HTTP `status`.
Do not work around the CLI with `curl` when authentication or an endpoint
fails.

## Configuration

The CLI reads the global `~/.agent-tools/config.jsonc`, or
`$AGENT_TOOLS_HOME/config.jsonc` when `AGENT_TOOLS_HOME` is set. It never reads
repository-level configuration. Basic configuration:

```jsonc
{
  "zentao": {
    "url": "https://zentao.example.com",
    "account": "user",
    "password": "your-password"
  }
}
```

To avoid storing the password in the file, use
`"password": { "env": "ZENTAO_PASSWORD" }` and set that environment variable.
Direct env overrides are `ZENTAO_URL`, `ZENTAO_ACCOUNT`, and
`ZENTAO_PASSWORD`. `ZENTAO_TOKEN` may be used instead of password exchange; it
is accepted only from the environment.

When configuration is missing, tell the user which file to edit and show the
template above. Never ask them to paste a password or token into chat, and do
not edit or inspect the file after they add credentials. Ask them to say
"done", then validate with:

```text
node <skill-root>/scripts/zentao-cli.mjs doctor
```

Report only whether the connection succeeded and whether authentication used
`token` or `account-password`.

## CLI commands

Read-only commands:

```text
node <skill-root>/scripts/zentao-cli.mjs list bugs
node <skill-root>/scripts/zentao-cli.mjs list tasks
node <skill-root>/scripts/zentao-cli.mjs get bug <id>
node <skill-root>/scripts/zentao-cli.mjs get task <id>
node <skill-root>/scripts/zentao-cli.mjs get story <id>
node <skill-root>/scripts/zentao-cli.mjs get bug <id> --download-dir <path>
node <skill-root>/scripts/zentao-cli.mjs hours task <id>
```

`get` downloads token-gated inline images and attachments into a temporary
directory by default and returns only local paths. Inspect those local files;
never pass the original ZenTao URL to an image tool.
For Bugs and Tasks, a configured `zentao.commentPrompt` is returned as
`writeback.commentPrompt`. Use it only when drafting a write-back comment; it
is not item data or an existing comment. `get` also returns safe `comments`
from action history, keeping only id, actor, action, date, and non-empty
comment. An omitted `comments` means actions were unavailable; an empty array
means actions were available but contained no comments.

Write commands require JSON on stdin and are allowed only after the explicit
confirmation steps below:

```text
node <skill-root>/scripts/zentao-cli.mjs comment bug <id>
node <skill-root>/scripts/zentao-cli.mjs comment task <id>
node <skill-root>/scripts/zentao-cli.mjs resolve bug <id>
node <skill-root>/scripts/zentao-cli.mjs start task <id>
node <skill-root>/scripts/zentao-cli.mjs pause task <id>
node <skill-root>/scripts/zentao-cli.mjs resume task <id>
node <skill-root>/scripts/zentao-cli.mjs log-hours task <id>
node <skill-root>/scripts/zentao-cli.mjs edit-hours task <id> <effort-id>
node <skill-root>/scripts/zentao-cli.mjs finish task <id>
```

Input shapes:

```json
{"comment":"Root cause and result."}
{"resolution":"fixed","resolvedBuild":"trunk","comment":"Root cause: stale session cache; Fix: refresh it during renewal; Commit: abc1234."}
{"realStarted":"2026-08-11 09:00:00","comment":"Started implementation."}
{"date":"2026-08-11","consumed":2,"left":14,"work":"Implemented the first part of the task."}
{"work":"Corrected work description, commit abc1234."}
{"currentConsumed":1.5,"realStarted":"2026-08-11 09:00:00","finishedDate":"2026-08-11 10:30:00","comment":"Completed: implemented session renewal; Commit: abc1234."}
```

For `duplicate`, also pass `"duplicateBug": <id>`. Send JSON through stdin,
not as a command-line argument. The CLI handles UTF-8 form encoding and
computes a task's total consumed hours from its current ZenTao value.
`start`, `pause`, and `resume` accept an optional `comment`; `start` also
accepts `realStarted` and otherwise uses the current time. The CLI preserves
the task's current hours when starting or resuming it.
`log-hours` defaults `date` to today, requires positive remaining hours,
and keeps the task open. `hours` is read-only. `edit-hours` preserves omitted
fields from the existing record and updates it through ZenTao's native effort
workflow. Use `finish` when the task is complete; its `comment` is optional.

## Usage

- `/at-zentao bug <id>` — handle a single bug.
- `/at-zentao task <id>` — handle a single task.
- `/at-zentao story <id>` — read requirement scope and acceptance context.
  This mode is read-only; do not implement a Story status or comment workflow.
- `/at-zentao bugs` — list bugs assigned to the configured account; let the
  user select one or more.
- `/at-zentao tasks` — list assigned tasks and let the user select.
- `/at-zentao export bug <id>` or `export task <id>` — create a read-only,
  self-contained handoff bundle.

Treat text after an item id as a natural-language request. Recognize task
lifecycle requests such as `开始`, `暂停`, `继续`, `start`, `pause`, and
`resume`, and time-entry requests such as `填工时`, `记录工时`, `log hours`,
and `worklog`. Users do not need to know the internal CLI commands. Reuse any
date, hours, or work description already supplied instead of asking twice.
Recognize corrections to an existing time entry. Run `hours`, identify the
record from returned ids and values, and ask when more than one record could
match; never guess or call `log-hours` again to compensate for a mistake.

If a list response includes pager data showing more items than returned, tell
the user the shown and total counts. Do not silently imply the list is complete.
Do not browse through products/projects; start from assigned lists or an
explicit item id.

When a fetched Bug or Task has a positive `story` id, fetch that Story before
planning the implementation. Use its `spec` and `verify` fields to identify
scope, acceptance criteria, constraints, and non-goals. Keep the Bug or Task as
the unit of work: never change, close, activate, or comment on the Story.

For a Task in `wait`, offer `start` when the user is about to work on it. For a
Task in `pause`, offer `resume`; the CLI maps this to ZenTao's `restart`
operation. Invoke `pause` only when the user explicitly asks or confirms that
the work itself is paused; the end of a session or workday is not enough. These
are status writes, so show the transition and optional comment and obtain
explicit confirmation before invoking the CLI. Starting or resuming preserves
the current hours and never implies new consumed time.

## Per-item workflow

Follow these steps in order:

1. **Fetch details** — use the CLI `get` command. Review every returned comment,
   including comments attached to resolution, activation, and lifecycle actions.
   Read every downloaded image now so screenshots inform the fix. If no
   image-inspection tool is available, continue from text and state that
   screenshots were skipped.
2. **Restate and confirm** — explain the problem and intended fix in your own
   words. Ask before editing when the item is ambiguous.
3. **Locate the code** — search the current project and explain how the relevant
   code was identified.
4. **Fix** — change only what this item requires.
5. **Verify** — run the narrowest meaningful test, build, or typecheck. Reproduce
   a code-observable bug before and after when practical. For visual changes,
   state what was checked and what still needs the user's eyes. Stop on a failed
   check.
6. **Stage** — first inspect `git diff --staged --name-only`. If unrelated files
   are staged, stop and ask how to handle them. Otherwise stage only files for
   this item by explicit path; never use `git add -A`.
7. **Ask whether to commit** — offer Commit, Not yet, or Needs adjustment. For a
   commit, show a single-line Conventional Commit message before committing.
   Put `bug#<id>` or `task#<id>` immediately after `type(scope):`, for example
   `fix(auth): bug#30887 reject expired sessions`. Never commit automatically.
8. **Ask whether to update ZenTao** — draft the exact resolution/comment and
   offer Submit, Edit first, or Comment only. Never invoke a write CLI command
   before confirmation. A `fixed` resolution must cite a real commit; without a
   commit, offer at most a comment with status unchanged.

Bug resolutions are `fixed`, `notrepro`, `duplicate`, `bydesign`, `external`,
`postponed`, and `willnotfix`. Choose what matches the verified outcome. A
write-back comment follows the current user request, then
`writeback.commentPrompt`. Otherwise use the item or user's language and these
defaults:

- For a fixed Bug, use `Root cause`, `Fix`, optional `Verification`, and the
  real `Commit`.
- For a finished Task, use `Completed`, optional `Verification`, and `Commit`
  only when the work has a related commit.
- For other Bug resolutions, use `Conclusion` and applicable `Reason` or
  `Evidence`.
- Keep standalone and lifecycle comments free-form but concise.

Formatting controls wording and layout only. Never invent missing facts;
surface required gaps and put `Commit: <hash>` last.

Immediately before confirming any ZenTao write that cites the latest commit,
run `git rev-parse HEAD` and `git log -1 --format=%h`. Do not reuse a hash from
earlier conversation. If HEAD is not the item-specific commit, identify the
relevant commit and tell the user instead of blindly citing HEAD.

For tasks, ask whether to record the current work after the verified result.
For an incomplete task, collect the actual `consumed` hours and work date. When
the task has a numeric current `left`, suggest the new `left` by subtracting the
current entry and make that estimate editable in the confirmation; ask only
when no reliable suggestion is possible. Draft `work` from the verified result
when context is available. It is optional, so mention the omission without
blocking the write when there is nothing useful to add. For a completed task,
collect `currentConsumed`, draft the completion comment from established facts,
and include both in the `finish` write. Never infer consumed hours or a
verification result. Show all submitted values and require the same explicit
ZenTao confirmation before either write.

To correct an existing time entry, use `hours` to select its effort id. Show
the current and proposed `date`, `consumed`, `left`, and `work`, then obtain
explicit confirmation and call `edit-hours` once. Preserve every field the
user did not change. Stop when ownership cannot be verified or the edit route
is unsupported. If the proposed `left` is zero, explicitly warn that ZenTao
may change the task status as part of its native recalculation. Never edit an
action comment as a substitute for correcting the underlying work-hour record,
and never delete a record.

When the user wants to record hours and pause, show both exact writes in one
confirmation, then run `log-hours` before `pause`. Stop if the hour write fails.
Do not add lifecycle support for `activate`, `cancel`, or `close`.

## Export mode

Export is read-only and never fixes code, commits, or writes back:

1. Fetch the item with `get`, including every downloaded image/attachment.
2. Ask where to save; default to the Desktop and never the code repository.
3. Write a Markdown handoff with id, title, status, severity/priority,
   module/product, description/steps, and useful history available in the safe
   CLI response. Do not include credentials or login-gated URLs.
4. With no images, write `<dest>/zentao-<bug|task>-<id>.md`. With images, create
   a same-named directory containing the Markdown and real image files, rewrite
   image references to relative paths, and zip only when a single artifact is
   needed.

## Batch mode

- Process one item at a time, each with its own stage and commit.
- Show the pending order before starting.
- Continue only after the current item is committed. If it remains staged,
  offer commit, stash and continue, or stop.
- After each item, ask whether to continue or stop and summarize progress.

## Hard rules

- Never expose account, password, token, cookies, or authorization headers.
- Never bypass the bundled CLI for ZenTao authentication or API access.
- Never commit or change ZenTao state without separate explicit confirmation.
- Keep the `bug#<id>` or `task#<id>` token in every related commit subject.
- Collect free-form values such as output paths and hours in plain chat, not a
  fixed-choice prompt. Passwords and tokens are never collected in chat.
