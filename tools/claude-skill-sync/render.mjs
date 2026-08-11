import { promptMap, reconstructPrompt, sha256 } from "./lib.mjs";
import {
  LOCAL_FRAGMENTS,
  PROJECT_INSTRUCTIONS_SECTION,
  applyTextRule,
} from "./rules.mjs";

const REUSE_GUIDANCE = LOCAL_FRAGMENTS.reuseGuidance.text;
const SIMPLIFICATION_BLOCK = LOCAL_FRAGMENTS.simplificationBlock.text;
const REVIEW_TARGET_GUIDANCE = `If the argument is a hosted pull/merge request URL or a numeric PR/MR identifier,
read \`references/review-targets.md\` from this skill directory before running
commands. Follow its read-only resolution and authentication fallback rules;
do not switch the user's working tree or write to the hosting service.`;

export const LOCAL_LOCKED_HASHES = {
  reuse: sha256(REUSE_GUIDANCE),
  simplification: sha256(SIMPLIFICATION_BLOCK),
};

function requirePrompt(prompts, id) {
  const prompt = prompts.get(id);
  if (!prompt) throw new Error(`Snapshot does not contain ${id}`);
  return reconstructPrompt(prompt).trim();
}

function replaceOnce(text, from, to, label) {
  const first = text.indexOf(from);
  if (first < 0 || text.indexOf(from, first + from.length) >= 0) {
    throw new Error(`Patch ${label} expected exactly one match`);
  }
  return `${text.slice(0, first)}${to}${text.slice(first + from.length)}`;
}

