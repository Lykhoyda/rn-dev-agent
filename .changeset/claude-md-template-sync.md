---
'rn-dev-agent-plugin': patch
---

Sync CLAUDE-MD-TEMPLATE.md (the operating manual `/setup` injects into user
projects) with everything shipped since 0.49.0. The template still documented
the pre-0.55 world: it told agents to run a manual multi-minute `xcodebuild`
pre-build (obsolete since prebuilt runner artifacts, #382), described Android
dispatch as "3-tier agent-device" (removed entirely in 0.55.0), routed MMKV
through raw `cdp_evaluate` Nitro poking (superseded by `cdp_mmkv`), and framed
multi-device screenshot routing as an open bug (#60 — fixed).

Updated: in-tree runner section rewritten around prebuilt-artifact resolution,
protocol/command staleness self-healing, quiescence bypass, and the foreign-flow
arbiter; new reliability-layers table (settle engine, self-healing taps,
keyboard guard) with opt-out env vars; perception guidance for
`cdp_component_tree(interactiveOnly)`, `device_batch finalSnapshot`, and cached
`device_find`; E2E lock/suite flow (`/lock-e2e`, `cdp_lock_e2e_test`,
`cdp_run_e2e_suite`) in the actions lifecycle; dev-menu dismiss via
`cdp_dev_settings hideDevMenu`; `device_reset_state` in the auth/permission
pre-flight; nine new error-recovery rows (BUSY_FOREIGN_FLOW,
RUNNER_COMMANDS_STALE, KEYBOARD_OCCLUDED, RUNTIME_DEGRADED, APP_NOT_INSTALLED,
TRANSPORT_BLIND fallback, post-upgrade zero-tools recovery, wrong-worktree
Metro); Key Commands table gains doctor / list-learned-actions / run-action /
lock-e2e and the autostarting observe UI description.
