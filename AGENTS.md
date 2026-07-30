# Agent instructions

Conventions this repo has settled on. They live here because they cannot be
inferred from the code, and getting them wrong costs a round of rework.

## Build and test

Tests exercise the bundles in `dist/`, so run `npm run build` before `npm test`
after touching anything under `integrations/`.

## Layout

- One directory per installable capability: `integrations/<capability>/`, with
  per-agent adapters named `<agent>-<form>.mjs`.
- Every executable file copied into `~/.agent-tools` comes from `dist/`; the
  sources stay in `integrations/`. `config.default.jsonc` is the exception: the
  installer merges it in from the repo root.
- Capability-bound skills live in `integrations/<cap>/skills/`, never in
  `skills/`: those templates hold unrendered `{{TOKENS}}` and must not ship
  through `npx skills add`.

## Settled decisions

- No migration or legacy-compat code. Breaking a layout is fine: bump a minor
  version and state the one-time manual cleanup in the summary.
- Add no new env knobs for timing: a value that follows from the caller's shape
  belongs in a module constant, with a comment explaining that number. The
  overrides already in `codex-hook.mjs` and `claude-statusline.mjs` predate this
  and stay unless a change removes them deliberately.
- Never claim compatibility that has not been verified against a real gateway.
- Usage output lines carry no branding prefix; each display surface adds its own
  context.

## Docs

- Never use CJK/fullwidth punctuation. Write `,` `.` `:` `;` `(` `)` even in
  Chinese text.
- `README.md` and `README.zh-CN.md` change together.
- Prefer deleting a sentence over explaining it. Say what the reader must do,
  not how it works inside.

## Commits

Single-line Conventional Commits, English, no body or footer. Use `!` for
changes that break an existing install.
