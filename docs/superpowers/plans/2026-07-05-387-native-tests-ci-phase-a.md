# Story 06 Phase A — Native Runner Unit Tests in CI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the existing Swift and Kotlin native-runner unit suites on every relevant PR and every push to main, with zero added time for TS-only PRs.

**Architecture:** One new workflow `.github/workflows/native-tests.yml` copying `codeql.yml`'s proven shape — a fast ubuntu `changes` job diffs the PR against its merge base, then `android-unit` (Gradle JVM tests) and `ios-unit` (xcodebuild test on a simulator, skip-listing the two unrunnable classes) either run for real or post a one-line green skip notice. Local == CI via a shared `scripts/test-native-ios.sh` and root npm scripts.

**Tech Stack:** GitHub Actions (ubuntu-latest, macos-15), Gradle 8/JUnit 4, xcodebuild/XCTest, npm scripts.

**Spec:** `docs/superpowers/specs/2026-07-05-387-native-tests-ci-phase-a-design.md` (approved 2026-07-05)
**Branch:** `feat/387-native-tests-ci` (off origin/main, spec already committed)
**Issue:** #387

## Global Constraints

- iOS lane runs on `macos-15` with the **preinstalled** Xcode (no `setup-xcode` action) — CodeQL precedent.
- iOS skip-list (never whitelist): `-skip-testing:RnFastRunnerUITests/RnFastRunnerTests` (never-returning server entry) and `-skip-testing:RnFastRunnerUITests/SnapshotForegroundRegressionTest` (needs `com.rndevagent.testapp` installed).
- Android lane: temurin JDK 17 (same as `codeql.yml`), `./gradlew testDebugUnitTest --no-daemon`.
- Skip-notice pattern: when a lane's paths are unchanged on a PR the job still POSTS a green check (echo notice), never a path-filtered non-report. Push to main runs both lanes unconditionally.
- Timeouts: `android-unit` 10 min, `ios-unit` 25 min. No auto-retry anywhere.
- Expected iOS suite: 21 tests — CommandSurfaceTests (3) + KeyboardGuardTests (6) + QuiescenceBypassTests (12). Expected Android suite: 6 tests (KeyboardGuardTest).
- Commits: signed (`git commit -S`), conventional style `feat(story-06): …`, each ending with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- No new npm/gradle/swift dependencies of any kind.
- **NEVER add `skippedTests` to `RnFastRunnerUITests.xctestplan`** (multi-LLM review finding, REJECTED after verification): `build-for-testing` bakes the plan's skips into the `.xctestrun` as `SkipTestIdentifiers`, and the PRODUCTION runner launch (`rn-fast-runner-client.ts:522`) is `test-without-building -only-testing:RnFastRunnerUITests/RnFastRunnerTests/testCommand` against that same `.xctestrun` — skips subtract from the only-set, so the server would never boot. Skips live in `scripts/test-native-ios.sh` CLI flags ONLY.
- After every root `package.json` edit, run `npm run format` (the husky pre-push hook runs `oxfmt --check`; hand-edited JSON may not match its canonical style).

## Amendments applied from the multi-LLM plan review (2026-07-05, Codex + Claude research; Gemini unavailable)

1. iOS lane hardened against simulator-boot flake (top first-run risk — codeql only ever *builds*; this workflow is the first to *boot a simulator* on CI): pre-boot step with `simctl bootstatus -b` + automatic fallback when `iPhone 16` is absent from the image (Task 3).
2. Quiescence live-probe triage note added to PR body + story doc: a red on `QuiescenceBypassTests.testProbeResolvedAtBundleLoad` means CI-Xcode private-selector drift ("degrade loudly" by design), not a plugin bug (Tasks 4, 5).
3. xctestplan `skippedTests` suggestion REJECTED — would break the production runner launch (see Global Constraints).
4. Story doc line with the wrong `-only-testing:RnFastRunnerTests` command is fixed IN PLACE, not merely annotated (Task 4). The subclass rule (any subclass of `RnFastRunnerTests` inherits the 24-hour `testCommand` and must be skip-listed) is documented there too.
5. Hygiene: `.gitignore` entries for the Android build dirs (Task 1); `npm run format` after package.json edits (Tasks 1–2); Task 6 explicitly waits for the red runs to CONCLUDE and records URLs BEFORE pushing the revert (`cancel-in-progress: true` would cancel a still-running red).

