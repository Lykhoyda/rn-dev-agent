# Story 01 — Prebuilt runner artifacts: kill the 6-minute cold build

**Status:** Proposed (2026-07-02)
**Epic:** [Maestro adoption](README.md)
**Impact:** First-run UX (6 min → <30 s), CI device-smoke enabler (Story 06 Phase B)
**Effort:** M
**Depends on:** — (Story 02's version stamping dovetails but is not a blocker)

## Problem

The first `device_snapshot action=open` on iOS triggers a cold `xcodebuild test` of rn-fast-runner that can take up to 6 minutes (`packages/rn-dev-agent-core/src/runners/rn-fast-runner-client.ts:164-234`; ready timeout 30 s warm / 360 s cold). Android builds both APKs via `gradlew assembleDebug assembleDebugAndroidTest` + `adb install -r` on first use (`rn-android-runner-client.ts:210-292`). Consequences:

- Worst possible first-session experience for a new user (the plugin looks hung).
- Every environment without Xcode command-line throughput (CI, laptops on battery) pays it again.
- CI cannot cheaply smoke-test the runners because it would have to build them first.
- A plugin version bump that touches runner sources silently invalidates DerivedData and re-triggers the cold path mid-session.

## What Maestro does

Maestro **never runs xcodebuild on a user machine.** The prebuilt XCTest runner (`maestro-driver-iosUITests-Runner.app` zipped + a `.xctestrun` file) ships as JAR resources, is extracted at runtime (`maestro-ios-driver/.../IOSBuildProductsExtractor.kt`), then installed with `xcrun simctl install` and launched via `simctl launch --terminate-running-process` with the port passed as `SIMCTL_CHILD_PORT` (`LocalSimulatorUtils.kt:342-367`). Android ships `maestro-app.apk` + `maestro-server.apk` as resources and `adb install`s them (`AndroidDriver.kt:1165-1214`). The `.xctestrun` + products-dir layout survives zipping because paths inside the xctestrun are `__TESTROOT__`-relative.

Interesting detail we already half-use: `rn-fast-runner-client.ts` scans DerivedData for a prebuilt `.xctestrun` and uses `test-without-building` when one exists (observed live 2026-07-01). This story makes that the *only* hot path and supplies the artifact.

## Design

### Build side (CI, release workflow)

1. **iOS job (macOS runner):**
   ```bash
   xcodebuild build-for-testing \
     -project packages/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj \
     -scheme RnFastRunner \
     -destination 'generic/platform=iOS Simulator' \
     -derivedDataPath build/dd \
     CODE_SIGNING_ALLOWED=NO ONLY_ACTIVE_ARCH=NO
   ```
   Collect from `build/dd/Build/Products/`: the `Debug-iphonesimulator/` products dir (contains `*-Runner.app`) and the generated `*.xctestrun`. Zip as `rn-fast-runner-<pluginVersion>-sim.zip` preserving relative layout (Maestro proves the layout survives). `ONLY_ACTIVE_ARCH=NO` gives arm64 + x86_64 slices.
2. **Android job (ubuntu runner):**
   ```bash
   (cd packages/rn-android-runner && ./gradlew assembleDebug assembleDebugAndroidTest)
   ```
   Zip `app-debug.apk` + `app-debug-androidTest.apk` as `rn-android-runner-<pluginVersion>.zip`.
3. **Publish:** attach both zips to the GitHub Release the Version Packages PR creates. Also write `runner-manifest.json` (committed at release time, or attached to the release) with `{version, files: [{name, sha256, bytes}]}`.

### Client side (resolution order)

New `packages/rn-dev-agent-core/src/runners/runner-artifacts.ts`, used by `ensureRunnerForCommand` (iOS) and `startAndroidRunner`:

1. **Cache hit:** `~/Library/Caches/rn-dev-agent/runners/<pluginVersion>/{ios,android}/` exists and every file matches the manifest SHA-256 → use directly (`test-without-building` with the cached xctestrun; `adb install -r` the cached APKs).
2. **Download:** fetch the release asset for the *exact* plugin version (bounded: 60 s timeout, size cap from manifest, SHA-256 verified before unzip, unzip with path-traversal guard). Progress surfaced via a one-line `meta.note` on the first tool call ("downloading prebuilt runner, ~4 MB").
3. **Fallback — local build:** the current xcodebuild/gradle path, kept intact for offline machines, forks, and `RN_RUNNER_BUILD=local` override. Doctor reports which path was used.

### Version stamping

Inject the plugin version at build time (iOS: `Info.plist` key `RnFastRunnerVersion` via `-xcconfig` or a build phase; Android: `BuildConfig.RUNNER_VERSION`). `/health` returns it (consumed by Story 02's compatibility gate). The runner state file records `{runnerVersion, provenance: 'prebuilt'|'local'}` so `shouldReuseRunner` can refuse a version-mismatched leftover — this closes the live-observed 0.57.1-vs-0.57.3 cache-mirror mismatch class (session 2026-07-01).

## Implementation steps

1. `runner-artifacts.ts` with `resolveRunnerArtifacts(platform, version): {kind: 'cache'|'downloaded'|'build-local', paths}` + unit tests (fake fs + fake fetch; corrupt-zip, bad-checksum, offline, traversal-attempt cases).
2. Release workflow additions (`.github/workflows/`): two build jobs + asset upload; gate on the existing version-sync check so artifact version always equals package version.
3. Wire into `rn-fast-runner-client.ts` (`ensureRunnerForCommand`) and `rn-android-runner-client.ts` (`startAndroidRunner`), before their build-on-demand branches.
4. `/doctor` (`rn-dev-agent:doctor` skill + `cdp_status`): report runner provenance, version, cache path.
5. Docs: README install section note; CHANGELOG.

## Acceptance criteria

- Fresh machine (empty caches), released version: first `device_snapshot action=open` reaches `RN_FAST_RUNNER_LISTENER_READY` in < 30 s + download time; no xcodebuild invoked (assert via absence of the cold-build log marker).
- Checksum mismatch or download failure → automatic fallback to local build with a clear `meta.note`, never a hard failure.
- `RN_RUNNER_BUILD=local` forces the old path.
- Doctor shows `runner: prebuilt v<X> (cache)` vs `local-built`.

## Test plan

- Unit: resolution-order matrix (cache valid / cache corrupt / download ok / download 404 / offline / override env).
- Integration (Story 06 Phase B): nightly job downloads its own artifact, installs on a booted simulator, runs the golden command set.
- Manual: one cold-start timing before/after on a dev machine, recorded in the PR body.

## Risks & open questions

- **xctestrun/Xcode compatibility:** an artifact built with Xcode N must run under users' Xcode N-1/N+1 simulators. The xctestrun format is stable for simulator destinations and Maestro ships one artifact for all users; mitigation: build with the oldest supported Xcode in CI, keep the local-build fallback, and record `xcodeBuildVersion` in the manifest for doctor diagnostics.
- **Release-asset availability for pre-release/dev builds:** dev worktrees fall through to local build by design (provenance makes this visible, not silent).
- **Artifact size:** expected 2–6 MB per platform; manifest size cap prevents surprise growth.
