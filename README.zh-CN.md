# Agent Tools

[English](README.md)

可复用的 Agent Skills, 以及面向 Codex, Claude Code 与 opencode 的可安装 integrations: statusline, provider usage 与跨模型识图.

需要 Node.js >= 22.

## Skills

### 安装

```bash
# 查看可用 skills
npx -y skills@latest add kairyou/agent-tools --list

# 全局安装(--skill 后面可以跟一个或多个名字)
npx -y skills@latest add kairyou/agent-tools --skill <name...> -g -y
```

### at-commit

根据暂存区改动生成 Conventional Commits message, 并在提交前等待用户确认.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-commit -g -y
```

用法:

- `/at-commit [<语言>]` — 指定 commit description 的语言(Conventional Commits 语法部分保持英文)

### at-review

审查改动中的正确性 bug, 回归风险, 约定违规和高价值清理项.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-review -g -y
```

用法:

- `/at-review [--fix] [<pr|分支|路径>]` — 输出审查结果; 加 `--fix` 则同时应用修复

### at-simplify

重构改动, 减少冗余, 降低复杂度, 提升代码质量.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-simplify -g -y
```

用法:

- `/at-simplify [<pr|分支|路径>]`

### at-zentao

读取禅道 bug/task 并端到端处理: 修复, 验证, 暂存; 提交和回写状态前均需确认.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-zentao -g -y
```

用法:

- `/at-zentao bugs` — 列出指派给你(配置的账号)的 bug, 挑一个或多个(多个 = 批量模式)
- `/at-zentao tasks` — 同上, 任务清单
- `/at-zentao bug <id>` — 直接处理指定 bug
- `/at-zentao task <id>` — 直接处理指定 task

配置: `~/.agent-tools/config.jsonc` → `"zentao": { "url", "account", "password" }`. 首次使用会引导; `password` 自己填进文件(或设环境变量 `ZENTAO_PASSWORD`), 不要发在对话里.

不作用于代码: [at-self-eval](docs/zh-CN/at-self-eval.md) 把 git 历史归纳成绩效自评草稿.

## Integrations

Runtime capability, 按 agent 选装:

```bash
npx -y @kairyou/agent-tools@latest <capability> -a <agent...>
```

`--dry-run` 预览, `--uninstall` 解除对应集成, 重新执行安装命令即为更新.
安装器只改动自己写入的配置项, 更新 `config.jsonc` 时只补充缺失的默认键,
不会动你的修改和注释.

| Capability | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| `statusline` | ✓ | – | – |
| `usage` | `/at-usage` skill | hook + `$at-usage` skill | toast + `/at-usage` 命令 |
| `vision` | ✓ | ✓ | ✓ |

### Statusline

```bash
npx -y @kairyou/agent-tools@latest statusline -a claude
```

安装器会把 `statusLine` 写入 `~/.claude/settings.json`. 输出示例:

```text
# 显示项与顺序由 ~/.agent-tools/config.jsonc 的 statusline.fields 控制:
⎇ main | Opus 4.8 | 5h 7% ⟳2h54m | w 41% ⟳3d1h

# 使用兼容的 API 中转时, 也会显示中转额度:
⎇ main | Opus 4.8 | balance $362 | today $61.7 | 30d $566

```

