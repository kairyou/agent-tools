---
name: at-zentao
description: "Work ZenTao bugs/tasks end to end: fetch details, confirm understanding, fix, verify, stage with git add, then ask before committing and before writing status back to ZenTao. Supports single items and sequential batches. Use when the user references ZenTao (禅道) bugs or tasks."
argument-hint: "bug <id> | task <id> | bugs | tasks | export bug|task <id>"
---

# ZenTao Bug/Task Workflow

## Configuration

Primary config lives under a `zentao` key in `~/.agent-tools/config.jsonc` — or `$AGENT_TOOLS_HOME/config.jsonc` when `AGENT_TOOLS_HOME` is set, matching the rest of agent-tools. Every `~/.agent-tools/config.jsonc` below means this resolved path:

```jsonc
{
  "zentao": {
    "url": "http://zentao.example.com",
    "account": "...",
    "password": "..."
  }
}
```

Resolution order (first match wins):

- URL: env `ZENTAO_URL` → `zentao.url` in `~/.agent-tools/config.jsonc`.
- Credentials: env `ZENTAO_ACCOUNT`/`ZENTAO_PASSWORD` → `zentao.account`/`zentao.password` in `~/.agent-tools/config.jsonc`.

ZenTao config comes ONLY from env vars and the global `~/.agent-tools/config.jsonc`, never a repository-level file — so an untrusted repo can't redirect the endpoint to capture your credentials.

**First-run setup** (when config is missing or incomplete):

1. If `~/.agent-tools/config.jsonc` has no `zentao` block, insert one INTO the root object (not appended after the closing `}`) — it is JSONC, so preserve existing keys and comments, and mind the trailing comma:
   `"zentao": { "url": "", "account": "", "password": "" }`
2. Ask for the URL and account as a PLAIN chat question and wait for the reply — never collect free-form values via a multiple-choice prompt (its fixed option labels would be submitted as the answer). Write the reply into the config — these are not secrets.
3. NEVER ask the user to paste the password into the chat (it would persist in transcripts). Tell them — in the same message as step 2 — to fill `zentao.password` in the file themselves or set env `ZENTAO_PASSWORD`, and to say "done" when finished.
4. Then validate immediately: exchange a token and call `GET /api.php/v1/user`. Report the result before doing any real work.

## Authentication (once per session)

ZenTao tokens expire, so exchange credentials for a fresh token at the start of each session:

```
POST $ZENTAO_URL/api.php/v1/tokens
Content-Type: application/json
{"account":"...","password":"..."}
```

The response's `token` field is used as a `Token: <token>` header on every subsequent API request. Keep it in memory for the session only; never write it to a file and never echo it in full. If any later call returns 401, exchange for a new token once and retry; if it still fails, stop and report.

If env `ZENTAO_TOKEN` is set, use it directly and skip the exchange (re-exchange is unavailable then — on 401, tell the user the token expired).

**Connectivity check**: after obtaining the token, `GET $ZENTAO_URL/api.php/v1/user` must succeed before any other work. On failure, stop and tell the user to check URL/credentials.

## Usage

- `/at-zentao bug <id>` — handle a single bug
- `/at-zentao task <id>` — handle a single task
- `/at-zentao bugs` — list bugs assigned to the configured account; the user picks one or several (multiple = batch mode)
- `/at-zentao tasks` — same for tasks
- `/at-zentao export bug <id>` (or `export task <id>`) — export to a self-contained Markdown bundle for handoff; does NOT fix or write back (see Export mode)

## API endpoints (verified on ZenTao open source 18.12)

All requests send the `Token: <token>` header — it works for both endpoint families below.

**My work lists** (legacy `.json` pages; the entry point for picking what to fix):

- `GET /my-work-bug.json` — bugs assigned to the configured account
- `GET /my-work-task.json` — tasks assigned to the configured account
- Response shape: `{"status":"success","data":"<JSON-encoded string>"}` — the `data` field is a STRING containing JSON (with `\uXXXX` escapes), so decode it a second time. Bugs are in `.bugs[]` (fields: `id`, `title`, `severity`, `pri`, `status`, `project`, `product`), tasks in `.tasks[]`. The first page usually suffices, but read the pager info inside `data` for the total — if there are more pages, tell the user (e.g. "showing 20 of 45; say more to load the rest") instead of silently truncating, and fetch further pages only on request.

**Details and write-back** (REST v1):

- `GET /api.php/v1/bugs/{id}` — bug details (title, steps, severity, module)
- `GET /api.php/v1/tasks/{id}` — task details

