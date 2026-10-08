# Claude skill upstream sync

This maintainer-only tool derives `at-review` and `at-simplify` directly from
the official Claude Code npm package. It is outside the published package.

## Workflow

```text
npm run claude-skills:fetch
npm run claude-skills:inspect
npm run claude-skills:apply -- --dry-run
npm run claude-skills:apply -- --write
npm run claude-skills:check
```

Fetching requires `tar` on PATH. Without `--version`, it selects npm latest and
reads the matching `@anthropic-ai/claude-code-linux-x64` package on every host OS.
The package is neither installed nor executed.

`fetch` writes `upstream/pending.json` and a report only after successful
extraction. Review the generated diff before using `apply --write`, which promotes
the snapshot to `current.json`. `check` reproduces the skills offline.
Unchanged selected content does not create a version-only update.

The scheduled Action fetches, renders, builds, and tests before opening a draft
PR. Review the official snapshot and generated skills together. While a sync PR
is open, later runs leave its branch untouched. Merge accepts the snapshot;
publishing remains separate.

If extraction or validation fails, download `claude-skill-sync-diagnostics` from
the run for fetch/render logs and available snapshots. No fallback to older text
is used.

## Extraction and limits

The extractor locates the registered `code-review` and `simplify` commands in
embedded JavaScript modules, follows their references, and statically interprets
the selected prompt-producing code. It does not match full prompt sentences or
pin minified variable names. Reuse, Simplification, Altitude, and other referenced
content are included automatically.

The selected review variant is the explicit `high` recipe with agents available,
host reporting disabled, and a ten-finding limit. It is not the model-dependent
default routing of a live Claude Code session. See `RULES.md` for local adaptations.

Real-package extraction was verified against 2.1.260, 2.1.292, and 2.1.293. The
older 2.1.235 package layout is unsupported. Changes to packaging, command routing,
or selected runtime expressions may require an extractor update; ordinary prose,
fragment changes, and symbol renaming do not require sentence patches.

The snapshot records the package version, npm SHA-512 integrity, bundle and
source-module hashes, selection options, rendered texts, and their SHA-256 hashes.
The renderer retains Markdown output by default, opt-in `--json` and `--fix`, and
portable instruction-file/tool wording. Always review behavioral changes in the PR.
