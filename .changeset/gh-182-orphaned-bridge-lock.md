---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

Fix #182: the CDP MCP no longer fails with `-32000: Connection closed` when an orphaned bridge from a dead Claude Code session holds the single-instance lock.

Root cause: when CC dies abnormally (SIGKILL/crash/window-close on macOS) without closing the child's stdin or signaling it, the bridge becomes a **live orphan** — still running, still holding the project lock. The existing reclaim (PID-dead / mtime>24h / process-name) can't recover a *live* owner, so the next session hard-failed for up to 24h. Four composing fixes:

- **Parent-death self-exit (prevent).** A `getppid()` poll (`lifecycle/parent-watch.ts`) captures the bridge's PPID at startup and self-exits (releasing the lock) when it *changes* — i.e. the original Claude Code host died and the bridge was reparented. This catches the abnormal-death cases stdin-EOF + signal handlers miss. It compares against the startup PPID rather than testing `=== 1` so a bridge whose host runs as PID 1 (a container with no init system) is never falsely killed.
- **Orphaned-owner reclaim (recover).** `Lockfile.isLockLive` reclaims a *live* owner whose parent **changed** from the PPID it recorded at acquire (`ps -o ppid=`) — so a new session self-heals past an existing orphan instead of hard-failing. A null PPID lookup fails safe; pre-0.39 locks with no recorded `ppid` fall back to a legacy `PPID===1` reclaim.
- **Heartbeat (recover wedged).** The lock body carries `lastHeartbeat`, refreshed every ~10s; a live owner whose heartbeat goes stale (>90s) is wedged and reclaimable — mirroring the device-lock's self-healing. Pre-0.39 locks without `lastHeartbeat` fall back to the existing mtime check (back-compat).
- **Usurp self-terminate (sleep/wake safety).** `Lockfile.touch()` now returns whether we still own the lock. If a contender reclaimed our slot while the laptop slept (heartbeat expired → reclaimed → we wake), the next heartbeat detects the foreign PID and self-terminates instead of running as a second bridge on the same device. This also makes the (pre-existing, non-atomic) reclaim path self-correcting within one tick.

Together these eliminate the manual `kill <pid> && rm <lock>` workaround. 15 #182 unit tests (incl. container-safety, sleep/wake usurp, and a real `ps -o ppid=` check); unit suite 1744/1744; `tsc` clean. (GH #182, B185, D1246)
