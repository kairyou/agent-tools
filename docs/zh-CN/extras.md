# Extras

这里收录日常开发主流程之外的可选工具.

## at-self-eval

基于 Git 提交历史或你提供的工作日志生成绩效自评, 可用于季度总结, 半年总结及晋升材料撰写.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-self-eval -g -y
```

用法:

- `/at-self-eval` — 默认统计当前 Git 用户本季度的工作
- `/at-self-eval [<作者>] [--from yyyy-mm-dd] [--to yyyy-mm-dd]` — 指定作者与日期范围
- 在对话里直接说 `统计上半年的工作` / `统计1-3月的产出` 即可, 无需手写参数
- `/at-self-eval 统计 C:\projects\project-a 和 C:\projects\project-b 的 7 月工作` — 只统计指定项目
- `/at-self-eval 另外包含 C:\projects\project-c` — 在默认范围上追加
- 可粘贴日报或周报文本, 也可提供文件路径补充业务背景
- `/at-self-eval 只根据 C:\logs\daily-log.md 总结` — 只凭日志生成, 不读 Git

生成的结果请人工核对.

## at-daily-log

按天把各项目的 Git 提交提炼成工作日报.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-daily-log -g -y
```

用法:

- `/at-daily-log` — 输出今天的日报
- `/at-daily-log 2026-07-31` — 指定日期
- `/at-daily-log 上周` / `/at-daily-log 最近两周` — 按日期生成日报, 跳过没有 Git 提交的日期
- `/at-daily-log 统计 C:\projects\project-a 今天的工作` — 只统计指定项目
- `/at-daily-log 另外包含 C:\projects\project-c` — 在默认范围上追加
- `/at-daily-log 记录日报` — 记录到配置的文件; 同一天重复执行只更新生成的部分
- `/at-daily-log 记录到 C:\logs\daily-log.md` — 记录到指定文件
- `/at-daily-log 每天 18:00 自动记录` — 引导搭建系统定时任务; 当天没有 Git 提交时不写入日报

记录到文件的示例:

```markdown
+ 2026-08-03
<!-- daily-log:2026-08-03:start 5,a1b2c3d -->
  1. project-a: 完成登录模块重构, 覆盖回归用例.
  2. project-b: 修复导出报表的时区偏移.
<!-- daily-log:2026-08-03:end -->
```

`<!-- ... -->` 注释是边界标记: 更新只重写两个标记之间的内容, 文件里的其他部分
(比如你手写的备注)不会被碰.

搭配下方的 `log` 使用时, 排查问题这类没提交代码的工作也能进日报.
生成的结果请人工核对.

## log

按天把各项目的 AI 会话记录成工作日志, 安装后自动运行.

和上面的 `at-daily-log` 独立互补, 可一起使用或单独使用.

```bash
npx -y @kairyou/agent-tools@latest log -a claude codex opencode
```

- `format: "detailed"` (默认): 每天生成一份详细报告, 记录每轮请求与结果, 修改的文件, 以及新增/删除代码行数的估算
- `format: "daily"`: 写入单个 Markdown 文件, 并按日期归档; 每个已完成且有实质结果的回答记录为一行, 不记录未完成的提问; 内容可能因长度限制被截断, 因此仅适合作为轻量活动索引
- Codex 安装后运行 `/hooks` 批准一次; opencode 安装或更新后需要重启

`detailed` 输出示例(节选):

```markdown
# AI 日报 - 2026-08-03

## 今日概览

- 请求次数: 5
- 变更文件数: 3
- 总行变更: +120/-30

## 会话记录

- Time: 2026-08-03 10:12:01 -> 2026-08-03 10:20:45
- Project: project-a

Request
(请求原文摘录)

Outcome
(结果摘要)

Changes
- src/auth/session.ts | 变更 +42/-8 | 操作 3 次
```

`daily` 输出示例:

```markdown
+ 2026-08-03
<!-- log:2026-08-03:start -->
  1. project-a: 已定位登录超时的原因: 会话缓存在续期分支上没有更新过期时间, 第二次请求拿到的还是旧值. 已经在 session.ts 补上续期并本地验证通过, 接下来...
  2. project-a: 修复完成, 新增 3 个回归用例覆盖续期路径, 全部通过.
  3. project-b: 报表导出为空定位到权限过滤条件写反, 已修正并确认导出恢复正常.
<!-- log:2026-08-03:end -->
```

每轮一行, 直接摘录那一轮 AI 回复的收尾内容(过长会截断), 不做提炼也不跨轮归纳;
同样只重写标记之间的部分, 文件里的其他内容不会被碰.

## 配置

都在 `~/.agent-tools/config.jsonc`:

```jsonc
{
  // log capability: AI 会话日志
  "log": {
    "enabled": true,                // false: 临时停止记录, 不用卸载
    "output": "C:\\logs\\ai-log",     // detailed: 每天一个 <date>.md; daily: 单一文件
    "language": "zh",                 // zh | en
    "format": "detailed",             // detailed | daily
    "projects": [                     // 可选: 只记录这些目录, 条目可覆盖上面的键
      "C:\\projects\\project-a",
      { "path": "C:\\projects\\project-b", "format": "detailed", "output": "C:\\logs\\project-b" }
    ]
  },
  // at-self-eval, at-daily-log: 默认统计的项目(不配则只统计当前项目);
  // prompt: 该项目的提示词, 用来优化生成的日报和总结
  "workProjects": [
    "C:\\projects\\project-a",
    { "path": "C:\\projects\\project-b", "prompt": "输出里把 `phoenix` 称作 `商城App`, 跳过 `test:` 开头的提交" }
    // "C:\\projects\\temporarily-disabled"
  ],
  // at-daily-log: 记录日报的默认文件; 未提供日志时 at-self-eval 也读它作补充
  "dailyLog": {
    "output": "C:\\logs\\daily-log.md"
  }
}
```
