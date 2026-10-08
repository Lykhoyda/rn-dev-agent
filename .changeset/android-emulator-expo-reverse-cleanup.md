---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

Managed Expo builds on Android emulators now remove the Metro-port adb reverse that Expo creates during the build, leaving pre-existing and other-device mappings untouched.
