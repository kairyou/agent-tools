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

GitHub comment posting, workflow routing, Artifact publishing, host-specific
`ReportFindings` output, and no-Agent fallback prompts are monitored but are
not composed into the portable skills.

Piebald does not expose the Reuse and Simplification interpolation values as
standalone prompt objects. Their text is therefore local-locked in
`render.mjs`; compare it with a real rendered Claude Code prompt when either
surrounding template changes.

## Provenance

The selected upstream prompt objects are redistributed under the MIT license
from Piebald LLC. See `THIRD_PARTY_LICENSE.md`.
