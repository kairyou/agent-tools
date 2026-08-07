# Claude skill composition and compatibility rules

The generated skills are derived and adapted from selected variants of Claude
Code's built-in `code-review` and `simplify` workflow prompts. They keep the
useful behavior while removing host-specific output and tool assumptions, so
they work across supported agents. They are not byte-for-byte captures of
every Claude Code runtime.

## Selected variants

| Skill | Selected Claude Code variant |
| --- | --- |
| `at-review` | High effort, Agent available, eight finder angles, recall-biased verification, Markdown findings by default, optional `--json` and `--fix` |
| `at-simplify` | Agent available, four parallel cleanup angles, apply fixes |

## Runtime variables

| Variable | Resolution |
| --- | --- |
| `DIFF_GATHERING_PHASE` | Upstream `skill-code-review-phase-0-gather-diff` object |
| `AGENT_TOOL_NAME` | Render as `Agent`, then apply the cross-agent tool wording rule |
| `AGENT_UNAVAILABLE_INSTRUCTIONS` | Empty because the selected variant requires multi-agent capability |
| `BASE_FINDER_ANGLES_BLOCK` | Upstream correctness finder object |
| `CLEANUP_AND_ALTITUDE_CANDIDATES_NOTE` | Local Reuse and Simplification fragments plus upstream Efficiency, Altitude, and Conventions objects |
| `RECALL_BIASED_VERIFY_PHASE` | Upstream verify template plus upstream recall-biased rubric |
| output format | Put the local Markdown report first, with explicit `High`, `Medium`, or `Low` findings; preserve the upstream JSON schema for the low-frequency `--json` mode |
| `REPORT_FINDINGS_TOOL_NAME` | Host-specific placeholder; the portable output rule forbids using it |
| `HAS_REPORT_FINDINGS_TOOL` | False branch because host-specific structured reporting is excluded |
| `REUSE_FINDER_ANGLE_BLOCK` | Local-locked Reuse fragment |
| `SIMPLIFICATION_FINDER_ANGLE_BLOCK` | Local-locked Simplification fragment |
| `EFFICIENCY_FINDER_ANGLE_BLOCK` | Upstream Efficiency object |
| `ALTITUDE_FINDER_ANGLE_BLOCK` | Upstream Altitude object |

Every variable in an included wrapper must be resolved. Generation fails if a
`${...}` expression remains.

## Excluded but monitored

The manifest fetches and diffs these prompt objects but never composes them
into the portable skills:

- GitHub comment posting.
- Workflow-backed review routing.
- Artifact publishing.
- Claude Code `ReportFindings` UI output.
- Agent-unavailable inline review and simplify modes.

## Portability rules

The executable exact-match rules live in `rules.mjs`. Each rule has an ID,
source text, replacement text, and expected match count. A changed upstream
anchor stops generation instead of silently dropping the patch.

The rules cover:

- Agent-specific tool wording.
- Project instruction files beyond `CLAUDE.md`.
- Host-specific findings reporting.
- The optional `--fix` guard.
- PowerShell-safe quoting for `@{upstream}`.
- Portable skill names and frontmatter.

## Local-locked fragments

Piebald currently leaves Reuse and Simplification as runtime interpolation
values without standalone prompt objects. Their rendered text is stored in
`rules.mjs` and hash-reported during dry runs.

This is the main fidelity limit. A change to those values could be invisible
to the versioned JSON even when the surrounding wrapper is unchanged. Compare
them with a real rendered Claude Code prompt whenever a surrounding template
changes, and periodically as a manual audit even when it does not.

## Upstream roles

`Piebald-AI/tweakcc` supplies the versioned machine-readable JSON. The
`Piebald-AI/claude-code-system-prompts` repository supplies a human-readable
Markdown and changelog view of the same Claude Code extraction ecosystem. It
is useful for review, but it is not an independent verification source.
