# Extras

Fully usable, just situational. Install each on demand.

## at-self-eval

Summarize git history, a work log you provide, or both into a self-evaluation
for performance cycles (quarterly, semi-annual, promotion).

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-self-eval -g -y
```

Usage:

- `/at-self-eval` — the current Git user's work this quarter
- `/at-self-eval [<author>] [--from yyyy-mm-dd] [--to yyyy-mm-dd]` — pick author and range
- Plain language works too: say "summarize the first half of the year" instead of writing flags
- `/at-self-eval summarize July for C:\projects\project-a and C:\projects\project-b` — only those projects
- `/at-self-eval also include C:\projects\project-c` — add to the default scope
- Paste a daily/weekly log, or give a file path, to add business context
- `/at-self-eval summarize from C:\projects\daily-log.md only` — log only, Git is not read

Review the generated result before use.

## at-daily-log

Summarize the day's Git activity across projects into a daily work log.

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-daily-log -g -y
```

Usage:

- `/at-daily-log` — print today's log
- `/at-daily-log 2026-07-31` — pick the date
- `/at-daily-log summarize today for C:\projects\project-a` — only that project
- `/at-daily-log also include C:\projects\project-c` — add to the default scope
- `/at-daily-log record the log` — record to the configured file; rerunning a day only refreshes the generated part
- `/at-daily-log record it to C:\projects\daily-log.md` — record to that file
- `/at-daily-log record every workday at 18:00` — guides you through an OS scheduled task

Review the generated result before use.

## Optional configuration

All in `~/.agent-tools/config.jsonc`:

```jsonc
{
  // at-self-eval, at-daily-log: default projects (otherwise just the current repo)
  "workProjects": [
    "C:\\projects\\project-a",
    "C:\\projects\\project-b"
    // "C:\\projects\\temporarily-disabled"
  ],
  // at-daily-log: default file when asked to record; at-self-eval also reads it as fallback
  "dailyLog": {
    "output": "C:\\projects\\daily-log.md"
  }
}
```
