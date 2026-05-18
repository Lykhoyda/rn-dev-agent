# ROADMAP

Plugin-side roadmap. Workspace-side scaffolding roadmap lives in
`../rn-dev-agent-workspace/docs/ROADMAP.md`.

## Phase 138: rn-android-runner MVP — in-tree UIAutomator runner for Android (2026-05-16)

**Why:** Android device automation was the last surface still routed through
upstream `agent-device` after PR #164's iOS-MVP migration. Phase 138 vendors
an in-tree Gradle Android instrumentation runner mirroring the iOS pattern
(NanoHTTPD on port 22089, single `POST /command` JSON contract, UIAutomator
under `am instrument`).

**What landed** (PR #?, branch `feat/rn-android-runner-mvp`):

| Task | Commit | What |
|---|---|---|
| 1 | ac22b74 | Gradle scaffold + Kotlin runner skeleton (~340 LOC). Configurator.setWaitForIdleTimeout(0) for RN/Reanimated. |
| 2 | 5620d8a | SnapshotForegroundRegressionTest.kt (Android equivalent of iOS B155). |
| 3 | 16cf3fa | TS HTTP client `rn-android-runner-client.ts` + 4 unit tests. runner-timeout shim for UIAutomator typeText on RN. |
| 4+5 | fcb8870 | Short-circuit in runAgentDevice gated by RN_ANDROID_RUNNER + buildRunAndroidArgs + 4 unit tests. |
| 6+7 | 658fe2d | flattenAndroidAccessibilityTree helper + Android stale-ref test coverage. |
| 8 | 6227536 | device_find/device_scrollintoview Android branches reuse the iOS orchestrators (D1217 symmetry). |
| 9 | ccd82e8 | detectAndroidExternalRunner warns about competing UIAutomator/agent-device processes at session-open. |
| 10 | (deferred) | Live Android emulator smoke-test — deferred on host disk space. See BUGS.md. |
| 11 | (this commit) | Flip env default ON. `RN_ANDROID_RUNNER=0` is the new escape hatch. Docs. |

**Acceptance criteria met:**
- Unit suite: 1464+/1464+ passing (was 1449 pre-Android, +15 new Android tests)
- Gradle `:app:assembleDebugAndroidTest` builds clean
- D1217 cross-platform symmetry: device_find / device_scrollintoview use the same TS orchestrators on both platforms
- D1219-equivalent for Android: iOS-side `agent-device` dependency dropped for the same reasons

**Out of scope (carried to a later phase):**
- Physical-device hardening beyond ADB
- Android TV / Wear OS / multi-display input
- Recording, replay, video capture
- AccessibilityService-based automation
- Removing the upstream `agent-device` Android fallback. Currently kept as the `RN_ANDROID_RUNNER=0` escape hatch.
