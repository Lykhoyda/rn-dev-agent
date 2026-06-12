---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

Recovery paths now detect "app not installed" and resolve their relaunch target truthfully (GH #262, absorbs #194 BUG 2).

- `cdp_status` APP_DETACHED auto-relaunch: when `simctl launch` fails AND `get_app_container`'s stderr carries the `NSPOSIXErrorDomain code=2` marker (allowlist-only, stderr-only — argv-spoof-proof), the tool returns a distinct `APP_NOT_INSTALLED` code with install advice — including a shell-quoted `simctl install` line for the newest matching `.app` snapshot from the last clearState (GH #201 dir, mtime-sorted budgeted scan). Ambiguous probe verdicts fail open to the existing `APP_DETACHED` behavior. Concurrent recoveries are serialized, and a confirmed missing bundle is cached (with a cheap re-probe) so the diagnosis is never masked by `budget-exhausted`.
- `cdp_restart hardReset=true`: the relaunch target resolves through `explicit arg > connectedTarget > cache > active-session appId > strict per-platform app.json` (no iOS←Android fallback), simctl targets the active session's UDID when one exists, failed launches are classified the same way in `hardResetSteps`, and a successful hard reset resets the detached-recovery budget.
