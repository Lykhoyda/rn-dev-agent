---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Keep `.rn-agent` real and worktree-local by inheriting only `.rn-agent/actions` through consented setup and repository-local post-checkout integration, keeping SessionStart report-only, and migrating recognized legacy root links without copying mutable integration or session state.
