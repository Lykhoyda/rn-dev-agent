---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

Document the one-source-owner-per-worktree and one-exact-device-target-per-session authority bounds in the workflow skill, with pointers from the CLAUDE.md template and other workflow skills (GH #1026). Source ownership is the worktree/checkout, not only the app package root: a sibling app root in the same checkout is also blocked, and separate linked worktrees are independent copies. A session holds one `(platform, deviceId, appId)` target at a time and replaces it after runner, proof, any explicitly started Observe, and any active recorder are released and no incompatible install receipt is bound. Authoritative cross-target `cross_platform_verify` is currently unsupported.