---

### Task 1: Android lane locally — npm script + green run

**Files:**
- Modify: `package.json` (repo root — the `scripts` block)
- Modify: `.gitignore` (repo root)

**Interfaces:**
- Produces: `npm run test:native:android` — the exact command CI's `android-unit` job runs (Task 3 references it in a comment; Task 6 breaks it deliberately).

- [ ] **Step 1: Add the npm script**

In root `package.json`, add to `"scripts"` (after `"test"`):

```json
    "test:native:android": "cd scripts/rn-android-runner && ./gradlew testDebugUnitTest --no-daemon",
```

Then run `npm run format` (pre-push hook runs `oxfmt --check`; keep the JSON canonical).

- [ ] **Step 2: Ignore local Android build output**

Local runs write untracked build dirs (the iOS equivalents are already ignored). Add to `.gitignore`:

```
scripts/rn-android-runner/.gradle/
scripts/rn-android-runner/**/build/
```

- [ ] **Step 3: Run it — expect green with 6 tests**

Run: `npm run test:native:android`
Expected: `BUILD SUCCESSFUL` and a `testDebugUnitTest` task run. To see the count: `grep -c "<testcase" scripts/rn-android-runner/app/build/test-results/testDebugUnitTest/TEST-*.xml` → `6`. `git status --porcelain` shows no untracked build output.
If the Gradle daemon/JDK is missing locally, that is an environment failure to fix (JDK 17 required), not a plan deviation.

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -S -m "feat(story-06): test:native:android npm script (#387)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: iOS lane locally — scheme cleanup + shared script + green run

**Files:**
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj/xcshareddata/xcschemes/RnFastRunner.xcscheme`
- Create: `scripts/test-native-ios.sh`
- Modify: `package.json` (root — `scripts` block)

**Interfaces:**
- Produces: `scripts/test-native-ios.sh` — the single source of truth for the iOS test invocation; CI (Task 3) and `npm run test:native:ios` both call it. Env overrides: `RN_IOS_TEST_DESTINATION` (default `platform=iOS Simulator,name=iPhone 16`), `RN_IOS_TEST_RESULTS` (default `../build/native-tests.xcresult`, path relative to `scripts/rn-fast-runner/RnFastRunner`).

- [ ] **Step 1: Remove the dangling testable from the shared scheme**

In `RnFastRunner.xcscheme`, delete this entire block (the deleted template target `RnFastRunnerTests`; the surviving testable `RnFastRunnerUITests` and the `TestPlans` block stay untouched):

```xml
         <TestableReference
            skipped = "NO"
            parallelizable = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "20EA2ED22F2CFC7C001CF0EF"
               BuildableName = "RnFastRunnerTests.xctest"
               BlueprintName = "RnFastRunnerTests"
               ReferencedContainer = "container:RnFastRunner.xcodeproj">
            </BuildableReference>
         </TestableReference>
```

- [ ] **Step 2: Create `scripts/test-native-ios.sh`**

```bash
#!/usr/bin/env bash
# Story 06 Phase A (#387): run the rn-fast-runner unit-test classes on a simulator.
# CI (.github/workflows/native-tests.yml ios-unit) and `npm run test:native:ios`
# both call this script so local == CI by construction.
#
# Skip-list, not whitelist — new test classes in RnFastRunnerUITests/ run
# automatically (Xcode 16 FileSystemSynchronizedRootGroup). The two skips:
#   RnFastRunnerTests            — the production runner entry (never returns)
#   SnapshotForegroundRegressionTest — needs com.rndevagent.testapp installed
set -euo pipefail
cd "$(dirname "$0")/rn-fast-runner/RnFastRunner"
DEST="${RN_IOS_TEST_DESTINATION:-platform=iOS Simulator,name=iPhone 16}"
RESULTS="${RN_IOS_TEST_RESULTS:-../build/native-tests.xcresult}"
rm -rf "$RESULTS"
xcodebuild test \
  -project RnFastRunner.xcodeproj \
  -scheme RnFastRunner \
  -destination "$DEST" \
  -derivedDataPath ../build/DerivedData \
  -resultBundlePath "$RESULTS" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO \
  ONLY_ACTIVE_ARCH=YES \
  -skip-testing:RnFastRunnerUITests/RnFastRunnerTests \
  -skip-testing:RnFastRunnerUITests/SnapshotForegroundRegressionTest
