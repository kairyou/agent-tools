# Agent instructions

Conventions this repo has settled on. They live here because they cannot be
inferred from the code, and getting them wrong costs a round of rework.

## Build and test

Tests exercise the bundles in `dist/`, so run `npm run build` before `npm test`
after touching anything under `capabilities/`.

## Layout

- Self-contained capabilities that work when copied by a Skill installer live
  in `skills/`. They may bundle `scripts/`, `references/`, and `assets/` in the
  same Skill directory.
- Skills centered on a specific external or business system live in
  `skills/systems/`.
- Capabilities that require independent installation, hooks, shared runtimes,
  generated bundles, or Agent configuration live in
  `capabilities/<capability>/`, with per-agent adapters named
  `<agent>-<form>.mjs`.
- Every executable installed into `~/.agent-tools` by the capability installer
  comes from `dist/`; sources stay in `capabilities/`. Bundled scripts inside a
  self-contained Skill are installed with that Skill instead.
- Capability-owned Skill templates that contain unrendered `{{TOKENS}}` live
  in `capabilities/<capability>/skills/` and must not ship through
  `npx skills add`. `config.default.jsonc` remains the installer-merged
  exception from the repo root.

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
  Chinese text. In `- term — description` lines the separator is `—`, not `-`.
- `README.md`, `README.zh-CN.md`, and both `docs/` trees change together.
- Prefer deleting a sentence over explaining it. Say what the reader must do,
  not how it works inside.

## Commits

Single-line Conventional Commits, English, no body or footer. Use `!` for
changes that break an existing install.
