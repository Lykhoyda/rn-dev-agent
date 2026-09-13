---
"rn-dev-agent-plugin": patch
---

Document the one-source-owner-per-copy and one-device-target-per-session authority bounds in the workflow skill, with pointers from the CLAUDE.md template (GH #1026). A session replaces its target; it does not hold two. `cross_platform_verify` does not import another session's snapshots.