```

Then: `chmod +x scripts/test-native-ios.sh`

- [ ] **Step 3: Add the npm script**

In root `package.json`, after `test:native:android`:

```json
    "test:native:ios": "bash scripts/test-native-ios.sh",
```

Then run `npm run format`.

- [ ] **Step 4: Run it — expect green with 21 tests, 2 classes skipped**

Run: `npm run test:native:ios` (~5–12 min locally; boots a simulator if needed)
Expected: `** TEST SUCCEEDED **`; the log's executed suites are `CommandSurfaceTests`, `KeyboardGuardTests`, `QuiescenceBypassTests` (21 tests total); neither `RnFastRunnerTests` nor `SnapshotForegroundRegressionTest` appears as an executed suite.
If the local machine lacks an `iPhone 16` simulator: `RN_IOS_TEST_DESTINATION='platform=iOS Simulator,name=<an available iPhone>' npm run test:native:ios`.
Record actual wall-clock time — it calibrates the CI expectation in the PR body.

- [ ] **Step 5: Commit**

```bash
git add scripts/test-native-ios.sh package.json "scripts/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj/xcshareddata/xcschemes/RnFastRunner.xcscheme"
git commit -S -m "feat(story-06): iOS native-test script + dangling-testable scheme cleanup (#387)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The workflow — `.github/workflows/native-tests.yml`

**Files:**
- Create: `.github/workflows/native-tests.yml`

**Interfaces:**
- Consumes: `scripts/test-native-ios.sh` (Task 2). Job/check names produced: `Native tests / Detect native changes`, `Native tests / Android unit (JVM)`, `Native tests / iOS unit (simulator)`.

- [ ] **Step 1: Write the workflow file** (complete content):

