# at-self-eval

把贡献者的 git 历史归纳成评审友好的自评产出清单, 用于季度/半年/晋升等绩效周期.
它不作用于代码, 所以放在这里而不是 [README](../../README.zh-CN.md#skills).

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-self-eval -g -y
```

用法:

- `/at-self-eval` — 默认当前 git 用户, 当前季度
- `/at-self-eval [<作者>] [--from yyyy-mm-dd] [--to yyyy-mm-dd]` — 指定作者与日期范围
- 在对话里直接说 `统计上半年的工作` / `统计 1-3月的产出` 即可, 无需手写参数
- 可粘贴日报/周报文本或提供文件路径, 补充业务背景(可选)
- 可提及其他仓库或分支以跨项目聚合; 远程地址会先询问是否 clone 到临时目录

输出是草稿: 不编造产出, 每条都能追溯到 commit 或你确认过的日志条目. 提交前请人工核对.
