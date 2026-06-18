---
"rn-dev-agent-cdp": patch
---

Fix the observe Regression tab's per-action **Run** button doing nothing. The observe `runAction` wiring resolved the correct project root for `loadAction` but then called the inner `runActionHandler` (`cdp_run_action`) without passing `projectRoot`, so the runner re-derived it from `process.cwd()` (the plugin repo) and failed instantly with `NO_PROJECT_ROOT` before ever reaching the device. The resolved root is now threaded into `runActionHandler`, so a clicked action runs its Maestro flow on the connected app's project. (Follow-up to #348, which fixed the same root-resolution family for the actions list and suite.)
