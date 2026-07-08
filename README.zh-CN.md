# Agent Tooling

面向 Codex、Claude Code 与 opencode 的可复用 agent 工具集。本仓库集中维护 skills、hooks、statusline 支持与安装脚本；不同项目可以只安装或同步自己需要的部分。

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
├── statusline/        # Statusline 配置片段/模板，按 agent 分组。
│   └── claude/        # Claude command-backed statusLine 脚本和示例配置。
└── usage/             # 共享 API usage 运行时，供 Codex hook 与 Claude statusLine 使用。
```

## 当前 Skills

- `commit`：根据暂存区改动生成 Conventional Commits message，并在提交前等待用户确认。

## 使用方式

查看可用 skills：

```bash
npx -y skills@latest add kairyou/agent-tooling --list
```

全局安装 skill：

```bash
npx -y skills@latest add kairyou/agent-tooling --skill commit -g -y
```

项目级安装：

```bash
# 如果安装结果可能提交到 Git，优先使用 --copy，不要提交 symlink。
npx -y skills@latest add kairyou/agent-tooling --skill commit --copy -y
```

多个 skill 可以跟在 `--skill` 后面，例如 `--skill commit other-skill`。

## 安装 hooks 与 statusline

用仓库内置安装器安装 hooks 与 statusline：

```bash
# Claude：statusLine + guard
npx -y github:kairyou/agent-tooling statusline guard -a claude

# Codex：guard + API usage
npx -y github:kairyou/agent-tooling guard usage -a codex

# opencode：guard plugin
npx -y github:kairyou/agent-tooling guard -a opencode

# 多个 agent 一起安装
npx -y github:kairyou/agent-tooling guard -a claude codex opencode

# 预览或卸载
npx -y github:kairyou/agent-tooling guard usage -a codex --dry-run
npx -y github:kairyou/agent-tooling guard usage -a codex --uninstall
```

安装器会把运行时脚本复制到 `~/.agent-tooling/`，然后让各 agent 配置指向这里。

已接线能力：

- **Claude** —— `statusLine` + `guard` PreToolUse hook，写入 `~/.claude/settings.json`。
- **Codex** —— `guard` hook 与 `usage` hook，写入 `~/.codex/hooks.json`。
- **opencode** —— `guard`，作为插件桩放进 `~/.config/opencode/plugin/`。

`guard` hook 会拦截一小份灾难性 shell 命令的 deny-list。
`usage` 会显示兼容 Sub2API-like、NewAPI/OneAPI/OneHub/DoneHub/
Veloera/AnyRouter-like 与 OpenRouter 网关的余额、额度或套餐用量；Codex 通过 hook
显示，Claude statusLine 在使用兼容中转时会自动追加。

显示效果示例：

```text
# 订阅/套餐额度。
warning: API | D $0.0/$100 | W $0.0/$300 | Exp 07-08

# 钱包余额。
warning: API | balance $362 | today $61.7 | 30d $566
```

字段含义：`D/W/M` 是日/周/月套餐消耗与上限，`Exp` 是套餐到期日，
`balance` 是钱包余额，`today` / `30d` 是今日与近 30 天 API 消耗。

安装 Codex hook 后，需要在 Codex 里运行 `/hooks` 并批准 agent-tooling hooks。安装
opencode plugin 后，需要重启 opencode。

Claude statusLine 默认显示：

```text
⎇ main | Opus 4.8 | 5h 7% ⟳2h54m | w 41% ⟳3d1h
```

其中 `5h` / `w` 是 Claude 的滚动用量窗口，`⟳` 后面是重置倒计时。

如需控制显示项，直接修改 `~/.agent-tooling/config.jsonc` 里的 `statusline.fields`。
安装器更新时可能会补充新的默认键；文件顶部注释和已有值会保留。

## 说明

- `skills/` 放可复用的 `SKILL.md` 能力。项目可以只安装自己需要的 skills。
- `hooks/common/` 放共享 guard 逻辑；各 agent 的接线放在 `hooks/<agent>/`。
- `statusline/claude/` 放 Claude command-backed statusLine 脚本。
- `usage/` 放共享 API usage 查询逻辑。
- 安装器只标记并移除自己写入的配置项。

本地检查运行 `npm test`。
