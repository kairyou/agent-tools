# Agent Tools

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

- 用法: `/at-commit [<语言>]` — 指定 commit description 的语言(Conventional Commits 语法部分保持英文)

### at-review

审查改动中的正确性 bug, 回归风险, 约定违规和高价值清理项.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-review -g -y
```

- 用法: `/at-review [--fix] [<pr|分支|路径>]` — 输出审查结果; 加 `--fix` 则同时应用修复

### at-simplify

重构改动, 减少冗余, 降低复杂度, 提升代码质量.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-simplify -g -y
```

- 用法: `/at-simplify [<pr|分支|路径>]`

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

## Integrations

Runtime capability, 按 agent 选装:

```bash
npx -y @kairyou/agent-tools@latest <capability> -a <agent...>
```

`--dry-run` 预览, `--uninstall` 解除对应集成, 重新执行安装命令即为更新.
安装器只改动自己写入的配置项; 卸载会保留 `~/.agent-tools` 下的共享文件.

| Capability | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| `statusline` | ✓ | – | – |
| `usage` | `/at-usage` skill | hook + `$at-usage` skill | toast + `/at-usage` 命令 |
| `vision` | ✓ | ✓ | ✓ |

### Statusline

```bash
npx -y @kairyou/agent-tools@latest statusline -a claude
```

安装器会把 `statusLine` 写入 `~/.claude/settings.json`. 默认显示:

```text
⎇ main | Opus 4.8 | 5h 7% ⟳2h54m | w 41% ⟳3d1h
```

其中 `5h` / `w` 是 Claude 的滚动用量窗口, `⟳` 后面是重置倒计时.
使用兼容的 API 中转时, statusline 还会追加 provider usage.

如需控制显示项, 修改 `~/.agent-tools/config.jsonc` 里的
`statusline.fields`. 安装器更新时只会补充缺失的默认键, 不会动你的修改和注释.

### Provider usage

面向使用 API 中转的场景: 在 agent 内直接显示中转网关的余额/额度, 按量付费或
有套餐限额时, 随时知道花了多少, 还剩多少, 不用切出去登录网关后台.
支持 Sub2API, One API, New API 与 OpenRouter 提供的 API Key 用量接口.
具体兼容性取决于网关版本及其是否开放相应接口.

```bash
npx -y @kairyou/agent-tools@latest usage -a claude codex opencode
```

- **Claude Code** — 把 `at-usage` skill 装入 `~/.claude/skills`; 调用
  `/at-usage` 即可在对话中显示当前用量.
- **Codex** — 把 hook 添加到 `~/.codex/hooks.json` 的 `UserPromptSubmit` 和
  `Stop`, 并把 `at-usage` skill 装入 `~/.agents/skills`. 安装后在 Codex 里运行
  `/hooks` 批准一次. Codex CLI 会显示 hook 输出; 部分客户端(如 Paseo)目前不显示,
  可调用 `$at-usage` 按需查询.
- **OpenCode** — 添加 server plugin 和 TUI plugin: session 进入 idle 后自动刷新
  usage 并以 toast 显示, `/at-usage` 查看最新缓存值. 安装或更新后需要重启 opencode.

中转端点自动发现 — Codex: 读取 `~/.codex/config.toml` / `auth.json` 里当前
provider 的 `base_url` 和密钥; Claude Code: 读取 `ANTHROPIC_BASE_URL` 与
`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`. 官方(非中转)端点会被跳过.
如果结果是 `Provider usage is unavailable.`, 可用环境变量
`PROVIDER_USAGE_BASE_URL` / `PROVIDER_USAGE_API_KEY` 显式指定端点和密钥,
并在 `~/.agent-tools/config.jsonc` 里调整 `providerUsage`:

```jsonc
{
  "providerUsage": {
    "preset": "auto", // auto | sub2api | one-api | new-api | openrouter | <自定义 route id>
    "days": 30,       // 统计最近多少天的消耗
    "debug": false    // true: 探测过程写入 ~/.agent-tools/logs/usage-debug.log
  }
}
```

保持 `preset: "auto"` 即可自动探测. 只有明确知道网关开放的是哪种用量协议时,
才指定相应的内置 preset 或已配置的自定义 route id.

#### 自定义网关路由

内置探测覆盖不到的网关(比如 cookie 认证的中转), 可以自己写路由模块并在
`providerUsage.routes` 里声明(相对 `~/.agent-tools` 解析). 声明的路由优先
探测; `"preset"` 填路由 id 可直接选中.

```jsonc
{
  "providerUsage": {
    "routes": [
      "custom/my-gateway.mjs",
      "custom/another-gateway.mjs"
    ],
    "myGateway": { "username": "me", "password": "..." }
  }
}
```

