# BUGS

Plugin-side bug log. Workspace-side scaffolding bugs live in
`../rn-dev-agent-workspace/docs/BUGS.md`.

## Open

### Live Android emulator smoke test deferred (Task 10, plan 2026-05-16)

The Task 10 emulator smoke-test was deferred during the MVP rollout because
the local development environment had insufficient disk space to boot the
Pixel_9_Pro AVD (`FATAL: Your device does not have enough disk space to run
avd`). All non-emulator validation is complete: 1463/1463 unit tests pass,
Gradle `:app:assembleDebugAndroidTest` succeeds, the foreground-snapshot
regression test compiles, and the Kotlin command dispatcher covers every
MVP verb.

**To re-attempt the deferred verification:** free ~5–10 GB on the host,
boot the AVD, then follow the Task 10 steps in
`docs/superpowers/plans/2026-05-16-rn-android-runner-mvp-plan.md` lines
1670-1750. If the smoke-test reveals runtime issues, file a new bug and
optionally set `RN_ANDROID_RUNNER=0` to revert to the legacy
`agent-device` path while diagnosing.
