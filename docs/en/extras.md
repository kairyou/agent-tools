# Extras

Fully usable, just situational. Install each on demand.

## at-self-eval

Summarize a contributor's git history into a review-friendly self-evaluation for
performance cycles (quarterly, semi-annual, promotion).

```bash
npx -y skills@latest add kairyou/agent-tools --skill at-self-eval -g -y
```

Usage:

- `/at-self-eval` — current git identity, current quarter
- `/at-self-eval [<author>] [--from yyyy-mm-dd] [--to yyyy-mm-dd]` — pick author and range
- Plain language works too: say "summarize the first half of the year" instead of writing flags
- Paste a daily/weekly log, or give a file path, to add business context (optional)
- Mention other repositories or branches to aggregate across projects; a remote
  URL prompts before cloning anything

Output is a draft: it never invents deliverables, and every line traces back to a
commit or to a log entry you confirmed. Review it before submitting.
