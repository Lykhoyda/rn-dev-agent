---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

A second session in the same worktree now stays connected read-only, refusing calls with `SAME_ROOT_OWNER_LIVE` naming the owner, and takes over in place once that owner exits, instead of failing with `Connection closed` until a restart.
