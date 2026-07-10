---
'rn-dev-agent-plugin': patch
---

Fix #476: `/setup` now recognizes symlink-inherited git worktrees as already onboarded. Step A short-circuits when `.rn-agent` is a symlink or the manual marker lives in `CLAUDE.local.md` (preventing the full CLAUDE-MD template from being duplicated into the worktree's `CLAUDE.md`), and Step D's scaffold detection resolves a symlinked `.rn-agent` to its core-checkout target and skips scaffold/partial-add entirely instead of mutating the shared corpus. The idempotency contract, output-table statuses, and anti-patterns document the symlink-inherited state explicitly.
