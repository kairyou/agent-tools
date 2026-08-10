# Pending Claude skill upstream

- Accepted Claude Code version: 2.1.223
- Pending Claude Code version: 2.1.226
- Source: Piebald-AI/tweakcc@726b940a5928a6f5fc9f22d9f9e8b7a7902d0568
- Source SHA-256: 8566d6bdc589cc19f09c71602c5e54fd2b376077b157f9b3fbbf0f7c83d5faf9

## Selected prompt changes

- agent-prompt-code-review-workflow-routing (changed, source 2.1.224) — monitored and excluded by at-review

## Local-locked composition

Piebald exposes Reuse and Simplification as runtime interpolation values, not standalone prompt objects.
Their exact text is hash-locked in the local renderer and must be checked against a real rendered prompt when it changes.

## Manual next step

Run `npm run claude-skills:apply -- --dry-run`, inspect the generated skill diff, then run with `--write`.