```yaml
# Story 06 Phase A (#387): execute the native runner unit suites.
# Shape copied from codeql.yml: a fast ubuntu `changes` pre-flight, then
# per-platform jobs that either run the tests or post a green skip notice —
# checks ALWAYS post, so the maintainer's "CI green" merge rule stays sound
# without required-status-check config.
name: Native tests

on:
  pull_request:
    branches: [ main ]
  push:
    branches: [ main ]

concurrency:
  group: native-tests-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  changes:
    name: Detect native changes
    runs-on: ubuntu-latest
    outputs:
      ios: ${{ steps.detect.outputs.ios }}
      android: ${{ steps.detect.outputs.android }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Detect native-source changes
        id: detect
        env:
          EVENT_NAME: ${{ github.event_name }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
        run: |
          set -euo pipefail
          # Push to main: always run both lanes (image/toolchain drift check).
          if [ "$EVENT_NAME" != "pull_request" ]; then
            echo "ios=true" >> "$GITHUB_OUTPUT"
            echo "android=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          CHANGED="$(git diff --name-only "$BASE_SHA"...HEAD)"
          if echo "$CHANGED" | grep -qE '^scripts/rn-fast-runner/|^scripts/test-native-ios\.sh$|^\.github/workflows/native-tests\.yml$'; then
            echo "ios=true" >> "$GITHUB_OUTPUT"
          else
            echo "ios=false" >> "$GITHUB_OUTPUT"
          fi
          if echo "$CHANGED" | grep -qE '^scripts/rn-android-runner/|^\.github/workflows/native-tests\.yml$'; then
            echo "android=true" >> "$GITHUB_OUTPUT"
          else
            echo "android=false" >> "$GITHUB_OUTPUT"
          fi

  android-unit:
    name: Android unit (JVM)
    needs: changes
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Skip notice (Android unchanged)
        if: ${{ needs.changes.outputs.android != 'true' }}
        run: echo "No rn-android-runner changes in this PR — skipping the JVM unit tests. Push-to-main runs them unconditionally."
      - name: Checkout
        if: ${{ needs.changes.outputs.android == 'true' }}
        uses: actions/checkout@v4
      - name: Set up Java
        if: ${{ needs.changes.outputs.android == 'true' }}
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
      - name: Set up Gradle (cache)
        if: ${{ needs.changes.outputs.android == 'true' }}
        uses: gradle/actions/setup-gradle@v4
      - name: gradlew testDebugUnitTest
        if: ${{ needs.changes.outputs.android == 'true' }}
        working-directory: scripts/rn-android-runner
        run: ./gradlew testDebugUnitTest --no-daemon
      - name: Upload JUnit report (on failure)
        if: ${{ failure() && needs.changes.outputs.android == 'true' }}
        uses: actions/upload-artifact@v4
        with:
          name: android-unit-report
          path: scripts/rn-android-runner/app/build/reports/tests/
          retention-days: 7

  ios-unit:
    name: iOS unit (simulator)
    needs: changes
    runs-on: macos-15
    timeout-minutes: 25
    steps:
      - name: Skip notice (iOS unchanged)
        if: ${{ needs.changes.outputs.ios != 'true' }}
        run: echo "No rn-fast-runner changes in this PR — skipping the simulator unit tests. Push-to-main runs them unconditionally."
      - name: Checkout
        if: ${{ needs.changes.outputs.ios == 'true' }}
        uses: actions/checkout@v4
      # De-flake: codeql.yml only ever BUILDS for the simulator SDK; this is the
      # first workflow to BOOT a simulator on CI, where cold-boot timeouts are a
      # documented macos-15 image issue (runner-images #12862, #12777). Pre-boot
      # and wait, and fall back to any iPhone if the image drops "iPhone 16".
      - name: Pre-boot simulator
        if: ${{ needs.changes.outputs.ios == 'true' }}
        run: |
          set -euo pipefail
          xcrun simctl list devices available
          UDID="$(xcrun simctl list devices available --json | jq -r '[.devices[] | .[] | select(.name == "iPhone 16")][0].udid // empty')"
          if [ -z "$UDID" ]; then
            echo "No 'iPhone 16' on this image — falling back to the first available iPhone" >&2
            UDID="$(xcrun simctl list devices available --json | jq -r '[.devices[] | .[] | select(.name | startswith("iPhone"))][0].udid // empty')"
          fi
          [ -n "$UDID" ]
          xcrun simctl boot "$UDID" || true
          xcrun simctl bootstatus "$UDID" -b
          echo "RN_IOS_TEST_DESTINATION=id=$UDID" >> "$GITHUB_ENV"
      # Preinstalled Xcode 16.x on macos-15 — same choice as codeql.yml.
      - name: "xcodebuild test (skip-list: server entry + device-dependent test)"
        if: ${{ needs.changes.outputs.ios == 'true' }}
        run: |
          xcodebuild -version
          bash scripts/test-native-ios.sh
      - name: Upload xcresult (on failure)
        if: ${{ failure() && needs.changes.outputs.ios == 'true' }}
        uses: actions/upload-artifact@v4
        with:
          name: ios-unit-xcresult
          path: scripts/rn-fast-runner/build/native-tests.xcresult
          retention-days: 7
```

- [ ] **Step 2: Sanity-check the YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/native-tests.yml')); print('YAML OK')"`
Expected: `YAML OK` (PyYAML is present on the dev machine; if not: `npx --yes yaml-lint .github/workflows/native-tests.yml`).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/native-tests.yml
git commit -S -m "feat(story-06): native-tests workflow — Android JVM + iOS simulator lanes (#387)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Changeset + story-doc status

**Files:**
- Create: `.changeset/story-06-phase-a-native-tests-ci.md`
- Modify: `docs/stories/06-native-runner-ci-and-evals.md` (the `**Status:**` line and the Phase A section)

**Interfaces:**
- Consumes: nothing new. Produces: release-notes entry; story doc reflects reality.

- [ ] **Step 1: Write the changeset**

`.changeset/story-06-phase-a-native-tests-ci.md`:

```markdown
---
'rn-dev-agent-plugin': patch
---

Story 06 Phase A (#387): the native runner unit suites now execute in CI.
`native-tests.yml` runs `gradlew testDebugUnitTest` (ubuntu) and
`xcodebuild test` with a skip-list (macos-15, simulator) — path-filtered with
green skip notices on TS-only PRs, unconditional on pushes to main. Local
entry points: `npm run test:native:android` / `npm run test:native:ios`.
Also removes a dangling `RnFastRunnerTests` testable from the shared scheme.
```

