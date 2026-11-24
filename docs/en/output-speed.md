# Estimated output speed

agent-tools reports `tok/s` as the latest model response's output tokens divided by its elapsed seconds.
Token counts come from the agent's usage records.

## Timing by agent

| Agent | Timing source |
| --- | --- |
| Claude Code CLI | The difference between successive cumulative API durations recorded by Claude Code. |
| Claude Desktop | Elapsed time for one model request in a local Code session. |
| Codex | Transcript timestamps from the preceding user input or tool result to model response completion. |
| Pi | Times the first through last output chunk, including text, thinking, and tool arguments. |
| OpenCode | Times the first through last text or reasoning output. Responses containing tool calls have no speed reading. |
| ZCode | From first output to request completion. |
| DeepSeek Harness | Built-in session output speed in the footer. |
| Copilot CLI | Request duration minus the time to first output, matched to the assistant response by API call ID. |
| Qwen Code | Generation time recorded for the matching main-agent response. |

To enable `tok/s`, see [Claude Code setup](../../README.md#claude-code).

Claude Code CLI checks the response ID and token usage to confirm that the API duration covers only one response.
When timing is missing or cannot be matched, it uses transcript timestamps from the preceding user input or tool result to response completion.

Speed is hidden when usable token counts or timing are unavailable.
The Codex CLI footer and usage notices use the same timing as the usage panel in the ChatGPT desktop app.
Paseo uses the corresponding Claude or Codex transcript when `providerUsage.outputSpeed` is enabled.

## Why it is an estimate

- API timing includes request waits; transcript timing can also include preceding hooks.
- Streaming measurements depend on network buffering, chunking, and when the client receives events.

Readings based on different timing methods are not directly comparable.
