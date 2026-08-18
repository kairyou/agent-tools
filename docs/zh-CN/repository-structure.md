# 仓库结构

```text
agent-tools/
├── .claude-plugin/    # Claude Code/plugin 生态的 manifest.
├── .codex-plugin/     # Codex plugin manifest.
├── capabilities/      # Runtime capabilities, 一个一目录.
│   ├── statusline/    # Agent 状态栏: 分支, 模型, 用量.
│   ├── usage/         # Provider 余额/额度显示.
│   └── vision/        # 跨模型识图.
├── skills/            # 可复用的 Agent Skills.
│   ├── workflow/      # 工作流类 skills.
│   │   ├── at-commit/   # 生成 Conventional Commits message.
│   │   ├── at-review/   # 审查本地或托管改动中的 bug 与回归风险.
│   │   └── at-simplify/ # 减少改动中的冗余和复杂度.
│   └── systems/       # 面向外部系统的自包含 Skills.
│       └── at-zentao/   # 自包含的禅道研发事项与任务生命周期工作流.
├── docs/              # 高级指南和贡献者参考.
├── tools/             # 仅供维护者使用的上游同步和仓库工具.
└── scripts/           # 安装, 同步, 校验和仓库维护脚本.
```
