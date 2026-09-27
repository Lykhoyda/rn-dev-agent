---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

Maestro replays now pass `--driver uiautomator2` on Android and `--driver wda` on iOS explicitly, so a maestro-runner release that changes its default driver (or an ambient `MAESTRO_DRIVER`) can no longer silently switch the replay driver.