其中 `5h` / `w` 是 Claude 的滚动用量窗口, `⟳` 后面是重置倒计时;
中转额度信息的兼容性与配置见下方 [Provider usage](#provider-usage).

### Provider usage

在 agent 内查看 API 中转网关的余额和额度. 支持 Sub2API, One API (包括 OneHub
与 DoneHub), New API, Claude Code Hub 和 OpenRouter. 具体兼容性取决于网关版本
及其是否开放相应接口.

```bash
npx -y @kairyou/agent-tools@latest usage -a claude codex opencode
```

- **Claude Code** — 调用 `/at-usage` 在对话中查看当前用量.
- **Codex** — 安装后运行 `/hooks` 批准一次. Codex CLI 会自动显示用量;
  不显示 hook 输出的客户端可调用 `$at-usage` 查询.
- **OpenCode** — 空闲时自动刷新并以 toast 显示, 也可调用 `/at-usage` 查询.
  安装或更新后需要重启 opencode.

默认会从 Codex 和 Claude Code 的现有配置中自动发现中转端点, 并跳过官方端点.
如果结果是 `Provider usage is unavailable.`, 可用
`PROVIDER_USAGE_BASE_URL` / `PROVIDER_USAGE_API_KEY` 显式指定端点和密钥.
需要调整探测方式时, 在 `~/.agent-tools/config.jsonc` 中配置 `providerUsage`:

```jsonc
{
  "providerUsage": {
    // auto | sub2api | openai-compatible | one-api | one-hub |
    // done-hub | new-api | claude-code-hub | openrouter | <自定义 route id>
    "preset": "auto",
    "days": 30,       // 统计最近多少天的消耗
    "debug": false    // true: 探测过程写入 ~/.agent-tools/logs/usage-debug.log
  }
}
```

保持 `preset: "auto"` 即可自动探测. 只有明确知道网关开放的是哪种用量协议时,
才指定相应的内置 preset 或已配置的自定义 route id.

显示效果示例:

```text
# 套餐限额 (sub2api / openai-compatible).
D $0.0/$100 | W $0.0/$300 ⟳3d1h | Exp 07-08

# 多窗口限额 (claude-code-hub).
5h $2.1/$10.0 | D $8.0/$20.0 | T $19.0/$100 | Exp 08-31

# 余额与用量 (one-api / one-hub / done-hub / new-api / openrouter).
balance $15.0 | used $5.0/$20.0 | ⟳3d1h

# 钱包与近期消耗 (sub2api).
balance $362 | today $61.7 | 30d $566
```

字段含义: `5h/D/W/M/T` 是 5 小时/日/周/月/总消耗与上限, `⟳` 后面是已知限额的
重置倒计时, `Exp` 是套餐到期日, `balance` 是钱包余额, `used` 是已用额度,
`today` / `30d` 是今日与近 30 天 API 消耗. 只有网关返回的信息足以可靠确定
重置时间时才会显示倒计时.

#### 自定义网关路由

内置探测覆盖不到的网关可以通过自定义路由接入, 详见
[自定义网关路由](docs/zh-CN/custom-gateway-routes.md).

### Vision(跨模型识图)

让不支持图片的主模型借助多模态模型识图, 适用于读取报错截图, 按设计稿还原 UI, 定位测试反馈截图里的界面问题.

#### 安装

```bash
npx -y @kairyou/agent-tools@latest vision -a claude codex opencode
```

卸载时默认保留 vision provider 配置.

#### 配置

`~/.agent-tools/config.jsonc` 是唯一配置入口:

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

`apiKey` 可以直接填写密钥字符串, 例如 `"apiKey": "sk-..."`; 也可以使用 `{ "env": "OPENAI_API_KEY" }` 从环境变量读取. 网关不需要密钥时可以省略. 建议优先使用环境变量, 避免把密钥写入配置文件.

#### 使用

在消息里给出本地图片路径或 URL 即可. 主模型不支持图片时, 请先保存图片,
再提供文件路径, 不要直接粘贴.

人工排查配置或测试识别质量时可用:

```bash
npx -y @kairyou/agent-tools@latest inspect-image <path|url> -q "导航栏的背景色和高度是多少"
```

## 从 Git 运行

如需直接使用仓库版本, 可将 npm 包名替换为 `github:kairyou/agent-tools` (本机需已安装 Git):

```bash
npx -y github:kairyou/agent-tools usage -a codex
```

贡献者可参考[仓库结构](docs/zh-CN/repository-structure.md).

## FAQ

### 为什么全局安装提示 PromptScript 不支持?

`PromptScript does not support global skill installation` 表示 PromptScript Agent 不支持全局
安装, 不影响其他 Agent, 可忽略. 参见 [`skills` issue #1352](https://github.com/vercel-labs/skills/issues/1352).

## 参考与致谢

- `at-commit` 借鉴了 [OpenCommit](https://github.com/di-sukharev/opencommit) 和
  [GitLens](https://github.com/gitkraken/vscode-gitlens) 的提交消息生成思路,
  并针对 Agent Skill 工作流重新实现.
- `at-review` 和 `at-simplify` 参考了
  [claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts)
  中对应工作流的设计.
