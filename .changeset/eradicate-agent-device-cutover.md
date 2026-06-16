---
"rn-dev-agent-plugin": minor
---

Remove the agent-device dependency entirely. The Android daemon-socket + CLI fallback tiers are deleted; session open/close/list and find now route natively (simctl/adb + the in-tree rn-fast-runner / rn-android-runner), the Android dispatch gained an ensure-on-dispatch choke point (parity with iOS), session open validates the appId and acquires the device lock before any side-effect, RN_ANDROID_RUNNER=0 now errors (RUNNER_DISABLED) instead of silently falling back, and the agent-device install script + its SessionStart hook are gone. The in-tree runners are the sole device backend; the foreign-AgentDeviceRunner cleanup (self-heal for old installs) is retained.
