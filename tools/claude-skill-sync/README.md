# Claude skill upstream sync

This maintainer-only tool tracks the Claude Code prompt fragments from which
`at-review` and `at-simplify` are derived and adapted. It is outside the
published package.

The machine-readable source is the versioned prompt JSON maintained by
[`Piebald-AI/tweakcc`](https://github.com/Piebald-AI/tweakcc). Fetching treats
that repository as untrusted data: no upstream code is executed.

`RULES.md` is the maintainer reference for selected Claude Code variants,
local substitutions, excluded features, and known fidelity limits. It explains
why the generated skills differ from Claude Code in host-specific details; it
is not required at runtime.

## Workflow

```text
npm run claude-skills:fetch
npm run claude-skills:inspect
npm run claude-skills:apply -- --dry-run
npm run claude-skills:apply -- --write
npm run claude-skills:check
```

`fetch` writes only `upstream/pending.json` and a review report. `apply` is
read-only unless `--write` is passed. A successful write promotes the pending
snapshot to `upstream/current.json` and regenerates the two installable skills.
Without `--version`, `fetch` uses the highest mirrored version not newer than
npm latest. If npm is ahead, the command reports the lag and still processes
the newest available mirror. An explicit `--version` remains strict: a missing
matching JSON is reported as `mirror pending` without writing files.

The scheduled GitHub Action runs the same fetch and apply pipeline in its
runner, then runs `claude-skills:check`, the build, and the full test suite. It
opens a draft PR containing the final candidate: the promoted `current.json`
and any generated skill changes. The pending files are transient and never
belong in that PR. A renderer or patch-anchor failure stops the workflow before
PR creation. Merging the reviewed PR accepts the upstream baseline; publishing
remains a separate manual step. While a sync PR is open, later scheduled runs
leave its branch untouched so manual review edits are never overwritten.

Only prompt objects composed into the portable skills are fetched and diffed.
Host-specific and reference-only prompts do not participate in automated sync.

Piebald prompt IDs are curated extraction metadata, not a stable Anthropic API.
If a selected ID disappears, the fetch fails closed so a maintainer can verify
whether the fragment was removed, renamed, or missed by extraction.

Fragments that cannot be tracked reliably through Piebald are local-locked in
`rules.mjs`, with their source reason and, when available, the exact Claude Code
package version. Their content hashes are printed during inspection. Reuse and
Simplification are runtime interpolation values that Piebald does not expose as
standalone prompt objects. Altitude is verified from the official Claude Code
2.1.260 npm bundle after its Piebald object disappeared while the underlying
fragment changed and remained in the bundle.

The missing Altitude ID remains optional monitoring input. Its absence does not
block unrelated updates; if Piebald exposes it again, the sync creates a
reviewable monitored change so maintainers can compare it with the local-locked
fragment and restore direct tracking when appropriate.

## Provenance

The selected upstream prompt objects are redistributed under the MIT license
from Piebald LLC. See `THIRD_PARTY_LICENSE.md`.
