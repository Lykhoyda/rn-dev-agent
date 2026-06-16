---
"rn-dev-agent": patch
---

Fix #303: Metro-port discovery now prefers the port with an attached Hermes target over a merely-running one, and when several Metros have an app it auto-selects the one whose serving directory matches this worktree's project root (resolved via `findProjectRoot` + realpath, containment-aware). `cdp_status` surfaces all candidate Metros (`metro.candidates`) plus `projectRoot`/`servingCwd`, and warns when the connected Metro serves a different worktree — catching the silent trap where an agent verifies against the wrong worktree's JS bundle even with a single Metro running. `cdp_targets` (`discoverForList`) prefers the attached port too. Fail-open throughout (macOS `lsof`; degrades to prior behavior off-darwin or when paths can't be resolved).