**Attachments / inline images** (legacy, same Token header; binary — save with `curl -o`, never read as text):

- `GET /file-read-{fileID}.{ext}` — view/inline. Observed on 18.12: bug screenshots are embedded in the `steps` HTML as `<img src=".../file-read-{id}.png">` while the `files` list is empty — so scan `steps`, don't rely on `files`.
- `GET /file-download-{fileID}.html` — download an attachment (when `files` is populated).

**Resolving a bug** (the REST `PUT /bugs/{id}` does NOT perform a real resolve — do not use it for status changes; use the legacy action, which mirrors the web form and triggers the full workflow):

1. `POST /bug-resolve-{id}.json` with a form body (`Content-Type: application/x-www-form-urlencoded`, same Token header):
   `resolution=fixed&resolvedBuild=trunk&responsibleBy=<account>&comment=<...>`
   where `responsibleBy` is the authenticated account (from config) — this instance requires it.
   Encoding: NEVER pass non-ASCII (Chinese) text as a command-line argument — Windows curl.exe converts argv through the ANSI codepage and mangles it regardless of terminal. Feed such text via stdin: `--data-urlencode "comment@-"` plus a herestring/pipe/heredoc. ASCII fields may go inline in `-d`; all data flags merge into one form body. Verified one-liner:
   `curl -s -X POST -H "Token: $TOKEN" -d "resolution=fixed&resolvedBuild=trunk&responsibleBy=<account>" --data-urlencode "comment@-" "$ZENTAO_URL/bug-resolve-{id}.json" <<< $'<comment line 1>\n<line 2>'`
2. To add a comment WITHOUT changing status: `POST /action-comment-bug-{id}.json`, comment fed via stdin the same way (`--data-urlencode "comment@-"`).
3. Check the DECODED response: legacy endpoints return HTTP 200 with `{"status":"success","data":"..."}` even on failure — the real outcome is inside `data` (`result: "fail"` + per-field `message`). Surface those validation messages to the user verbatim; if a required field is missing, discover the form's fields and defaults via `GET /bug-resolve-{id}.json`, fill it, and re-confirm with the user before retrying.

**Finishing a task**:

1. `GET /task-finish-{id}.json` — the decoded `data.task` object holds current values (`realStarted`, `consumed`, `openedBy`, ...).
2. `POST /task-finish-{id}.json` (same Token header and stdin-encoding rules as bug resolve) with:
   - `currentConsumed` — hours spent; a value only the user knows. ALWAYS ask the user for it; never invent or estimate it on their behalf.
   - `consumed` — TOTAL consumed, must exceed the previous total: compute as `data.task.consumed + currentConsumed`.
   - `realStarted` — required; reuse `data.task.realStarted` if set, otherwise use a sensible date confirmed with the user (format `YYYY-MM-DD HH:MM:SS`; a space, so either `--data-urlencode` it or write the space as `+` inside `-d`).
   - `finishedDate` — now, same format.
3. To comment on a task without finishing it: `POST /action-comment-task-{id}.json`.

If a call fails, report the actual HTTP status and response body to the user instead of failing silently.

Do NOT browse via products/projects — always start from the my-work lists or an explicit id the user gives.

## Per-item workflow (follow strictly, in order)

1. **Fetch details** — pull title, reproduction steps, severity, and module via the API. Images are usually inline in the `steps` HTML (`<img src=".../file-read-{id}.png">`; the `files` list is often empty) — download each with the Token header to a temp file and Read it now, so the screenshot informs the fix. If you cannot see images, try an image-inspection tool with the downloaded file path — e.g. `inspect_image` (MCP server `agent-tools-vision`) — never the token-gated ZenTao URL; if none is available, work from the text details and note that screenshots were skipped.
2. **Restate and confirm** — restate the problem and the intended fix in your own words. If the description is unclear or ambiguous, ask the user before touching code.
3. **Locate the code** — search the current project for the relevant code and explain how it was identified.
4. **Fix** — change only what this bug/task requires; no unrelated cleanups.
5. **Verify** — proportionate to the change: run the narrowest check that exercises it (the affected tests, a targeted build/typecheck of the touched module — not a full build for a one-line fix). If the bug is reproducible from code, reproduce it before the fix and confirm it is gone after. Use the project's verify skill if one exists. For changes machines can't judge (UI/visual/interaction), say so honestly — state what WAS checked (compiles, tests pass) and that the visual result needs the user's eyes; the user verifies via the "not yet" path at the commit step. Never present an unverifiable change as verified. A failed check must not proceed to the next step.
6. **git add** — first run `git diff --staged --name-only`; if the index already holds unrelated changes, STOP and ask the user (commit those separately / unstage them / proceed anyway) so the `bug#<id>` commit isn't polluted. Then stage only the files changed for THIS item, listing them explicitly (never `git add -A`).
7. **Ask whether to commit** (never commit automatically):
   - 1) Commit — generate and show a Conventional Commits message, following all at-commit conventions (language policy, ≤74-char single-line title). Right after `type(scope):`, add the ZenTao link token — `bug#<id>` or `task#<id>` — e.g. `fix(<scope>): bug#30887 <desc>` (scope optional). Rewrite the description from the diff rather than copying the title, keeping the title's domain terms.
   - 2) Not yet — keep the changes staged and continue
   - 3) Needs adjustment — take the feedback and return to step 4
