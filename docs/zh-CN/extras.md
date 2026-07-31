# Extras

完整可用, 只是场景较窄. 按需单独安装.

## at-self-eval

把贡献者的 git 历史归纳成评审友好的自评产出清单, 用于季度/半年/晋升等绩效周期.

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
- `/at-self-eval 只根据 C:\projects\todo.md 总结` — 只凭日志生成, 不读 Git

生成的结果请人工核对.

## at-daily-log

汇总一天内各项目的 Git 活动, 生成工作日报.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-daily-log -g -y
```

用法:

- `/at-daily-log` — 输出今天的日报
- `/at-daily-log 2026-07-31` — 指定日期
- `/at-daily-log 统计 C:\projects\project-a 今天的工作` — 只统计指定项目
- `/at-daily-log 另外包含 C:\projects\project-c` — 在默认范围上追加
- `/at-daily-log 记录日报` — 记录到配置的文件; 同一天重复执行只更新生成的部分
- `/at-daily-log 记录到 C:\projects\todo.md` — 记录到指定文件
- `/at-daily-log 每个工作日 18:00 自动记录` — 引导搭建系统定时任务

生成的结果请人工核对.

## 可选配置

都在 `~/.agent-tools/config.jsonc`:

```jsonc
{
  // at-self-eval, at-daily-log: 默认统计的项目(不配则只统计当前项目)
  "workProjects": [
    "C:\\projects\\project-a",
    "C:\\projects\\project-b"
    // "C:\\projects\\temporarily-disabled"
  ],
  // at-daily-log: 记录日报的默认文件; 未提供日志时 at-self-eval 也读它作补充
  "dailyLog": {
    "output": "C:\\projects\\todo.md"
  }
}
```
