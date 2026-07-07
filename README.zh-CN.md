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

Skills 用 `npx -y skills@latest` 安装（见上）。hooks 和 statusline **不会**被 plugin manifest
自动加载，因此由 `scripts/install.mjs`（Node，无依赖）写入各 agent 的配置。

能力（目前都全局，写入用户级配置）：

- **statusline** —— Claude Code 的 statusLine 脚本。
- **guard** —— 一个 `PreToolUse` hook，拦截一小份灾难性 shell 命令的 deny-list，
  涵盖 Unix（`rm -rf /`、fork bomb、`mkfs`、`dd` 写裸设备、`curl … | sh`）和
  Windows/PowerShell（`rm -rf C:\`、`Remove-Item -Recurse -Force C:\`、
  `del /s /q C:\`、`format C:`）。它是安全网、不是沙箱，出错时放行（fail open）。
  deny-list 只在 `hooks/common/guard-rules.mjs` 写一份，接到各 agent（Codex 用相同的
  PreToolUse stdin/stdout 契约；opencode 走插件）。

```bash
# Claude（默认）：所有能力写入 ~/.claude/settings.json
node scripts/install.mjs

# Codex：把 guard hook 写入 ~/.codex/hooks.json
node scripts/install.mjs -a codex

# opencode：把 guard 插件放进 ~/.config/opencode/plugin/
node scripts/install.mjs -a opencode

# 多个 agent 一起装
node scripts/install.mjs -a claude -a codex -a opencode

# 只装某一个能力
node scripts/install.mjs --only guard

# 预览而不落盘，或移除本安装器写入的内容
node scripts/install.mjs --dry-run
node scripts/install.mjs --uninstall
node scripts/install.mjs --only guard --uninstall
```

**Codex 信任步骤**：Codex 在你审核并信任之前不会运行新装的 hook —— 进 Codex 跑 `/hooks`
批准 agent-tooling guard（用户 hook 没有文件级预信任）。安装器在 Codex 安装后会打印该提示。

**opencode 重启**：opencode 在启动时加载插件，安装后需重启。安装器往
`~/.config/opencode/plugin/agent-tooling-guard.js` 写一个小的生成桩，用绝对 `file://` URL
re-export 仓库里的插件——opencode 通过正常插件扫描发现它，**不碰 `opencode.json`**，实现和
共享规则仍在仓库里单一真源（改仓库即时更新 guard）。

安装器只改自己拥有的键，用 `_agentTooling` 标记记录，`--uninstall` 时精确回退：它把
`guard` hook 追加在你已有的 hooks 旁边（卸载只删自己那份），替换 `statusLine` 前先备份
（覆盖陌生值需 `--force`）并可还原。`--settings <path>` 可指定非默认的 settings 文件。

**scope 按能力区分，不搞一刀切：**

- **statusLine 只装全局。** 它是个人 UI 偏好；项目级 `statusLine` 会被提交进共享的
  `.claude/settings.json`、强加给所有协作者。所以写入 `~/.claude/settings.json`。
- **Codex 暂时没有可脚本化的 statusLine。** 截至 Codex 0.142.x，`tui.status_line` 只能
  选择/排序内置字段（不能跑命令或模板），因此现在没有 Codex statusLine 脚本——顶多以后在
  `statusline/codex/` 放个 config 片段。命令式 statusLine 是 open request
  （[openai/codex#17827](https://github.com/openai/codex/issues/17827)），若落地，
  Codex 脚本可照 Claude 那套来。
- **hooks** 可以全局（如 `guard`），也可以项目级。项目级 hook 是项目专属自动化、可提交，
  且支持 `$CLAUDE_PROJECT_DIR` 做可移植的工程相对路径；等有这种 hook 时会重新引入该 scope。

当前已接线：

- **Claude** —— `statusLine` + `guard` PreToolUse hook，写入 `~/.claude/settings.json`。
- **Codex** —— `guard` hook，写入 `~/.codex/hooks.json`。Codex 把 shell 工具名归一化成
  `Bash`，且用与 Claude 相同的 PreToolUse stdin/deny 契约，所以同一份
  `hooks/common/guard-command.mjs` 两边共用；差别只在接线位置和 `/hooks` 信任步骤。
- **opencode** —— `guard`，作为插件桩放进 `~/.config/opencode/plugin/`。

三个 guard 共用一份 deny-list（`hooks/common/guard-rules.mjs`）：Claude 和 Codex 走
`guard-command.mjs` 的 stdin/stdout CLI，opencode 走 `hooks/opencode/guard.mjs` 插件。
只有 Claude 有可脚本化的 statusLine，所以 `--only statusline` 对 Codex 和 opencode 是 no-op。

## 说明

- `skills/` 放可复用的 `SKILL.md` 能力。项目可以只安装自己需要的 skills。
- `npx -y skills@latest` 可以通过扫描当前目录结构发现 skills。Plugin manifest 主要面向原生 plugin 生态，需要时应写显式 skill 路径。
- `hooks/` 和 `statusline/` 不会被 plugin manifest 自动加载。后续应由 `scripts/` 下的安装/同步脚本写入各 agent 期望的配置位置。
- 可复用 hook 业务逻辑放在 `hooks/common/`。Codex / Claude 专用的配置片段、接线逻辑和薄 wrapper 分别放在 `hooks/codex/` 与 `hooks/claude/`。
- **opencode，按能力区分：**
  - *Skills* —— **零接线**自动发现。opencode 读 `.claude/skills/`、`.agents/skills/`、
    `.opencode/skills/`（项目）以及 `~/.claude`、`~/.agents`、`~/.config/opencode`
    对应目录（全局）。把 skill 装进共享的 `.claude`/`.agents` 即可，不要为 opencode 复制一份。
  - *Hooks* —— opencode **不读** `settings.json`/`hooks.json`。它用 JS/TS **插件**系统
    （在 `tool.execute.before` 里 `throw` 来拦截）。guard 是 `hooks/opencode/guard.mjs`
    （复用共享的 `hooks/common/guard-rules.mjs`）；安装器往 `~/.config/opencode/plugin/`
    写一个 `.js` 生成桩 re-export 它，opencode 自动发现、**不改 `opencode.json`**。
    （注意：`tool.execute.before` 不拦截 subagent `task` 工具发起的调用，
    是已知缺口 opencode #5894。）
  - *Statusline* —— opencode 暂不支持（open request），无需接线。
