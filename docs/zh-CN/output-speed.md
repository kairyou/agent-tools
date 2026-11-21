# 估算输出速度

agent-tools 的 `tok/s` = 最近一次模型响应的输出 token 数 / 对应耗时(秒).
Token 数取自 Agent 的用量记录.

## 各 Agent 的计时口径

| Agent | 计时依据 |
| --- | --- |
| Claude Code | Claude Code 记录的累计 API 耗时的前后差值. |
| Codex | 日志中用户输入或工具结果到模型响应完成的时间. |
| Pi | 从收到首段输出到最后一段输出, 包括文本, 思考和工具参数. |
| OpenCode | 按文本和思考输出的首末时间计时. 含工具调用的回复不显示速度. |
| ZCode | 从首段输出计时到请求完成. |
| DeepSeek Harness | 底栏内置会话输出速度. |
| Copilot CLI | 通过请求 ID 匹配助手响应, 用请求总耗时减去首段输出等待时间. |
| Qwen Code | 匹配主 Agent 响应, 使用日志记录的生成耗时. |

Claude Code 通过响应 ID 和用量校验耗时是否只对应一次响应.
计时缺失或无法确认时, 改用用户输入或工具结果到响应完成的日志时间估算.

缺少有效的 token 用量或计时数据时, 不显示速度.
Codex 底栏和用量提示使用同一计时口径.
Paseo 在开启 `providerUsage.outputSpeed` 后, 根据对应的 Claude 或 Codex 会话日志估算.

## 为什么是估算

- API 计时包含请求等待; 日志计时还可能包含前置 hooks.
- 流式计时受网络缓冲, 分块和客户端收到事件的时间影响.

不同计时口径的数值不宜直接横向比较.
