# Agent Tools

面向 Codex、Claude Code 与 opencode 的可复用 skills 和 runtime integrations. 本仓库把各项能力放在可预期的位置; 不同项目可以只安装自己需要的部分.

## 目录结构

```text
agent-tools/
├── .claude-plugin/    # Claude Code/plugin 生态的 manifest。
├── .codex-plugin/     # Codex plugin manifest。
├── hooks/             # 通用 hook 逻辑及各 agent 的适配实现。
├── plugins/           # 由各 agent 加载的 runtime plugins.
├── scripts/           # 安装、同步、校验和仓库维护脚本。
├── skills/            # 可复用 Agent Skills，供 CLI 扫描和 plugin manifest 声明。
│   ├── workflow/      # 工作流类 skills。
│   │   ├── at-commit/   # 生成 Conventional Commits message.
│   │   ├── at-review/   # 审查改动中的 bug 与回归风险.
│   │   └── at-simplify/ # 减少改动中的冗余和复杂度.
│   └── integrations/  # 对接外部系统的 skills。
│       └── zentao/      # 禅道 bug/task 修复工作流.
├── statusline/        # Statusline 配置片段/模板，按 agent 分组。
│   └── claude/        # Claude command-backed statusLine 脚本和示例配置。
└── lib/               # hooks、statusline、installer 复用的共享实现。
```

## 当前 Skills

### at-commit

根据暂存区改动生成 Conventional Commits message, 并在提交前等待用户确认.

- 用法: `/at-commit [<语言>]` — 指定 commit description 的语言(Conventional Commits 语法部分保持英文)

### at-review

审查改动中的正确性 bug, 回归风险, 约定违规和高价值清理项.

- 用法: `/at-review [--fix] [<pr|分支|路径>]` — 输出审查结果; 加 `--fix` 则同时应用修复

### at-simplify

重构改动, 减少冗余, 降低复杂度, 提升代码质量.

- 用法: `/at-simplify [<pr|分支|路径>]`

### zentao

读取禅道 bug/task 并端到端处理: 修复, 验证, 暂存; 提交和回写状态前均需确认.

用法:

- `/zentao bugs` — 列出指派给你(配置的账号)的 bug, 挑一个或多个(多个 = 批量模式)
- `/zentao tasks` — 同上, 任务清单
- `/zentao bug <id>` — 直接处理指定 bug
- `/zentao task <id>` — 直接处理指定 task

配置: `~/.agent-tools/config.jsonc` → `"zentao": { "url", "account", "password" }`. 首次使用会引导; `password` 自己填进文件(或设环境变量 `ZENTAO_PASSWORD`), 不要发在对话里.

## 使用方式

查看可用 skills：

```bash
npx -y skills@latest add kairyou/agent-tools --list
```

全局安装 skill：

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-commit -g -y
npx -y skills@latest add kairyou/agent-tools --skill at-review -g -y
npx -y skills@latest add kairyou/agent-tools --skill at-simplify -g -y
npx -y skills@latest add kairyou/agent-tools --skill zentao -g -y
```

多个 skill 可以跟在 `--skill` 后面，例如 `--skill at-commit at-review at-simplify`。

## Runtime integrations

### Claude Code

#### Statusline

```bash
# 安装或更新
npx -y @kairyou/agent-tools@latest statusline -a claude

# 预览或卸载
npx -y @kairyou/agent-tools@latest statusline -a claude --dry-run
npx -y @kairyou/agent-tools@latest statusline -a claude --uninstall
```

安装器会把 `statusLine` 写入 `~/.claude/settings.json`. 默认显示:

```text
⎇ main | Opus 4.8 | 5h 7% ⟳2h54m | w 41% ⟳3d1h
```

其中 `5h` / `w` 是 Claude 的滚动用量窗口, `⟳` 后面是重置倒计时.
使用兼容的 API 中转时, statusline 还会追加 provider usage.

如需控制显示项, 修改 `~/.agent-tools/config.jsonc` 里的
`statusline.fields`. 安装器更新时可能补充新的默认键; 文件顶部注释和已有值会保留.

### Codex

#### Provider usage hook

```bash
# 安装或更新
npx -y @kairyou/agent-tools@latest usage -a codex

# 预览或卸载
npx -y @kairyou/agent-tools@latest usage -a codex --dry-run
npx -y @kairyou/agent-tools@latest usage -a codex --uninstall
```

安装器会把 hook 添加到 `~/.codex/hooks.json` 的 `UserPromptSubmit` 和
`Stop`. 安装后, 在 Codex 里运行 `/hooks` 并批准 agent-tools usage hooks.

显示效果示例:

```text
# 订阅/套餐额度.
warning: API | D $0.0/$100 | W $0.0/$300 | Exp 07-08

# 钱包余额.
warning: API | balance $362 | today $61.7 | 30d $566
```

字段含义: `D/W/M` 是日/周/月套餐消耗与上限, `Exp` 是套餐到期日,
`balance` 是钱包余额, `today` / `30d` 是今日与近 30 天 API 消耗.

### OpenCode

#### Provider usage plugin

```bash
# 安装或更新
npx -y @kairyou/agent-tools@latest usage -a opencode

# 预览或卸载
npx -y @kairyou/agent-tools@latest usage -a opencode --dry-run
npx -y @kairyou/agent-tools@latest usage -a opencode --uninstall
```

安装器会添加全局 server plugin 和 TUI plugin. 当前 session 进入 idle 后, server
plugin 会刷新 usage 并通过 toast 显示; TUI plugin 还会注册 `/at-usage`, 用于查看最新
缓存值. 安装或更新 plugin 后需要重启 opencode.

显示效果示例:

```text
Provider usage
balance $244 | today $45.8 | 30d $604
```

### 支持的网关

余额, 额度和套餐用量查询支持兼容 Sub2API-like,
NewAPI/OneAPI/OneHub/DoneHub/Veloera/AnyRouter-like 与 OpenRouter 的网关.

### 从 Git 运行

如需直接使用仓库版本，可将 npm 包名替换为 `github:kairyou/agent-tools`（本机需已安装 Git）：

```bash
npx -y github:kairyou/agent-tools usage -a codex
```

## FAQ

### 为什么全局安装提示 PromptScript 不支持？

`PromptScript does not support global skill installation` 表示 PromptScript Agent 不支持全局
安装，不影响其他 Agent，可忽略。参见 [`skills` issue #1352](https://github.com/vercel-labs/skills/issues/1352)。

## References

- [OpenCommit](https://github.com/di-sukharev/opencommit)
- [GitLens](https://github.com/gitkraken/vscode-gitlens)
- [claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts)

## 说明

- 安装器只标记并移除自己写入的配置项。
- 本地检查运行 `npm test`。
