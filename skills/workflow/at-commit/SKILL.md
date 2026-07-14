---
name: at-commit
description: "Generate a Conventional Commits message from staged changes and wait for confirmation before committing. Use when the user asks to commit or generate a commit message."
argument-hint: "[<language>]"
---

# Commit Message Generator

## Workflow

1. Run `git diff --staged` to inspect staged changes. If it is empty, tell the user to run `git add` first and stop.
2. Determine the description language using the Language Policy below.
3. Generate a message using the rules below and show it for confirmation. Do not commit immediately. When useful, provide concrete candidate messages instead of only asking a question.
4. Run `git commit -m` only after the user explicitly confirms, for example with "commit" or "ok". Do not run `git push` unless the user explicitly asks.

## Language Policy

Use this priority order for the human-readable description after `type(scope):`:

1. Use the language explicitly requested by the user in this turn.
2. Otherwise use the repository preference in `.agent-tools/config.jsonc`, if it defines `at-commit.language`.
3. Otherwise use the global preference in `~/.agent-tools/config.jsonc`, if it defines `at-commit.language`.
4. Otherwise use the language of the user's actual invocation text when it contains a clear, independent natural-language request. Ignore injected skill instructions, quoted or pasted content, code blocks, diffs, and tool output.
5. Otherwise match the dominant language in recent repository commit subjects.
6. If no dominant language is clear, default to English.

Apply this order literally and stop at the first match. Check items 2 and 3 before item 4. A bare slash command or skill invocation has no language; continue to item 5. Inspect at most the latest 20 subjects.

Keep Conventional Commits syntax tokens untranslated: `type`, optional `scope`, `!`, and `BREAKING CHANGE`. Keep identifiers, file names, package names, commands, API names, and scopes in their original language.

## Persistent Language Preference

Do not write config during ordinary commit generation. If the user explicitly asks to remember a commit-description language, offer to persist it. Ask repo vs global when scope is ambiguous.

For repo preference, create or update `.agent-tools/config.jsonc`; for global preference, use `~/.agent-tools/config.jsonc`:

```jsonc
{
  "at-commit.language": "zh-CN"
}
```

Preserve unrelated keys and comments when practical. Do not require prior installer setup.

## Rules

Read `git diff --staged` and generate a Conventional Commits title that explains WHAT changed and, when useful, WHY.

- **Title**: `type(scope): description`, <= 74 characters, no trailing period, no prefix, no quotes, no code block.
- **type**: choose exactly one:
  - `feat` for a feature, `fix` for a bug fix
  - `refactor` for behavior-preserving restructuring, `perf` for performance
  - `docs` for documentation-only changes, `style` for formatting-only changes
  - `test` for adding or fixing tests, `build` for build systems or dependencies, `ci` for CI config/scripts
  - `chore` for miscellaneous changes that do not touch src/test, `revert` for reverts
- **scope**: optional affected module name. Use this repository's convention. In monorepos, use the app/package directory name. Omit it for cross-cutting changes or when unsure.
- **description**: one concise verb-object phrase in the selected natural language. Avoid filler equivalent to "update files", "this commit", "misc changes", or "several changes". Preserve identifiers, function names, file names, package names, commands, and APIs as written.
- **single line only**: commit messages always contain only the title line. Do not write a body or footer. Compress necessary WHY into the title.
- **breaking changes**: mark with `type(scope)!: description`, still as one line. Do not use a `BREAKING CHANGE` footer.
- **punctuation**: use ASCII punctuation.

## Generation Strategy

Before writing, identify the staged changes' through-line.

- **Main line**: include only the information needed to understand this commit. Do not pile on names unless one is the point of the change.
- **Significant changes**: scan for logic, contract, build, quality-gate, or user-visible behavior changes. Use that to choose `type` and decide whether `!` is needed.

## Content Discipline

The message must state confirmed code facts, not guessed intent.

- **Prefer behavior changes in `src` and `test`**: docs are supporting context only. Do not infer WHAT from docs alone.
- **User context beats docs**: explicit user goals can help choose WHY and wording, but WHAT and scope still come from the staged diff. Do not include context-only changes absent from the diff. If context and diff conflict, follow the diff and ask for confirmation.
- **Deletes and renames**: when purpose cannot be confirmed from code relationships, state only what the diff proves, such as "remove X" or "rename X to Y". Do not claim replacement, migration, or causality unless the code proves it.
- **Multiple changes with one goal**: provide one summary message when the changes clearly serve the same goal, such as a quality or build fix. Suggest splitting only when it would materially improve review or rollback.
- **Unrelated staged changes**: provide split messages for each coherent unit plus one conservative summary message. Let the user choose split or summary instead of deferring the summary to another turn.
- **Unclear ownership or intent**: list files that need confirmation instead of forcing a vague message. Prefer confirmation or splitting over weak words like "update", "adjust", or "tweak" when the intent is unclear.