```js
// ~/.agent-tools/custom/my-gateway.mjs
export const meta = { id: "my-gateway" }; // 可选; id 缺省用文件名

export async function run(context, { requestJson, agentConfig }) {
  // context: { baseUrl, key, providerName, provider, label }
  const { myGateway = {} } = await agentConfig(); // providerUsage 对象, 自定义键随意加

  // 建议: 把 token 存到文件里(如 ~/.agent-tools/cache 下)重复使用,
  // 用它查询失败(如 401)时才重新登录, 并把新 token 写回文件.
  const login = await fetch(`${context.baseUrl}/api/user/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: myGateway.username, password: myGateway.password }),
  });
  const session = await login.json();

  // 用 fetch 也行; 自定义 header: authorization, cookie 等.
  const me = await requestJson(`${context.baseUrl}/api/user/self`, {
    headers: { authorization: `Bearer ${session?.data?.accessToken}` },
  });
  return { text: `API | balance ¥${me?.data?.balance}` };
}
```

`text` 是自由字符串; 成功返回 `{ text }`, 抛错则回落到下一条路由
(开启 `providerUsage.debug` 后, 失败会记录到 `~/.agent-tools/logs/usage-debug.log`).

显示效果示例:

```text
# 中转套餐额度.
API | D $0.0/$100 | W $0.0/$300 | Exp 07-08

# 钱包余额.
API | balance $362 | today $61.7 | 30d $566
```

字段含义: `D/W/M` 是日/周/月套餐消耗与上限, `Exp` 是套餐到期日,
`balance` 是钱包余额, `today` / `30d` 是今日与近 30 天 API 消耗.

### Vision(跨模型识图)

让不支持图片的主模型借助多模态模型识图: 针对图片(本地路径或 http(s) URL)提出具体问题, 拿到答案后继续自己的推理. 常见场景: 读取报错截图, 按设计稿还原 UI, 定位测试反馈截图里的界面问题. 一个安装器 capability 包含三部分: `inspect_image` MCP stdio server, `at-vision` 策略 skill, 以及人工诊断 CLI.

#### 安装

```bash
npx -y @kairyou/agent-tools@latest vision -a claude codex opencode
```

卸载默认保留 vision provider 配置. 安装器会为每个 agent 注册 `inspect_image`
MCP server (Claude Code: `~/.claude.json`; Codex: `~/.codex/config.toml`;
OpenCode: `opencode.json`), 并把 `at-vision` skill 装入对应 agent 的 skills 目录.

#### 配置

`~/.agent-tools/config.jsonc` 是唯一配置入口:

```jsonc
{
  "vision": {
    "provider": "openai-compatible",       // 或 "anthropic-compatible"
    "baseUrl": "https://gateway.example.com/v1",  // anthropic-compatible 填网关根地址, 会自动拼 /v1/messages
    "model": "internal-vlm",
    "apiKey": { "env": "OPENAI_API_KEY" }  // 引用已有环境变量, 也可以直接填密钥
    // , "timeoutMs": 30000, "maxImageBytes": 20971520, "maxOutputTokens": 8192
    // , "maxConcurrentRequests": 2, "maxRequestsPerMinute": 30
  }
}
```

`apiKey` 可直接填密钥, 或用 `{ "env": "VARIABLE_NAME" }` 引用已有环境变量; 网关不需要密钥时可省略.
Provider 请求由 runtime 直接发送, API key 不进入 shell 命令; 对外错误会将 key 脱敏为 `***`. `maxConcurrentRequests` 和 `maxRequestsPerMinute` 在本机的 MCP/CLI 进程之间共享.
图片字节会无损地流式编码到 Provider 的 base64 JSON 请求中, 不做重压缩; URL 图片使用私有临时文件, 每次请求结束后自动删除.

#### 使用

在消息里给出图片的文件路径或 URL 即可. Agent 优先调用 MCP 的 `inspect_image`; 模型网关不支持 MCP namespace tools 时, 改用已安装的本地 vision CLI. 不要直接粘贴截图: 主模型不支持图片时, 粘贴会在到达工具前就报 API 400 — 保存成文件再给路径.

人工排查配置或测试识别质量时可用:

```bash
npx -y @kairyou/agent-tools@latest inspect-image <path|url> -q "导航栏的背景色和高度是多少"
```

## 从 Git 运行

如需直接使用仓库版本, 可将 npm 包名替换为 `github:kairyou/agent-tools` (本机需已安装 Git):

```bash
npx -y github:kairyou/agent-tools usage -a codex
```

## 仓库结构

```text
agent-tools/
├── .claude-plugin/    # Claude Code/plugin 生态的 manifest.
├── .codex-plugin/     # Codex plugin manifest.
├── integrations/      # 可安装的 capability, 一个一目录.
│   ├── statusline/    # Agent 状态栏: 分支, 模型, 用量.
│   ├── usage/         # Provider 余额/额度显示.
│   └── vision/        # 跨模型识图.
├── skills/            # 可复用的 Agent Skills.
│   ├── workflow/      # 工作流类 skills.
│   │   ├── at-commit/   # 生成 Conventional Commits message.
│   │   ├── at-review/   # 审查改动中的 bug 与回归风险.
│   │   └── at-simplify/ # 减少改动中的冗余和复杂度.
│   └── integrations/  # 对接外部系统的 skills.
│       └── at-zentao/   # 禅道 bug/task 修复工作流.
└── scripts/           # 安装, 同步, 校验和仓库维护脚本.
```

## FAQ

### 为什么全局安装提示 PromptScript 不支持?

`PromptScript does not support global skill installation` 表示 PromptScript Agent 不支持全局
安装, 不影响其他 Agent, 可忽略. 参见 [`skills` issue #1352](https://github.com/vercel-labs/skills/issues/1352).

## References

- [OpenCommit](https://github.com/di-sukharev/opencommit)
- [GitLens](https://github.com/gitkraken/vscode-gitlens)
- [claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts)
