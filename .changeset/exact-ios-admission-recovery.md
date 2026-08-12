---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

Fix the three linked iOS session-recovery defects from GH #750: extend the iOS exact-target readiness deadline to the Android 120s bound so the sole exact-device bridgeless target that re-registers slowly after the managed terminate+relaunch is admitted and B binds atomically (accepting an advisory `targetId` while B is unbound instead of refusing every id), reprofile `cdp_dismiss_dev_client_picker` to run without the A/B authority it exists to restore and prove A/B through the managed-origin lifecycle after a successful dismissal, and refuse maestro-runner replays on a drifted engine pin when the flow (including runFlow-nested steps) uses regex text selectors that drifted runners mistranslate into impossible WDA CONTAINS predicates.
