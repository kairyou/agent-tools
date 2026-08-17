export const UPSTREAM_REPOSITORY = "Piebald-AI/tweakcc";

export const SKILLS = {
  "at-review": {
    target: "skills/workflow/at-review/SKILL.md",
    includedPromptIds: [
      "agent-prompt-code-review-part-7-high-effort-mode",
      "skill-code-review-phase-0-gather-diff",
      "skill-code-review-correctness-finder-angles",
      "skill-code-review-efficiency",
      "skill-code-review-altitude",
      "skill-code-review-conventions",
      "skill-code-review-phase-2-verify-recall-biased",
      "agent-prompt-code-review-part-5-recall-biased-verification-phase",
      "skill-code-review-output-findings-json-array",
      "agent-prompt-code-review-part-9-fix-application",
    ],
  },
  "at-simplify": {
    target: "skills/workflow/at-simplify/SKILL.md",
    includedPromptIds: [
      "agent-prompt-simplify-slash-command",
      "skill-code-review-phase-0-gather-diff",
      "skill-code-review-efficiency",
      "skill-code-review-altitude",
    ],
  },
};

export const ALL_PROMPT_IDS = [
  ...new Set(
    Object.values(SKILLS).flatMap(({ includedPromptIds }) => includedPromptIds)
  ),
].sort();
