---
"rn-dev-agent-plugin": patch
---

SessionStart hook links `.rn-agent` from the main checkout when running in a git worktree, so learned actions, e2e config, and troubleshooting notes stay available (previously they silently disappeared in worktrees).
