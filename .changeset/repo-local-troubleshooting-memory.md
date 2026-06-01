---
"rn-dev-agent-plugin": minor
---

Replace the Experience Engine with a repo-local troubleshooting memory.

`/rn-agent-compact`, `/rn-agent-health`, `/rn-agent-export`, and `/rn-agent-import`
are removed (GH #200: compaction had no runnable entry point and the read path was
vestigial). In their place, rn-dev-agent now maintains a gitignored
`.rn-agent/local/troubleshooting.md` per repo: failures are captured by a hook,
the agent synthesizes them into the doc at session end, and the doc is injected at
session start so the agent learns this repo's config and gotchas.
