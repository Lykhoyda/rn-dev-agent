---
'rn-dev-agent-plugin': patch
---

Fix #476: `/setup` now recognizes symlink-inherited git worktrees. Step A short-circuits template injection only when the manual marker is actually present in `CLAUDE.local.md` (a bare `.rn-agent` symlink from the SessionStart hook instead triggers an offer to complete the wiring), a missing/stale inherited scaffold halts setup before Steps B/C can inject unresolvable `dev-bridge` imports, and Step D skips scaffold/partial-add for symlinked corpora while still running the per-worktree tsconfig include touch-up. The idempotency contract and anti-patterns document the inherited state explicitly.
