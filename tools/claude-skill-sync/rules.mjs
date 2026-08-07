export const LOCAL_FRAGMENTS = {
  reuseGuidance: {
    source: "rendered Claude Code prompt; not exposed as a standalone Piebald prompt object",
    text: `Flag new code that re-implements something the codebase
already has — Grep shared/utility modules and files adjacent to the change,
and name the existing helper to call instead.`,
  },
  simplificationBlock: {
    source: "rendered Claude Code prompt; not exposed as a standalone Piebald prompt object",
    text: `### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name
the simpler form that does the same job.`,
  },
};

export const TEXT_RULES = {
  "at-review/output-json-mode": {
    expectedCount: 1,
    from: "Return findings as a JSON array of at most 10 objects:",
    to: "Only when `--json` was explicitly passed, return findings as a JSON array of at most 10 objects:",
  },
  "at-review/output-heading": {
    expectedCount: 1,
    from: "## Output",
    to: "### JSON mode",
  },
  "at-review/output-portability": {
    expectedCount: 1,
    from: "Do not call the\nhost-specific findings-reporting tool even if it is available - this review's\noutput contract is the JSON block above.",
    to: "Do not use a host-specific findings-reporting tool even if one is available.",
  },
  "at-review/fix-guard": {
    expectedCount: 1,
    from: "The `--fix` flag was passed.",
    to: "Only apply anything when `--fix` was passed.",
  },
  "at-review/agent-tool": {
    expectedCount: 2,
    from: "via the Agent tool",
    to: "using multi-agent capabilities",
  },
  "at-simplify/agent-tool": {
    expectedCount: 1,
    from: "via the Agent tool",
    to: "using multi-agent capabilities",
  },
  "shared/powershell-upstream": {
    expectedCount: 1,
    from: "`git diff @{upstream}...HEAD`",
    to: "`git diff \"@{upstream}...HEAD\"`",
  },
};

export const PROJECT_INSTRUCTIONS_SECTION = `### Conventions (project instructions)

Find the instruction files that govern the changed code: user-level instructions for the current agent, the repo-root AGENTS.md or CLAUDE.md, plus any AGENTS.md, CLAUDE.md, or CLAUDE.local.md in a directory that is an ancestor of a changed file (a directory's instruction file only applies to files at or below it). Read each one that exists, then check the diff for clear violations of the rules they state.

Only flag a violation when you can quote the exact rule and the exact line that breaks it — no style preferences, no vague "spirit of the doc" inferences. In the finding, name the instruction file path and quote the rule so the report can cite it. If no instruction file applies, return nothing for this angle.`;

export function applyTextRule(text, id) {
  const rule = TEXT_RULES[id];
  if (!rule) throw new Error(`Unknown portability rule: ${id}`);
  const matches = text.split(rule.from).length - 1;
  if (matches !== rule.expectedCount) {
    throw new Error(`Patch ${id} expected ${rule.expectedCount} matches, found ${matches}`);
  }
  return text.replaceAll(rule.from, rule.to);
}
