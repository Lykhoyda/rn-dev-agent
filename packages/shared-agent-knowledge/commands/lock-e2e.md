---
command: lock-e2e
description: Promote a verified action into a frozen, locked e2e regression test. Runs the action once strict (no repair) via cdp_lock_e2e_test and freezes it to .rn-agent/e2e/<id>.yaml only if it passes. v1 supports param-free actions only.
argument-hint: <action-name> [--relock]
allowed-tools: Read, mcp__plugin_rn-dev-agent_cdp__cdp_lock_e2e_test
---

Lock the action into a locked e2e test: $ARGUMENTS

Steps:
1. Call `cdp_lock_e2e_test` with `actionId` = the first positional arg (add `relock: true` if `--relock` is present).
2. If it returns `STRICT_RUN_FAILED`, tell the user the action must pass a strict (no-repair) run first — offer to run `cdp_run_action` to repair it, then retry the lock.
3. If it returns `PARAMS_UNSUPPORTED`, explain that v1 supports param-free tests only.
4. On success, report the frozen file path and that it will now be included in `cdp_run_e2e_suite`.
