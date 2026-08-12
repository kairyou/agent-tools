---
name: at-zentao
description: "Work ZenTao bugs/tasks end to end: fetch details, confirm understanding, fix, verify, stage with git add, then ask before committing and before writing status back to ZenTao. Supports single items and sequential batches. Use when the user references ZenTao (禅道) bugs or tasks."
argument-hint: "bug <id> | task <id> | bugs | tasks | export bug|task <id>"
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
node <skill-root>/scripts/zentao-cli.mjs get bug <id> --download-dir <path>
```

`get` downloads token-gated inline images and attachments into a temporary
directory by default and returns only local paths. Inspect those local files;
never pass the original ZenTao URL to an image tool.

Write commands require JSON on stdin and are allowed only after the explicit
confirmation steps below:

```text
node <skill-root>/scripts/zentao-cli.mjs comment bug <id>
node <skill-root>/scripts/zentao-cli.mjs comment task <id>
node <skill-root>/scripts/zentao-cli.mjs resolve bug <id>
node <skill-root>/scripts/zentao-cli.mjs finish task <id>
```

Input shapes:

```json
{"comment":"Root cause and result."}
{"resolution":"fixed","resolvedBuild":"trunk","comment":"Root cause and result, commit abc1234."}
{"currentConsumed":1.5,"realStarted":"2026-08-11 09:00:00","finishedDate":"2026-08-11 10:30:00"}
```

For `duplicate`, also pass `"duplicateBug": <id>`. Send JSON through stdin,
not as a command-line argument. The CLI handles UTF-8 form encoding and
computes a task's total consumed hours from its current ZenTao value.

## Usage

- `/at-zentao bug <id>` — handle a single bug.
- `/at-zentao task <id>` — handle a single task.
- `/at-zentao bugs` — list bugs assigned to the configured account; let the
  user select one or more.
- `/at-zentao tasks` — list assigned tasks and let the user select.
- `/at-zentao export bug <id>` or `export task <id>` — create a read-only,
  self-contained handoff bundle.

If a list response includes pager data showing more items than returned, tell
the user the shown and total counts. Do not silently imply the list is complete.
Do not browse through products/projects; start from assigned lists or an
explicit item id.

## Per-item workflow

Follow these steps in order:

1. **Fetch details** — use the CLI `get` command. Read every downloaded image
   now so screenshots inform the fix. If no image-inspection tool is available,
   continue from text and state that screenshots were skipped.
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
write-back comment is one sentence containing root cause, change summary, and
the commit hash when committed.

For tasks, default to comment only. Offer `finish` only for a simple task
completed in one sitting, and ask the user for `currentConsumed`; never invent
hours. For multi-day work or per-day time records, comment and direct the user
to ZenTao's web UI.

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
