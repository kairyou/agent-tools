---
name: commit
description: "生成 Conventional Commits 风格的 commit message 供用户确认。Trigger on /commit 或用户要求提交/生成 commit message。"
---

# Commit Message 生成器

本文件是**唯一 source of truth**，各 agent（Claude / opencode / codex）通过各自的薄 shim 引用它。

<!--
References (background only; rules in this file are authoritative):
- OpenCommit
- GitLens generateCommitMessage
-->

## 流程

1. 跑 `git diff --staged` 看暂存改动；为空时提示「先 `git add`」并停止。
2. 按下方规则生成 message，**输出给用户确认**，不要直接提交；需要用户选择时直接给可选 message，不要只追问。
3. 仅当用户确认（如回复「提交」「ok」）后才执行 `git commit -m`。除非用户明确要求，不要 `git push`。

## 规则

读 `git diff --staged`，按 Conventional Commits 生成，讲清 WHAT 和 WHY。

- **标题** `type(scope): 描述`，全长 ≤ 74 字符，末尾不加句号，不要任何前缀/引号/代码块
- **type** 取最贴切的一个：
  - `feat` 新功能 · `fix` 修 bug
  - `refactor` 不改外部行为的重构（既非新功能也非修 bug）· `perf` 性能优化
  - `docs` 仅文档 · `style` 不影响语义的格式调整（空白/格式/分号等）
  - `test` 新增或修正测试 · `build` 构建系统或外部依赖变更 · `ci` CI 配置与脚本
  - `chore` 其它不动 src/test 的杂项 · `revert` 回滚先前 commit
- **scope**（可选）受影响的模块名，按本仓库约定取——monorepo 用 app/package 目录名；跨多个或拿不准时直接省略
- **描述必须用中文**：一句话动宾短语讲清「做了什么」，不写「修改了若干文件」「本次提交」「此次修改」这类空话；标识符（函数/文件/包名）保持英文
- **只出单行**：任何情况下 commit message 都只有标题一行，不写正文/footer；必要的 WHY 压进这一句里
- **Breaking change** 用 `type(scope)!: 描述` 的 `!` 标注，保持单行，不用 `BREAKING CHANGE` footer
- **标点** 用英文半角标点，不要全角 `，。：（）`

## 生成策略

落笔前先想清「这批改动解决什么问题 / 主线是什么」，再按上面格式写：

- **抓主线**：只写理解这次提交必需的信息，别堆文件名/函数名/配置名（除非它本身就是关键）。
- **扫显著变化**：有无逻辑、契约、构建、质量门禁或用户可见行为变化——据此选对 type，并判断是否用 `!` 标 breaking。

## 内容纪律（WHAT 从何而来）

以上是**格式**；下面管**内容真实性**——message 只陈述**已确认的代码事实**，不猜意图、不靠文档脑补：

- **以 `src`/`test` 的行为改动为主**：docs 只作辅助背景，**不能用 docs 推断 WHAT**（文档常超前/滞后于代码）。
- **对话上下文优于文档**：最近用户 prompt 里**明示**的目标可用来定 WHY、选更贴切措辞（如「修复全量 check/typecheck」）；但 WHAT/scope 仍以 staged diff 为准——上下文提到而 diff 未体现的不写进 message，二者冲突时以 diff 为准并提示确认。
- **删除 / 重命名类 diff**：无法从代码调用关系确认目的时，只客观陈述（`删除 X` / `X 重命名为 Y`），**不写「替代 / 迁移到 / 改为」这类强因果**。
- **多改动点但同一目标**（如一次代码质量/构建修复）→ 直接给一条汇总 message；拆分仅在能显著改善 review/回滚时作为可选建议附后，不默认阻断。
- **明显混入多个彼此独立的功能/修复目标** → 一次给全：各单元的拆分 message + 一条保守汇总 message，让用户直接选拆分或汇总，别把汇总留到下一轮；仅当整体 WHAT 无法客观概括才只列单元、不硬凑。
- **混入不确定归属/意图的改动**（并行落入、看不出为何改）→ 输出**「这些文件需确认归属/意图」**，而非硬凑 message；不确定时慎用「整理 / 调整」这类含糊词，优先请用户确认或拆分。