8. **Ask whether to update ZenTao** (never change status automatically). First DRAFT the write-back, then show it in the confirmation question. If the item was NOT committed (you chose "Not yet" at step 7), do not draft a `fixed` resolution or a commit hash — at most a comment with the status left unchanged, since a `fixed` write-back must reference a real commit:
   - **Resolution** — pick the value that matches what actually happened (ZenTao's enum): `fixed` 已解决 (default after a code fix), `notrepro` 无法重现, `duplicate` 重复Bug (needs the duplicate bug id), `bydesign` 设计如此, `external` 外部原因, `postponed` 延期处理, `willnotfix` 不予解决. If investigation showed the bug needs no code fix, propose the fitting non-`fixed` resolution instead.
   - **Comment** — one sentence: root cause + change summary, plus the commit hash if committed. Don't list files or expand into narrative.
   - Options (reply with a number): 1) Submit  2) Edit first  3) Comment only (no status change).
   - **For tasks**, default to adding a comment only (drafted the same way). Offer "finish" ONLY for simple tasks completable in one sitting — it asks the user for hours (`currentConsumed`) and submits once. For multi-day tasks or teams that log per-day workhours, do NOT attempt finish via API; post the comment and point the user to the web UI's 记录工时/完成 forms, which handle per-day entries properly.

## Export mode (`export bug <id>` / `export task <id>`)

Produce a self-contained handoff for someone (or another agent) WITHOUT ZenTao access. Read-only: do NOT fix, commit, or write status back.

1. Fetch details as in step 1, including downloading every inline/attached image — they are token-gated, so the recipient cannot fetch them; the export must carry them.
2. Ask the user where to save (a free-form value — ask in plain chat, never via a multiple-choice prompt); default to the Desktop, never the code repo (an export artifact doesn't belong in project source).
3. Write the Markdown: a header (id, title, status, severity/pri, module/product, opened/assigned), the `steps` converted from HTML to Markdown, and comments/history when useful. Strip anything auth-bound — never include the token, credentials, or login-gated URLs.
4. Layout by content:
   - No images → a single file `<dest>/zentao-<bug|task>-<id>.md`.
   - With images → a folder `<dest>/zentao-<bug|task>-<id>/` holding that `.md` plus the downloaded images; rewrite each `<img src=".../file-read-...">` to a relative `![](./file-read-<id>.png)` link. Keep images as real files (never base64) so another agent can Read/see them and every viewer renders them; to hand the folder over as one item, zip it.

## Batch mode

- Strictly sequential — one item at a time, each with its own stage/commit. Never mix changes from different bugs.
- Continue to the next item ONLY after the current item's changes are committed. If the user chose "not yet" at the commit step, do not start the next item — its `git add`/commit would sweep up the still-staged changes (and same-file edits can't be untangled later). Instead ask: commit now / stash this item's changes and continue / stop the batch here.
- After each item, ask: continue to the next / stop (summarize progress so far). The user can also name a specific pending item to skip.
- Before starting, show the pending list and let the user confirm the order.

## Hard rules

- Never commit and never change ZenTao status without asking first.
- The commit subject MUST carry the `bug#<id>` / `task#<id>` token right after `type(scope):` — ZenTao's repo integration parses it to auto-link the commit, and it keeps IDs aligned in `git log --oneline`.
- Confirmations may use a multiple-choice prompt if the agent has one (e.g. Claude Code's AskUserQuestion), but ONLY for enumerable decisions (commit? write back? which resolution?). Free-form values — URL, account, hours — are collected by asking in plain chat and waiting for the reply.
- Never echo the password or token in full, and never write them anywhere except the `zentao` block of the user's global config (the password there is filled in by the user, not by you).
- On API failures, report the HTTP status and response body verbatim; do not guess and continue.
