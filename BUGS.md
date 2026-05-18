# BUGS

Plugin-side bug log. Workspace-side scaffolding bugs live in
`../rn-dev-agent-workspace/docs/BUGS.md`.

## Open

_(none currently — Task 10 live smoke-test ran successfully on 2026-05-18; see Fixed section below)_

## Fixed

### ~~Live Android emulator smoke test deferred (Task 10, plan 2026-05-16)~~ (PASSED — 2026-05-18)

Task 10 ran live on Pixel_9_Pro AVD (emulator-5554) after host disk space was freed. Acceptance criteria green:

- `./gradlew :app:assembleDebugAndroidTest` → BUILD SUCCESSFUL
- `am instrument` readiness handshake: `RN_ANDROID_RUNNER_LISTENER_READY` + `RN_ANDROID_RUNNER_PORT=22089` within ~3s of spawn
- `curl http://127.0.0.1:22089/health` → `{"ok":true}`
- `curl /command snapshot` of `com.rndevagent.testapp` → 148 nodes including `tab-home`, `tab-tasks`, `tab-notifications`, `tab-profile` identifiers
- `ps -A | grep agent-device|AgentDevice|uiautomator` (excluding our androidrunner package) → empty (no upstream contention)

Smoke-test surfaced one real plan defect along the way: `java.net.SocketException: EPERM` on `NanoHTTPD.start()` because the target app's manifest was missing `INTERNET` permission. `am instrument` injects test code into the target app's process, and `ServerSocket.bind()` checks the target UID's permissions, not the test APK's. Fixed by adding the permission to `scripts/rn-android-runner/app/src/main/AndroidManifest.xml` (commit `f5d4e0a`). Smoke-test ran clean post-fix.

**Operator notes for re-running**: Metro must be reachable from the emulator. Set up `adb -s emulator-5554 reverse tcp:8081 tcp:8081` before launching the test-app. Existing iOS Metro on host port 8081 is reused — no need for a separate `pnpm android` if iOS Metro is already running.
