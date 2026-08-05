---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Keep `.rn-agent` real and worktree-local while inheriting only `.rn-agent/actions` through consented setup and repository-local post-checkout integration. SessionStart is report-only, and recognized legacy root links migrate without copying mutable integration or session state.
