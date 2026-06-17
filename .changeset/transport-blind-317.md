---
"rn-dev-agent-plugin": patch
---

cdp_repair_action now reports TRANSPORT_BLIND when the failed Maestro selector is present in the live rn-fast-runner snapshot — the iOS 26.2 + bridgeless empty-a11y-tree case (GH #317) — instead of the misleading "no confident replacement". cdp_run_action surfaces it as a terminal refusal with refusedReason TRANSPORT_BLIND. Diagnostic-only; restoring replay on that runtime is Phase 2.
