# Story 06 Phase A — Native runner unit tests in CI (design)

**Date:** 2026-07-05
**Issue:** #387 (Story 06 — Native runner tests in CI + LLM-behavior evals)
**Scope decision:** Phase A only. Phases B (nightly device smoke) and C (LLM-behavior evals) remain in `docs/stories/06-native-runner-ci-and-evals.md` as follow-ups; their dependency (#382, prebuilt artifacts) shipped in PR #456.
**Story spec:** `docs/stories/06-native-runner-ci-and-evals.md`

## Problem

CI runs 2,500+ TS unit cases but only **compiles** the native runners (CodeQL). The in-tree native suites — Swift `CommandSurfaceTests` (3), `KeyboardGuardTests` (6), `QuiescenceBypassTests` (12); Kotlin `KeyboardGuardTest` — execute only when a developer remembers to run them. The riskiest layer has zero automated execution.

Two latent defects found during design exploration confirm the rot this causes:

1. The shared scheme `RnFastRunner.xcscheme` contains a **dangling testable** `RnFastRunnerTests` — a deleted template target. Harmless for `xcodebuild build` (all CI ever runs today), a landmine for `xcodebuild test`.
2. The story spec itself cites `-only-testing:RnFastRunnerTests` — a target that does not exist. The real layout: the `RnFastRunnerUITests` bundle contains BOTH the production runner (`RnFastRunnerTests.testCommand`, the never-returning HTTP server, plus `RnFastRunnerTests+*.swift` command-handler extensions) AND the actual test classes.

## Design

### One new workflow: `.github/workflows/native-tests.yml`

Modeled on `codeql.yml`'s proven shape. Three jobs:

**`changes`** (ubuntu, seconds) — diffs the PR against its merge base and emits `ios=true|false`, `android=true|false`:

- `ios`: `scripts/rn-fast-runner/**` or `.github/workflows/native-tests.yml`
- `android`: `scripts/rn-android-runner/**` or `.github/workflows/native-tests.yml`
- Any push to `main`: both `true` unconditionally (story: "always on main").

**`android-unit`** (ubuntu-latest, `timeout-minutes: 10`, expected ~1–2 min):

- `actions/setup-java` temurin 17 (same as CodeQL) + `gradle/actions/setup-gradle` (cache).
- `./gradlew testDebugUnitTest --no-daemon` in `scripts/rn-android-runner`.
- Runs `KeyboardGuardTest.kt` today; any future JVM test is picked up automatically.
- On failure: upload `app/build/reports/tests/**` as a workflow artifact (7-day retention).

**`ios-unit`** (macos-15, `timeout-minutes: 25`, expected ~8–12 min):

- Preinstalled Xcode 16.x — no `setup-xcode` action (CodeQL precedent). macos-15 over the artifact workflow's macos-14 because `QuiescenceBypassTests` exercises Xcode-16-era private selectors and CodeQL already compiles this project on macos-15.
- ```
  xcodebuild test \
    -project RnFastRunner.xcodeproj \
    -scheme RnFastRunner \
    -destination 'platform=iOS Simulator,name=iPhone 16' \
    -derivedDataPath ../build/DerivedData \
    CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO \
    ONLY_ACTIVE_ARCH=YES \
    -skip-testing:RnFastRunnerUITests/RnFastRunnerTests \
    -skip-testing:RnFastRunnerUITests/SnapshotForegroundRegressionTest
  ```
- **Skip-list, not whitelist.** `RnFastRunnerTests` is the eternal server (would hang until the job timeout); `SnapshotForegroundRegressionTest` requires `com.rndevagent.testapp` installed (device-dependent — Phase B material). Everything else runs, and the Xcode 16 `FileSystemSynchronizedRootGroup` project means **new test classes in the folder run automatically with zero pbxproj edits**. A future device-dependent test fails visibly in CI instead of silently not running — the correct default for this story's purpose.
- On failure: upload the `.xcresult` bundle (7-day retention).

### Skip-notice pattern (gating safety)

When a lane's paths are unchanged on a PR, its job still runs and posts a one-line green "skip notice" (CodeQL's exact pattern) instead of being path-filter-skipped. Rationale: the repo has no required-status-check config (ruleset `standard` = deletion + non-fast-forward only); merge gating is the maintainer's "CI green" convention, which only works if checks always post.

### Scheme cleanup (targeted, in-scope)

Delete the dangling `RnFastRunnerTests` testable from `RnFastRunner.xcscheme`. Whether it hard-errors or is silently ignored by `xcodebuild test` (local pre-flight will show which), a scheme referencing a deleted target is dead weight in the exact action this design introduces.

### Dev entry points

Root `package.json` gains:

- `test:native:android` → the exact Gradle CI command
- `test:native:ios` → the exact xcodebuild CI command (destination overridable via `RN_IOS_TEST_DESTINATION`, default `platform=iOS Simulator,name=iPhone 16`)

Local == CI by construction.

### Docs & versioning

- `docs/stories/06-native-runner-ci-and-evals.md`: mark Phase A implemented (date + PR), Phases B/C still proposed.
- Changeset: patch-level (root `package.json` scripts are changesets-versioned; workflow files ride along).

## Error handling

- **Hang risk** (future server-style test class added unskipped): bounded by `timeout-minutes: 25`; the failure names the job so diagnosis is immediate.
- **Simulator flake**: logic tests don't drive UI, so exposure is low. No auto-retry — a flaky red should be re-run explicitly, not masked.
- **Image drift** (e.g. `iPhone 16` renamed in a future macos-15 image): visible destination-not-found failure; one-line fix.
- **Gradle/network failure**: standard actions retry semantics; no custom handling.

## Verification

1. **Local pre-flight** (before writing the workflow): run both exact commands on the dev machine — validates skip-list mechanics and the scheme cleanup immediately.
2. **On the PR**: `native-tests.yml` is in its own path filter → both lanes run live.
3. **Mutation check** (story acceptance criterion): one temporary "DO NOT MERGE" commit on the PR flips a `KeyboardGuard` predicate on BOTH platforms; observe both lanes red; revert; link the red run URLs in the PR body.

## Acceptance criteria (Phase A slice of the story)

- A deliberately broken `KeyboardGuard` predicate fails CI on both platforms (mutation check, verified once).
- TS-only PRs: added CI time ≈ 0 (skip-notice path). Native-touching PRs: ≤ 12 min added.
- New checks post on every PR (run or skip-notice) — de facto merge-gating under the existing CI-green rule.

## Out of scope

- Phase B (nightly device smoke, fixture app, golden command set over MCP stdio via `test/helpers/supervisor-harness.js`) — follow-up; #382 dependency now satisfied.
- Phase C (LLM-behavior evals) — follow-up; needs an eval-budget decision.
- Story 19 / #413 (user-facing headless-CI reference workflow) — adjacent but distinct product surface.
- Moving iOS logic tests to a plain unit-test target (rejected: `QuiescenceBypassTests` needs the XCUITest runtime; restructuring risk for marginal gain).

## References

- `codeql.yml` — change-detection + skip-notice + macos-15/no-setup-xcode precedents.
- `runner-artifacts.yml` (PR #456) — Story 01 artifact pipeline (Phase B's future input).
- Maestro `maestro-cli/src/test/mcp/README.md` — Phase C rationale (kept in story doc).