- [ ] **Step 2: Update the story doc**

In `docs/stories/06-native-runner-ci-and-evals.md` change:

```markdown
**Status:** Proposed (2026-07-02)
```

to:

```markdown
**Status:** Phase A implemented (2026-07-05, #387); Phases B/C proposed
```

Replace the Phase A iOS bullet IN PLACE (it cites `-only-testing:RnFastRunnerTests`, a target that does not exist — fix the text, don't annotate it):

```markdown
- **iOS unit tests** (macOS runner): `bash scripts/test-native-ios.sh` — `xcodebuild test` on the `RnFastRunner` scheme with a SKIP-list (`-skip-testing:RnFastRunnerUITests/RnFastRunnerTests`, the production server entry that never returns; `-skip-testing:RnFastRunnerUITests/SnapshotForegroundRegressionTest`, needs the test app installed). New test classes in the folder run automatically (Xcode 16 synchronized groups). Budget ~8–12 min; path-filtered on PRs, unconditional on main.
```

And prepend to the `### Phase A — run the existing native tests (cheap, do first)` section body:

```markdown
> **Implemented 2026-07-05** (#387): `.github/workflows/native-tests.yml` + `scripts/test-native-ios.sh` + root `test:native:*` npm scripts.
> Triage notes: (1) a red on `QuiescenceBypassTests.testProbeResolvedAtBundleLoad` means the CI Xcode's private quiescence selectors drifted ("degrade loudly" by design, #384) — an Xcode-compat issue, not a plugin bug. (2) Any future subclass of `RnFastRunnerTests` inherits the 24-hour `testCommand` and MUST be added to the skip-list in `scripts/test-native-ios.sh`. (3) NEVER move the skips into `RnFastRunnerUITests.xctestplan` as `skippedTests` — `build-for-testing` bakes them into the `.xctestrun` that the PRODUCTION launch (`test-without-building -only-testing:…/testCommand`) consumes, and skips subtract from the only-set, so the runner would never boot.
```

- [ ] **Step 3: Commit**

```bash
git add .changeset/story-06-phase-a-native-tests-ci.md docs/stories/06-native-runner-ci-and-evals.md
git commit -S -m "docs(story-06): Phase A status + changeset (#387)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Push, open the PR, verify both lanes run live

**Files:** none (remote operations)

**Interfaces:**
- Consumes: all previous tasks. Produces: an open PR whose `Native tests` checks are green with lanes EXECUTED (not skip-noticed — the workflow file itself is in both path filters).

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feat/387-native-tests-ci
gh pr create --repo Lykhoyda/rn-dev-agent \
  --title "feat(story-06): Phase A — native runner unit tests in CI (#387)" \
  --body "$(cat <<'EOF'
Phase A of #387 (Story 06). The Swift and Kotlin native-runner unit suites now execute in CI.

## What
- **`.github/workflows/native-tests.yml`** — `codeql.yml`-shaped: ubuntu `changes` pre-flight, then `Android unit (JVM)` (`gradlew testDebugUnitTest`, temurin 17, ~1–2 min) and `iOS unit (simulator)` (`xcodebuild test` on macos-15, ~8–12 min). Lanes with unchanged paths post a green skip notice — checks always report, so the CI-green merge rule holds; TS-only PRs pay ~0 added time. Pushes to main run both lanes unconditionally.
- **Skip-list, not whitelist** (iOS): skips `RnFastRunnerUITests/RnFastRunnerTests` (the production server entry — never returns) and `SnapshotForegroundRegressionTest` (needs the test app installed). New test classes run automatically (Xcode 16 synchronized groups). Runs today: CommandSurfaceTests (3) + KeyboardGuardTests (6) + QuiescenceBypassTests (12).
- **`scripts/test-native-ios.sh`** + root `test:native:android` / `test:native:ios` npm scripts — CI and local runs share the exact invocation.
- **Scheme cleanup**: removed a dangling `RnFastRunnerTests` testable (deleted template target) from the shared scheme.

## Verification
- Local: both npm scripts green (Android 6/6, iOS 21/21 with both skips honored).
- This PR: both lanes executed live (workflow file is in both path filters).
- Mutation check (story acceptance criterion): see the temporary commit below — both lanes went red on a deliberately broken KeyboardGuard predicate, then the commit was reverted. Red runs: <links added after Task 6>.

## Triage notes for future reds
- `QuiescenceBypassTests.testProbeResolvedAtBundleLoad` red → the CI Xcode's private quiescence selectors drifted (degrade-loudly by design, #384) — Xcode-compat triage, not a plugin bug.
- The iOS skips are CLI-only ON PURPOSE: baking them into the xctestplan would flow into the production `.xctestrun` and stop the runner's `-only-testing:…/testCommand` launch from ever starting.

Spec: `docs/superpowers/specs/2026-07-05-387-native-tests-ci-phase-a-design.md`
Phases B/C of #387 remain open (device smoke needs a release with prebuilt artifacts from #382; evals need a budget decision).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Watch the checks**

Run: `gh pr checks --repo Lykhoyda/rn-dev-agent --watch` (or poll `gh pr checks`)
Expected: `Detect native changes`, `Android unit (JVM)`, `iOS unit (simulator)` all pass, WITH real execution (job logs show gradle/xcodebuild output, not the skip notice). Existing CI/CodeQL checks unaffected.
If `iPhone 16` is missing on the CI image (destination error in the log): change the default destination in `scripts/test-native-ios.sh` to an available device from the log's device list, commit, push — one-line fix anticipated by the spec's risk section.

---

### Task 6: Mutation check — prove both lanes actually gate

**Files (temporarily modified, then reverted):**
- `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/KeyboardGuard.swift`
- `scripts/rn-android-runner/app/src/main/java/dev/lykhoyda/rndevagent/androidrunner/KeyboardGuard.kt`

**Interfaces:** none — this task only proves the workflow fails when the code is broken (story acceptance criterion).

- [ ] **Step 1: Break both predicates in one commit**

iOS — in `KeyboardGuard.swift`, change:

```swift
    return keyboardFrame.contains(tapPoint)
```

to:

```swift
    return false
```

Android — in `KeyboardGuard.kt`, change:

```kotlin
        return tapX in imeLeft until imeRight && tapY in imeTop until imeBottom
```

to:

```kotlin
        return false
```

```bash
git add scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/KeyboardGuard.swift scripts/rn-android-runner/app/src/main/java/dev/lykhoyda/rndevagent/androidrunner/KeyboardGuard.kt
git commit -S -m "test(story-06): DO NOT MERGE — mutation check, deliberately broken KeyboardGuard (#387)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push
```

- [ ] **Step 2: Observe both lanes red — WAIT for conclusion before touching the branch**

Run: `gh pr checks --repo Lykhoyda/rn-dev-agent --watch`
Expected: `Android unit (JVM)` FAILS (`occludedWhenInsideImeRect` assertion) and `iOS unit (simulator)` FAILS (KeyboardGuardTests contained-point assertions).
**Do NOT push anything until both lanes CONCLUDE red** — the workflow has `cancel-in-progress: true`, so an early revert push cancels the in-flight red run and destroys the proof. Then save both run URLs:
`gh run list --repo Lykhoyda/rn-dev-agent --branch feat/387-native-tests-ci --workflow native-tests.yml --limit 3 --json databaseId,url,conclusion`

- [ ] **Step 3: Revert the mutation**

```bash
git revert --no-edit HEAD
git push
```

Expected: next `Native tests` run is green again.

- [ ] **Step 4: Record the proof in the PR body**

Edit the PR body's `<links added after Task 6>` placeholder with the two red-run URLs (`gh pr edit --body ...` re-emitting the full body). Also note the observed lane durations vs the ≤12 min budget.

---

## Acceptance (from the spec)

- [ ] Mutation check: both lanes red on a broken KeyboardGuard predicate, once, with linked runs.
- [ ] TS-only PRs: skip-notice path ≈ 0 added time (observable on the next unrelated PR).
- [ ] Native-touching PRs: ≤ 12 min added (iOS lane duration from Task 5/6 runs).
- [ ] Checks post on every PR (run or skip notice).
