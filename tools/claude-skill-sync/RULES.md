# Claude skill composition rules

The generated skills use Claude Code's registered `code-review` and `simplify`
commands from the official npm package. They retain the selected upstream content
while adapting output and tool assumptions for portable skills.

## Selected variants

| Skill | Selection |
| --- | --- |
| `at-review` | Explicit `high` recipe, Agent available, host reporting disabled, at most 10 findings, optional fix instructions |
| `at-simplify` | Agent available, no supplied target, upstream cleanup and fix workflow |

`high` names the recipe selected from the official effort router. The tool does
not reproduce model-specific default routing, user settings, feature flags,
telemetry, PR comment posting, or session-dependent prefixes.

## Official extraction

`official.mjs` downloads the matching Linux x64 package and verifies npm's SHA-512
integrity before reading `package/claude` through `tar`. `bundle.mjs` parses its
embedded JavaScript modules without installing or executing upstream code.

Command registration identifies the entrypoints. The review call site supplies
the effort router, output formatter, and Agent/host-reporting predicates. Local
selection values choose the high recipe and the fix-flag branch. The simplify
handler is interpreted with an empty target and Agent availability enabled.

The static reader supports literals, strings, templates, references, imported
bindings, function calls/default arguments, conditionals, logical expressions,
strict equality, concatenation, arrays/objects, local declarations, return, if,
and switch. String trimming is explicitly supported. It rejects unknown active
operations, missing or ambiguous imports/commands, and excessive interpretation.
It never calls upstream JavaScript through eval, Function, or dynamic import.

Reuse, Simplification, Altitude, and other referenced text are resolved from the
same official bundle. The snapshot stores complete selected texts rather than
third-party prompt IDs or locally frozen fragments. Any selected text change
participates in candidate review.

## Local adaptations

- Markdown findings by default; the official JSON contract is scoped to `--json`.
- Apply the official fixes section only when `--fix` was passed.
- Generalize Agent and host-reporting tool names.
- Include `AGENTS.md` and agent-level instructions alongside `CLAUDE.md`.
- Quote `@{upstream}` for PowerShell.
- Use portable skill names and frontmatter.
- Add read-only hosted PR/MR target guidance through `references/review-targets.md`.

The output contract is located using text extracted from the same package, not a
fixed sentence. Other upstream content, including unavailable-Agent fallback
instructions within the high recipe, remains intact.

## Verification boundary

Real packages 2.1.260, 2.1.292, and 2.1.293 were verified. The older monolithic
2.1.235 layout is unsupported. The module format and command/router interfaces
are internal implementation details, so future structural changes can still
require maintenance. Unknown cases stop generation instead of guessing or
silently retaining an older snapshot.