function compactMarkdownProse(text) {
  return text
    .split(/\n{2,}/)
    .map((block) => {
      if (/^(?:#|```|\[|`[^`]+`$)/.test(block)) return block;
      return block.replace(/\n/g, " ");
    })
    .join("\n\n");
}

function cleanupBlock(prompts, reviewMode) {
  const reuse = reviewMode
    ? `### Reuse

The angles above hunt for bugs; this one and the next two hunt for cleanup in
the changed code. ${REUSE_GUIDANCE}`
    : `### Reuse

${REUSE_GUIDANCE}`;
  const efficiency = requirePrompt(prompts, "skill-code-review-efficiency");
  const altitude = requirePrompt(prompts, "skill-code-review-altitude");
  return [reuse, SIMPLIFICATION_BLOCK, efficiency, altitude].join("\n\n");
}

function renderOutput(prompts) {
  let output = requirePrompt(prompts, "skill-code-review-output-findings-json-array")
    .replaceAll("${MAX_FINDINGS}", "10")
    .replace("${REPORT_FINDINGS_TOOL_NAME}", "host-specific findings-reporting");
  output = applyTextRule(output, "at-review/output-heading");
  output = applyTextRule(output, "at-review/output-json-mode");
  output = applyTextRule(output, "at-review/output-portability");
  return `## Output\n\nUnless \`--json\` was explicitly passed, the main agent's final answer is a Markdown report, nothing else. Structure it exactly:\n\n**Summary** - 1-2 sentences on the review scope and what was found. If the diff was empty, write exactly "No changes to review." and stop. If nothing survived verification, write exactly "No findings survived verification." and stop.\n\n**Findings** - one numbered block per finding, most-severe first, at most 10. Assign each finding \`High\`, \`Medium\`, or \`Low\` from its concrete impact and likelihood:\n\n\`\`\`text\n1. High|Medium|Low: summary\n   file:line\n   Failure: <failure_scenario>\n\`\`\`\n\n${output}`;
}

function renderVerify(prompts) {
  return requirePrompt(prompts, "skill-code-review-phase-2-verify-recall-biased")
    .replace("${AGENT_TOOL_NAME}", "Agent")
    .replace(
      "${RECALL_BIASED_RUBRIC}",
      requirePrompt(prompts, "agent-prompt-code-review-part-5-recall-biased-verification-phase")
    );
}

function renderFix(prompts) {
  let text = requirePrompt(prompts, "agent-prompt-code-review-part-9-fix-application");
  const conditionalStart = text.indexOf("${HAS_REPORT_FINDINGS_TOOL?");
  if (conditionalStart < 0) throw new Error("Upstream fix prompt conditional changed");
  text = `${text.slice(0, conditionalStart)}Finish with a brief summary of what was fixed\nand what was skipped.`;
  return applyTextRule(text, "at-review/fix-guard");
}

function renderReviewGatherDiff(prompts) {
  const phase = requirePrompt(prompts, "skill-code-review-phase-0-gather-diff");
  return replaceOnce(
    phase,
    "## Phase 0 — Gather the diff\n\n",
    `## Phase 0 — Gather the diff\n\n${REVIEW_TARGET_GUIDANCE}\n\n`,
    "at-review/review-target-guidance"
  );
}

function renderReview(snapshot) {
  const prompts = promptMap(snapshot);
  let body = requirePrompt(prompts, "agent-prompt-code-review-part-7-high-effort-mode");
  const conventions = requirePrompt(prompts, "skill-code-review-conventions");
  const cleanup = [
    cleanupBlock(prompts, true),
    conventions,
    "Cleanup, altitude, and conventions candidates use the same\n`file`/`line`/`summary` shape; in `failure_scenario`, state the concrete\ncost (what is duplicated, wasted, harder to maintain, or which CLAUDE.md rule\nis broken) instead of a crash. Correctness bugs always outrank cleanup,\naltitude, and conventions findings when the output cap forces a cut.",
  ].join("\n\n");
  body = body
    .replace("${DIFF_GATHERING_PHASE}", `${renderReviewGatherDiff(prompts)}\n`)
    .replace("${AGENT_TOOL_NAME}", "Agent")
    .replace("${AGENT_UNAVAILABLE_INSTRUCTIONS}", "")
    .replace(
      "${BASE_FINDER_ANGLES_BLOCK}",
      `${requirePrompt(prompts, "skill-code-review-correctness-finder-angles")}\n`
    )
    .replace("${CLEANUP_AND_ALTITUDE_CANDIDATES_NOTE}", `${cleanup}\n`)
    .replace("${RECALL_BIASED_VERIFY_PHASE}", `${renderVerify(prompts)}\n`)
    .replace("${OUTPUT_FORMAT_FN(10)}", renderOutput(prompts));
  if (body.includes("${")) throw new Error("Unresolved variable in at-review upstream composition");
  body = applyTextRule(body, "at-review/agent-tool");
  body = replaceOnce(
    body,
    conventions,
    PROJECT_INSTRUCTIONS_SECTION,
    "at-review/project-instructions"
  );
  body = body.replaceAll("which CLAUDE.md rule", "which project instruction");
  body = applyTextRule(body, "shared/powershell-upstream");
  body = body.replace("`failure_scenario`. \n\n", "`failure_scenario`.\n\n");
  body = compactMarkdownProse(body);
  return `---
name: at-review
description: "Review code changes for bugs, regressions, convention violations, and high-value cleanup opportunities. Use for diffs, commit ranges, hosted PR/MR URLs, branches, paths, staged changes, or working-tree changes."
argument-hint: "[--fix] [<pr-or-mr-url|branch|path>]"
---

# Code Review

${body.trim()}

${renderFix(prompts)}
`;
}

function renderSimplify(snapshot) {
  const prompts = promptMap(snapshot);
  let body = requirePrompt(prompts, "agent-prompt-simplify-slash-command")
    .replace("${DIFF_GATHERING_PHASE}", `${requirePrompt(prompts, "skill-code-review-phase-0-gather-diff")}\n`)
    .replace("${AGENT_TOOL_NAME}", "Agent")
    .replace("${REUSE_FINDER_ANGLE_BLOCK}", `${REUSE_GUIDANCE}\n`)
    .replace("${SIMPLIFICATION_FINDER_ANGLE_BLOCK}", `${SIMPLIFICATION_BLOCK}\n`)
    .replace(
      "${EFFICIENCY_FINDER_ANGLE_BLOCK}",
      `${requirePrompt(prompts, "skill-code-review-efficiency")}\n`
    )
    .replace("${ALTITUDE_FINDER_ANGLE_BLOCK}", `${requirePrompt(prompts, "skill-code-review-altitude")}\n`);
  if (body.includes("${")) throw new Error("Unresolved variable in at-simplify upstream composition");
  body = applyTextRule(body, "at-simplify/agent-tool");
  body = body.replace("`/simplify", "`at-simplify").replace("`/code-review`", "`at-review`");
  body = applyTextRule(body, "shared/powershell-upstream");
  return `---
name: at-simplify
description: "Refactor changed code to reduce duplication, complexity, and wasted work. Use for diffs, commit ranges, PRs, paths, staged changes, or working-tree changes."
argument-hint: "[<pr|branch|path>]"
---

# Simplify

${body.trim()}
`;
}

export function renderSkills(snapshot) {
  return {
    "at-review": renderReview(snapshot),
    "at-simplify": renderSimplify(snapshot),
  };
}
