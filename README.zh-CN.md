# Agent Tools

[English](README.md)

为编程 Agent 提供可复用 Skills, 以及状态栏, 网关用量, 跨模型识图和会话日志.

需要 Node.js >= 22.

## Skills

### 安装

```bash
# 查看可用 skills
npx -y skills@latest add kairyou/agent-tools --list

# 全局安装(--skill 后面可以跟一个或多个名字)
npx -y skills@latest add kairyou/agent-tools --skill <name...> -g -y
```

Skills installer 会自动检测并安装到大多数受支持 Agent 的 Skills 目录.

### at-commit

根据暂存区改动生成 Conventional Commits message, 并在提交前等待用户确认.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-commit -g -y
```

用 `/at-commit [<语言>]` 指定提交标题中冒号后文字的语言.

### at-review

审查本地改动或托管的 PR/MR, 查找 bug, 回归风险和约定违规.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-review -g -y
```

`/at-review [--fix] [<PR/MR-URL|分支|路径>]`. 私有 PR/MR 需有读取权限. `--fix` 仅修复匹配的工作树.

### at-simplify

简化改动中的代码, 减少冗余和复杂度.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-simplify -g -y
```

`/at-simplify [<pr|分支|路径>]`

### at-zentao

处理禅道 Bug, 任务和工时, 查询关联需求. 提交和回写前需确认.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-zentao -g -y
```

- `/at-zentao bugs` / `/at-zentao tasks` — 查看指派给你的列表, 支持批量处理.
- `/at-zentao bug <id> [请求]` — 处理指定 Bug, 也可加 `只分析原因` 等请求.
- `/at-zentao task <id> [请求]` — 用自然语言开始/暂停/继续任务或记录工时.
- `/at-zentao story <id>` — 只读查看需求和验收信息.

配置 `~/.agent-tools/config.jsonc`:

```jsonc
{
  "zentao": {
    "url": "https://zentao.example.com",
    "account": "user",
    "password": "your-password",
    // "password": { "env": "ZENTAO_PASSWORD" }, // 或者从环境变量读取密码.
    // "commentPrompt": "已修复的 Bug 用中文回写:\n原因: ...\n修复: ...\n影响: ...\nCommit: <实际提交号>\n无实质影响时省略影响字段."
  }
}
```

## 运行时功能

按 Agent 选装的运行时功能:

```bash
npx -y @kairyou/agent-tools@latest <capability> -a <agent...>
# npx -y github:kairyou/agent-tools <capability> -a <agent...>  # 或用 GitHub 上的最新代码(需 Git)
```

| 功能 | 安装项 | Agent (`-a`) |
| --- | :---: | --- |
| Claude Code CLI 状态栏 | `statusline` | `claude` |
| 网关用量 | `usage` | `claude`, `codex`, `opencode`, `pi`, `zcode`, `dsh` (DeepSeek Harness), `paseo`, `copilot`, `qwen` |
| 跨模型识图 | `vision` | `claude`, `codex`, `opencode`, `pi`, `zcode`, `dsh` |
| 会话工作日志 | `log` | `claude`, `codex`, `opencode`, `pi`, `zcode`, `dsh` |

### 状态与用量

#### Claude Code

| 使用界面 | 安装命令 |
| --- | --- |
| CLI 底栏 (含网关用量) | `npx -y @kairyou/agent-tools@latest statusline -a claude` |
| Claude Desktop (本地 Code 会话) | `npx -y @kairyou/agent-tools@latest usage -a claude` |
| 两边都用 | `npx -y @kairyou/agent-tools@latest statusline usage -a claude` |

Desktop 新会话中, 点击输入框上方的用量看详情 (需内置 Claude Code 2.1.286+).

CLI 安装会写入 `~/.claude/settings.json` 的 `statusLine`.

```text
# 官方订阅:
⎇ main | Opus 4.8 | 5h 7% ⟳ 2h54m | w 41% ⟳ 3d1h

# 中转 API:
⎇ main | Opus 4.8 | balance $362 | today $61.7 | 30d $566
```

`5h` / `w` 是 5 小时 / 7 天滚动用量, `⟳` 是重置倒计时.

在 `~/.agent-tools/config.jsonc` 中, CLI 用 `statusline.fields` 排列字段,
用 `statusline.showProviderUsage: false` 隐藏网关用量.

要显示估算输出速度 (`tok/s`), CLI 在 `statusline.fields` 中加 `"outputSpeed"`,
Desktop 将 `providerUsage.outputSpeed` 设为 `true`.

#### 网关用量

在 Agent 内查看网关余额和用量. 本节的网关配置也适用于 Claude.
内置路由包括 Sub2API, One API (包括 OneHub 与 DoneHub), New API, Claude Code Hub,
OpenRouter 和 Command Code. 具体兼容性取决于网关版本及其开放的用量接口.

```bash
npx -y @kairyou/agent-tools@latest usage -a codex
```

