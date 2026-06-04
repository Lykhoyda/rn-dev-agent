---
"rn-dev-agent-plugin": minor
---

#202 Phase 2b: `cdp_status` now auto-recovers the JS-thread-paused wedge. When the simulator's foreground is stolen and iOS suspends the app's JS thread (CDP wedged), `cdp_status` parks the fast-runner, re-foregrounds the target app (`simctl launch`, which resumes its JS thread), reconnects, and confirms recovery with a real CDP liveness probe — bounded to 3 consecutive attempts per session (reset on a successful recovery and on `device_snapshot action=open`). It skips when a Maestro flow is running (it would yank the app out from under the flow) and falls back to suggesting `cdp_restart(hardReset=true)`. This replaces the previous dead-end "Debugger is still paused" warning that left the agent to rediscover the fix over many attempts. iOS-only.
