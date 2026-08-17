---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Prove the platform of custom-named devices ("rn-qa"-style simulators) against the live simctl/adb device inventory so `cdp_connect` binds the sole healthy exact-device Metro target instead of failing with a false "found 0", and name the true failing stage (platform/app gate vs device association vs no targets) in exact-connect refusals.
