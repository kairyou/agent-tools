# Pending Claude skill upstream

- Accepted Claude Code version: 2.1.223
- Pending Claude Code version: 2.1.224
- Source: Piebald-AI/tweakcc@6bf7e7f755b669f757fcd58cc439354715ae7611
- Source SHA-256: 6c7a02f41ad272e061602aa3bceb65cdc5e548ea507a77ffa85f314f5ebcef82

## Selected prompt changes

- agent-prompt-code-review-workflow-routing (changed, source 2.1.224) — monitored and excluded by at-review

## Local-locked composition

Piebald exposes Reuse and Simplification as runtime interpolation values, not standalone prompt objects.
Their exact text is hash-locked in the local renderer and must be checked against a real rendered prompt when it changes.

## Manual next step

Run `npm run claude-skills:apply -- --dry-run`, inspect the generated skill diff, then run with `--write`.
