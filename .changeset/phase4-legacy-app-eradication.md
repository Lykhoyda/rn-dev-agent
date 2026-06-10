---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

#202 Phase 4 — eradicate legacy runner apps, not just processes.

At iOS device-open, `ensureSingleRunner` now detects the legacy upstream runner apps installed on the target simulator (`com.callstack.agentdevice.runner` + `.uitests.xctrunner`) and `simctl uninstall`s them. Killing the host processes (Phase 1) was insufficient: iOS relaunches an installed XCUITest runner into the foreground mid-`maestro_run`, backgrounding the app under test and wedging CDP. Scanned at every device-open (one `simctl listapps`, ~tens of ms — no memo, so a reinstall by another session is always caught); error-safe (warnings, never a blocked session); opt out with `RN_DEVICE_KILL_LEGACY=0`. Results surface as `removedApps` + `meta.timings_ms.appEradication`.
