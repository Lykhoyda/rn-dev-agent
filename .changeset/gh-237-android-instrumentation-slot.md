---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

fix(#237): Android instrumentation-slot handoff — `runFlowParked` now releases the single Android `UiAutomation` slot before a Maestro flow (`maestro_run`/`maestro_test_all`/`cdp_auto_login`), fixing `UIAutomator2 server not ready after 30s`. It stops the in-tree `rn-android-runner`, `am force-stop`s our two instrumentation packages (the decisive device-side release), and — gated by `RN_DEVICE_KILL_LEGACY` — kills a stale legacy `agent-device` daemon by its specific PID (never `pkill`, guarded against our own process tree so the MCP server is never collateral). Best-effort and idempotent; iOS behavior is unchanged.
