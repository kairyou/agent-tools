# Agent Tools

[English](README.md)

适用于兼容 coding agent 的可复用 Agent Skills, 以及按 Agent 适配的 runtime capabilities: statusline, provider usage, 跨模型识图与 session log.

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

用法:

- `/at-commit [<语言>]` — 指定 commit description 的语言(Conventional Commits 语法部分保持英文)

### at-review

审查本地改动或托管的 PR/MR 中的正确性 bug, 回归风险, 约定违规和高价值清理项.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-review -g -y
```

用法:

- `/at-review [--fix] [<PR/MR-URL|分支|路径>]` — 输出审查结果; 私有托管目标需要本地已有只读访问权限, `--fix` 仅对匹配的工作树应用修复

### at-simplify

重构改动, 减少冗余, 降低复杂度, 提升代码质量.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-simplify -g -y
```

用法:

- `/at-simplify [<pr|分支|路径>]`

### at-zentao

读取禅道 bug/task 并端到端处理, 管理任务状态和工时, 或补充关联 story 上下文; 提交和回写前均需确认.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-zentao -g -y
```

用法:

- `/at-zentao bugs` — 列出指派给你(配置的账号)的 bug, 挑一个或多个(多个 = 批量模式)
- `/at-zentao tasks` — 同上, 任务清单
- `/at-zentao bug <id>` — 直接处理指定 bug
- `/at-zentao task <id> [请求]` — 处理指定 task, 用自然语言开始/暂停/继续或记录工时
- `/at-zentao story <id>` — 只读查看研发需求范围和验收信息

配置 `~/.agent-tools/config.jsonc`:

```jsonc
{
  "zentao": {
    "url": "https://zentao.example.com",
    "account": "user",
    "password": "your-password",
    // "password": { "env": "ZENTAO_PASSWORD" }, // 或者从环境变量读取密码.
    // 可选. 不配置时, 字段标签默认跟随条目或用户的语言.
    // "commentPrompt": "修复 Bug 时使用中文, 按以下格式回写:\n原因: ...\n修复: ...\n影响范围: ...\n测试建议: ...\nCommit: <hash>\n每项简短, 影响范围和测试建议无实质内容时省略. 使用真实提交号."
  }
}
```

## Capabilities

Runtime capability, 按 agent 选装:

```bash
npx -y @kairyou/agent-tools@latest <capability> -a <agent...>
# npx -y github:kairyou/agent-tools <capability> -a <agent...>  # 或用 GitHub 上的最新代码(需 Git)
```

`--dry-run` 预览, `--uninstall` 移除对应 capability, 重新执行安装命令即为更新.
更新 `config.jsonc` 时只补充缺失的默认值, 保留已有值和注释.

| Runtime capability | 支持的 Agent |
| --- | --- |
| `statusline` | Claude Code |
| `usage` | Claude Code, Codex, OpenCode, Pi |
| `vision` | Claude Code, Codex, OpenCode, Pi, ZCode, DeepSeek Harness |
| `log` | Claude Code, Codex, OpenCode, Pi |

### Statusline

```bash
npx -y @kairyou/agent-tools@latest statusline -a claude
```

安装器会把 `statusLine` 写入 `~/.claude/settings.json`. 显示效果:

```text
# 官方订阅:
⎇ main | Opus 4.8 | 5h 7% ⟳ 2h54m | w 41% ⟳ 3d1h

# 中转 API:
⎇ main | Opus 4.8 | balance $362 | today $61.7 | 30d $566
```

`5h` / `w`: Claude 的 5小时 / 7天滚动用量窗口; `⟳`: 重置倒计时.

在 `~/.agent-tools/config.jsonc` 的 `statusline.fields` 中设置显示项及顺序;
加入 `"outputSpeed"` 可显示估算输出速度 (如 `38.2 tok/s`).

中转网关用量的支持范围与配置见 [Provider usage](#provider-usage).

### Provider usage

在 agent 内查看 API 中转网关的余额和额度. 支持 Sub2API, One API (包括 OneHub
与 DoneHub), New API, Claude Code Hub, OpenRouter 和 Command Code. 具体兼容性
取决于网关版本及其是否开放相应接口.

```bash
npx -y @kairyou/agent-tools@latest usage -a claude codex opencode pi
```

- **Claude Code** — `/at-usage` 在对话中查询; 安装 `statusline` 后也会自动追加到状态栏.
  设置 `statusline.showProviderUsage: false` 可隐藏状态栏的中转网关用量.
- **Codex** — 安装后运行 `/hooks` 批准一次. Codex CLI 会自动显示用量;
  不显示 hook 输出的客户端可调用 `$at-usage` 查询.
- **OpenCode** — 空闲时自动刷新并以 toast 显示, 也可调用 `/at-usage` 查询.
  安装或更新后需要重启 opencode.
- **Pi** — 在底栏显示用量. 安装或更新后重启 Pi 或运行 `/reload`.

自动从 Agent 当前模型或已有配置获取端点和密钥, 跳过官方端点.
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

#### 自定义网关路由

内置探测覆盖不到的网关可以通过自定义路由接入, 详见
[自定义网关路由](docs/zh-CN/custom-gateway-routes.md).

### Vision(跨模型识图)

让不支持图片的主模型借助多模态模型识图, 适用于读取报错截图, 按设计稿还原 UI, 定位测试反馈截图里的界面问题.

#### 安装

```bash
npx -y @kairyou/agent-tools@latest vision -a claude codex opencode pi zcode dsh
```

卸载时默认保留 vision provider 配置.

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

在消息里给出本地图片路径或 URL 即可. 主模型不支持图片时, 请先保存图片,
再提供文件路径, 不要直接粘贴.

人工排查配置或测试识别质量时可用:

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
