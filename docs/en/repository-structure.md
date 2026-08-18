# Repository structure

```text
agent-tools/
├── .claude-plugin/    # Claude Code/plugin ecosystem manifest.
├── .codex-plugin/     # Codex plugin manifest.
├── capabilities/      # Runtime capabilities, one directory each.
│   ├── statusline/    # Agent status line: branch, model, usage.
│   ├── usage/         # Provider balance / quota display.
│   └── vision/        # Cross-model image understanding.
├── skills/            # Reusable Agent Skills.
│   ├── workflow/      # Workflow-oriented skills.
│   │   ├── at-commit/   # Conventional Commit message skill.
│   │   ├── at-review/   # Review local or hosted changes for bugs and regressions.
│   │   └── at-simplify/ # Reduce complexity and duplication in changes.
│   └── systems/       # Self-contained Skills for external systems.
│       └── at-zentao/   # Self-contained ZenTao development and task-lifecycle workflow.
├── docs/              # Advanced guides and contributor reference.
├── tools/             # Maintainer-only upstream sync and repository tooling.
└── scripts/           # Install, sync, validation, and maintenance scripts.
```
