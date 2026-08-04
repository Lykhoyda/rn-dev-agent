---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

The learned-action inventory now dedupes roots by resolved identity and reports the worktree-local spelling, so an inherited corpus is counted once and never prints its canonical private source path.
