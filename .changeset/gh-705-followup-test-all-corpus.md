---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

maestro_test_all now commits the proof-carrying install-receipt re-issue after a clearState corpus flow reinstalls the app and resolves the iOS app container from the authority-bound simulator UDID instead of generic `booted`, so a corpus containing clearState flows no longer breaks install identity for every subsequent flow and tool call.
