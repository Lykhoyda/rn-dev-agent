---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Prove the platform of custom-named devices ("rn-qa"-style simulators) against the live device inventory — booted simctl simulator names plus, only for a session-bound Android serial, that one device's adb model (ambient adb devices are never queried) — so `cdp_connect` binds the sole healthy exact-device Metro target instead of failing with a false "found 0", and name the true failing stage in exact-connect refusals.
