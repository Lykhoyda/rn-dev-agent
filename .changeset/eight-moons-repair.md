---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Strict proof capture now anchors `docs/proof` at the Git worktree root while keeping `projectRoot` bound to the session app root, so nested React Native app layouts can be proven.
