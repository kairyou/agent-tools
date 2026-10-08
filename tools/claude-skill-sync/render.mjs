import { sha256, TEXT_NAMES } from "./lib.mjs";

const REVIEW_TARGET_GUIDANCE = `If the argument is a hosted pull/merge request URL or a numeric PR/MR identifier,
read \`references/review-targets.md\` from this skill directory before running
commands. Follow its read-only resolution and authentication fallback rules;
do not switch the user's working tree or write to the hosting service.`;

function validateSnapshot(snapshot) {
  if (snapshot.schemaVersion !== 3 || snapshot.source?.version !== snapshot.claudeCodeVersion) {
    throw new Error("Official snapshot schema or version mismatch");
  }
  for (const name of TEXT_NAMES) {
    const content = snapshot.texts?.[name];
    if (!content?.text || sha256(content.text) !== content.sha256) throw new Error(`Invalid official content: ${name}`);
  }
}

function compactMarkdownProse(text) {
  return text.split(/\n{2,}/).map((block) => /^(?:#|```|\[|`[^`]+`$)/.test(block)
    ? block : block.replace(/\n/g, " ")).join("\n\n");
}

function portable(text) {
  return text.replace(/\b(?:via|using|through|with) the Agent tool\b/g, "using multi-agent capabilities")
    .replace(/\bthe Agent tool\b/g, "multi-agent support")
    .replace(/\bAgent tool\b/g, "multi-agent support")
    .replaceAll("ReportFindings", "host-specific findings-reporting")
    .replaceAll("~/.claude/CLAUDE.md", "instruction files for the current agent")
    .replaceAll("CLAUDE.md files", "instruction files")
    .replaceAll("CLAUDE.md path", "instruction file path")
    .replaceAll("no CLAUDE.md", "no instruction file")
    .replaceAll("which CLAUDE.md rule", "which project instruction")
    .replaceAll("CLAUDE.md", "AGENTS.md or CLAUDE.md")
    .replaceAll("`git diff @{upstream}...HEAD`", '`git diff "@{upstream}...HEAD"`')
    .replaceAll("`/simplify", "`at-simplify").replaceAll("`/code-review`", "`at-review`");
}

function renderOutput(text, maxFindings) {
  const output = `### JSON mode\n\nOnly when \`--json\` was explicitly passed, follow this output contract:\n\n${text.replace(/^##[^\n]*(?:\n|$)/, "").trim()}`;
  const limit = maxFindings === "all" ? "no maximum" : `at most ${maxFindings}`;
  return `## Output\n\nUnless \`--json\` was explicitly passed, the main agent's final answer is a Markdown report, nothing else. Structure it exactly:\n\n**Summary** - 1-2 sentences on the review scope and what was found. If the diff was empty, write exactly "No changes to review." and stop. If nothing survived verification, write exactly "No findings survived verification." and stop.\n\n**Findings** - one numbered block per finding, most-severe first, ${limit}. Assign each finding \`High\`, \`Medium\`, or \`Low\` from its concrete impact and likelihood:\n\n\`\`\`text\n1. High|Medium|Low: summary\n   file:line\n   Failure: <failure_scenario>\n\`\`\`\n\n${output}`;
}

export function renderSkills(snapshot) {
  validateSnapshot(snapshot);
  const { review, output, fixes, simplify } = Object.fromEntries(Object.entries(snapshot.texts).map(([name, content]) => [name, content.text]));
  if (review.split(output).length !== 2) throw new Error("Official review must contain its selected output contract exactly once");
  // Match content extracted from the same package, not a hardcoded upstream sentence.
  const body = review.replace(output, renderOutput(output, snapshot.selection.maxFindings));
  const fixBody = fixes.replace(/^##[^\n]*(?:\n|$)/, "").trim().replace("The `--fix` flag was passed. ", "");
  return {
    "at-review": `---
name: at-review
description: "Review code changes for bugs, regressions, convention violations, and high-value cleanup opportunities. Use for diffs, commit ranges, hosted PR/MR URLs, branches, paths, staged changes, or working-tree changes."
argument-hint: "[--fix] [<pr-or-mr-url|branch|path>]"
---

# Code Review

${REVIEW_TARGET_GUIDANCE}

${compactMarkdownProse(portable(body))}

## Applying fixes (--fix)

Only apply anything when \`--fix\` was passed. Otherwise skip this entire section.

${portable(fixBody)}
`,
    "at-simplify": `---
name: at-simplify
description: "Refactor changed code to reduce duplication, complexity, and wasted work. Use for diffs, commit ranges, PRs, paths, staged changes, or working-tree changes."
argument-hint: "[<pr|branch|path>]"
---

# Simplify

${portable(simplify)}
`,
  };
}
