# at-self-eval

Summarize a contributor's git history into a review-friendly self-evaluation for
performance cycles (quarterly, semi-annual, promotion). Not a coding workflow,
which is why it lives here rather than in the [README](../../README.md#skills).

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-self-eval -g -y
```

Usage:

- `/at-self-eval` — current git identity, current quarter
- `/at-self-eval [<author>] [--from yyyy-mm-dd] [--to yyyy-mm-dd]` — pick author and range
- Plain language works too: say "summarize the first half of the year" or "1-3
  月的产出" instead of writing flags
- Paste a daily/weekly log, or give a file path, to add business context (optional)
- Mention other repositories or branches to aggregate across projects; a remote
  URL prompts before cloning anything

Output is a draft: it never invents deliverables, and every line traces back to a
commit or to a log entry you confirmed. Review it before submitting.
