# Estimated output speed

`tok/s` shows the latest model response's output tokens divided by its elapsed seconds.
Token counts come from the agent's usage records.

## Timing by agent

| Agent | Timing source |
| --- | --- |
| Claude Code | The difference between successive cumulative API durations recorded by Claude Code. |
| Codex | Transcript timestamps from the preceding user input or tool result to model response completion. |
| Pi | Times the first through last output chunk, including text, thinking, and tool arguments. |
| OpenCode | Times the first through last text or reasoning output. Responses containing tool calls have no speed reading. |

Claude Code checks the response ID and token usage to confirm that the API duration covers only one response.
When timing is missing or cannot be matched, it uses transcript timestamps from the preceding user input or tool result to response completion.

Speed is hidden when usable token counts or timing are unavailable.

## Why it is an estimate

- API timing includes request waits; transcript timing can also include preceding hooks.
- Streaming measurements depend on network buffering, chunking, and when the client receives events.

Readings based on different timing methods are not directly comparable.
