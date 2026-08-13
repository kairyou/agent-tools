---
name: at-usage
description: Query and display the current API provider balance and recent usage.
---

Run this installed local command once using the shell or command-execution tool:

```text
node "{{USAGE_CLI_PATH}}" --agent {{USAGE_AGENT}}
```

Return stdout verbatim as the complete response. Do not explain, reformat, or
wrap it in Markdown. If stdout is empty, say exactly `Provider usage is unavailable.`

Never run `npx`, `npm`, `pnpm`, `bun`, install a package, or substitute another
usage script. Use only the installed command above.
