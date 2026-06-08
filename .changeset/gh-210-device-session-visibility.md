---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

Fix #210: iOS device-session visibility + self-healing. `cdp_status` now reports `deviceSession: { sessionOpen, rnFastRunner: 'alive'|'stale'|'dead', appId?, deviceId?, foreignRunner? }` so the agent can see the XCUITest runner state before calling `device_*` (iOS-gated — Android leaves `rnFastRunner:'dead'` and skips the probe/scan). `device_find/press/fill` now auto-spawn the runner from the dispatch choke point when a session or booted simulator exists and the rig is prebuilt — cold-build-safe: a missing prebuilt rig returns an actionable `RN_FAST_RUNNER_DOWN` error naming `device_snapshot action=open` instead of a silent multi-minute `xcodebuild`. `device_screenshot` now falls back to `xcrun simctl io screenshot` (or `adb`) whenever the runner can't serve it — including while a Maestro flow owns the device — so it never hard-fails on iOS. Also fixes a latent bug where an omitted-platform `device_snapshot action=open` stored `platform: undefined`, skipping the iOS dispatch branch.

Reframes the issue's "ride Maestro's WDA" suggestion (rejected: WDA is per-flow/ephemeral with no session to ride, and a WDA client would add a second XCUITest backend rather than unify; mid-flow pixels use simctl, mid-flow state uses CDP introspection). (GH #210, B186, D1249)
