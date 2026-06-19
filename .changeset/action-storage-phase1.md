---
"rn-dev-agent-cdp": minor
---

Action corpus run/repair history now persists in a derived, gitignored node:sqlite store (.rn-agent/state/actions.db) alongside the per-action JSON sidecars (Phase 1 dual-write: sidecars stay authoritative, the DB is a rebuildable mirror), with graceful degradation to sidecar-only when node:sqlite is unavailable. The worker enables node:sqlite via a version-gated --experimental-sqlite flag (Node 22.5–23.5); the engines floor stays >=22. cdp_status now reports the active backend as `actionStore`. The learned-actions inventory script is migrated from JavaScript to TypeScript (compiled to dist/).
