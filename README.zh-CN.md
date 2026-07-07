# Agent Tooling

面向 Codex、Claude Code 与 opencode 的可复用 agent 工具集。本仓库集中维护 skills、guard hooks、statusline 支持与安装脚本；不同项目可以只安装或同步自己需要的部分。

## 目录结构

```text
agent-tooling/
├── .claude-plugin/    # Claude Code/plugin 生态的 manifest。
├── .codex-plugin/     # Codex plugin manifest。
├── hooks/             # Hook 脚本和配置片段，区分通用逻辑与 agent 接线。
│   ├── common/        # 跨 agent 通用逻辑：guard-rules.mjs + guard-command.mjs（Claude/Codex CLI）。
│   ├── opencode/      # opencode 插件接线（guard.mjs），复用 common/ 规则。
│   ├── claude/        # Claude Code hook 素材（接线由安装器生成进 settings.json）。
│   └── codex/         # Codex hook 素材（接线由安装器生成进 hooks.json）。
├── scripts/           # 安装、同步、校验和仓库维护脚本。
├── skills/            # 可复用 Agent Skills，供 CLI 扫描和 plugin manifest 声明。
│   └── workflow/      # 工作流类 skills。
│       └── commit/    # Conventional Commit message skill。
└── statusline/        # Statusline 配置片段/模板，按 agent 分组。
    ├── claude/        # Claude command-backed statusLine 脚本。
    └── codex/         # Codex tui.status_line 片段（仅内置字段，无脚本）。
```

## 当前 Skills

- `commit`：根据暂存区改动生成 Conventional Commits message，并在提交前等待用户确认。

## 使用方式

查看可用 skills：

```bash
npx -y skills@latest add kairyou/agent-tooling --list
```

全局安装 `commit` skill 到 Codex：

```bash
npx -y skills@latest add kairyou/agent-tooling -g -a codex --skill commit -y
```

如果是项目级安装，且安装结果可能提交到 Git，优先使用 `--copy`，不要提交 symlink：

```bash
npx -y skills@latest add kairyou/agent-tooling --copy -a codex --skill commit -y
```

## 安装 hooks 与 statusline

Skills 用 `npx -y skills@latest` 安装（见上）。hooks 和 statusline 需要单独用
`scripts/install.mjs` 接到各 agent 的配置里，因为 plugin manifest 不会自动加载它们。

```bash
# Claude（默认）：statusLine + guard
node scripts/install.mjs

# Codex：guard
node scripts/install.mjs -a codex

# opencode：guard plugin
node scripts/install.mjs -a opencode

# 多个 agent 一起安装
node scripts/install.mjs -a claude -a codex -a opencode

# 只装某个能力、预览或卸载
node scripts/install.mjs --only guard
node scripts/install.mjs --dry-run
node scripts/install.mjs --uninstall
```

已接线能力：

- **Claude** —— `statusLine` + `guard` PreToolUse hook，写入 `~/.claude/settings.json`。
- **Codex** —— `guard` hook，写入 `~/.codex/hooks.json`。
- **opencode** —— `guard`，作为插件桩放进 `~/.config/opencode/plugin/`。

`guard` hook 会拦截一小份灾难性 shell 命令的 deny-list。它是安全网，不是沙箱；出错时会放行。

安装 Codex hook 后，需要在 Codex 里运行 `/hooks` 并批准 agent-tooling guard。安装
opencode plugin 后，需要重启 opencode。

## 说明

- `skills/` 放可复用的 `SKILL.md` 能力。项目可以只安装自己需要的 skills。
- `hooks/common/` 放共享 guard 逻辑；各 agent 的接线放在 `hooks/<agent>/`。
- `statusline/claude/` 放 Claude command-backed statusLine 脚本。
- 安装器只标记并移除自己写入的配置项。
- `package.json` 保持 private 是有意的；本仓库从 GitHub 安装，不发布到 npm。