- **Codex CLI** — 0.171.0 起优先在底栏显示. 如有提示, 在 `/hooks` 中批准用量通知. 可用 `$at-usage` 查询.
- **ChatGPT 桌面端** — 本地 Codex 会话右侧 **+ → More tools → Agent Tools usage**. 若无法访问 `web-sandbox.oaiusercontent.com`, 用 `$at-usage` 查网关用量.
- **OpenCode** — 会话空闲时弹出用量提示, 也可用 `/at-usage` 查询.
- **Pi** — 在底栏显示用量.
- **ZCode** — 桌面版底栏显示网关用量, 可选显示 `tok/s`.
- **DeepSeek Harness** — 底栏显示网关用量, 也可用 `/at-usage` 查询.
- **Paseo** — 启用插件后, 新开或重载 Claude / Codex 会话. 点击输入框上方的用量查看详情.
- **Copilot CLI** — 在原生底栏项旁显示网关用量, 可选显示 `tok/s`.
- **Qwen Code** — 按用户设置中唯一的模型显示名匹配网关用量, 底栏也可显示 `tok/s`.

安装或更新后重启 Agent, Pi 也可运行 `/reload`.

自动从 Agent 当前模型或已有配置获取端点和密钥. 直连 OpenAI 或 Anthropic 时跳过网关查询.
如果结果是 `Provider usage is unavailable.`, 可用
`PROVIDER_USAGE_BASE_URL` / `PROVIDER_USAGE_API_KEY` 显式指定端点和密钥.
需要调整探测方式时, 在 `~/.agent-tools/config.jsonc` 中配置 `providerUsage`:

```jsonc
{
  "providerUsage": {
    // auto | sub2api | openai-compatible | one-api | one-hub |
    // done-hub | new-api | claude-code-hub | openrouter | commandcode | <自定义 route id>
    "preset": "auto", // 自动探测, 也可指定上面列出的协议
    "days": 30,       // 统计最近多少天的消耗
    "outputSpeed": false, // true: 显示估算输出速度 (tok/s)
    "debug": false    // true: 探测过程写入 ~/.agent-tools/logs/usage-debug.log
  }
}
```

显示效果示例:

```text
# 套餐限额:
D $0.0/$100 | W $0.0/$300 ⟳ 3d1h | Exp 07-08

# 多窗口限额:
5h $2.1/$10.0 | D $8.0/$20.0 | T $19.0/$100 | Exp 08-31

# 余额与用量:
balance $15.0 | used $5.0/$20.0 | ⟳ 3d1h

# 钱包与近期消耗:
balance $362 | today $61.7 | 30d $566
```

字段含义: `5h/D/W/M/T` 是 5 小时/日/周/月/总消耗与上限, `⟳` 后面是已知限额的
重置倒计时, `Exp` 是套餐到期日, `balance` 是钱包余额, `used` 是已用额度,
`today` / `30d` 是今日与近 30 天 API 消耗. 重置倒计时需要网关提供计时数据.

##### 自定义网关路由

内置探测覆盖不到的网关可以通过自定义路由接入, 详见
[自定义网关路由](docs/zh-CN/custom-gateway-routes.md).

### Vision(跨模型识图)

让主模型借助多模态模型读截图和设计稿.

#### 安装

```bash
npx -y @kairyou/agent-tools@latest vision -a claude
```

#### 配置

在 `~/.agent-tools/config.jsonc` 中配置 `vision`:

```jsonc
{
  "vision": {
    "provider": "openai-compatible",       // 或 "anthropic-compatible"
    "baseUrl": "https://gateway.example.com/v1",  // anthropic-compatible 填网关根地址, 会自动拼 /v1/messages
    "model": "internal-vlm",
    "apiKey": { "env": "OPENAI_API_KEY" }  // 从环境变量 OPENAI_API_KEY 读取
    // , "timeoutMs": 30000, "maxImageBytes": 20971520, "maxOutputTokens": 8192
    // , "maxConcurrentRequests": 2, "maxRequestsPerMinute": 30
  }
}
```

`apiKey` 可填密钥字符串, 或按上例引用环境变量. 网关不需要密钥时可省略.

#### 使用

在消息里给出图片路径或 URL. 也可用 CLI 测试识图效果.

```bash
npx -y @kairyou/agent-tools@latest inspect-image <path|url> -q "导航栏的背景色和高度是多少"
```

## 更多工具与文档

- [工作辅助工具](docs/zh-CN/extras.md) — 工作日报, 会话日志, 绩效自评.
- [输出速度统计](docs/zh-CN/output-speed.md)
- [仓库结构](docs/zh-CN/repository-structure.md)

## FAQ

### 为什么安装 skills 时提示 PromptScript 不支持?

`PromptScript does not support global skill installation` 只针对 PromptScript,
不影响其他 Agent 的安装. 参见 [`skills` issue #1352](https://github.com/vercel-labs/skills/issues/1352).

### 无法访问 GitHub 时如何安装 skills?

在 Bash 中从 npm 包安装 (`at-commit` 换成你要装的 skill):

```bash
cd "$(mktemp -d)" && tar -xf "$(npm pack @kairyou/agent-tools --silent)" && npx -y skills@latest add ./package --skill at-commit -g -y
```

## 参考与致谢

- `at-commit` 借鉴了 [OpenCommit](https://github.com/di-sukharev/opencommit) 和
  [GitLens](https://github.com/gitkraken/vscode-gitlens) 的提交消息生成思路,
  并针对 Agent Skill 工作流重新实现.
- `at-review` 和 `at-simplify` 基于 Claude Code 内置的 `code-review` 和
  `simplify` 工作流提示词整理并适配为可安装的 Agent Skill.
  上游提示词的同步方式见[同步流程](tools/claude-skill-sync/README.md).
