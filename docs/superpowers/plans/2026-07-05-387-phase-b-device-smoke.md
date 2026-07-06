# Story 06 Phase B — Nightly Device Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A nightly CI job drives the golden `device_*` command set through the real bridge (MCP over stdio) against tiny native fixture apps on a booted simulator/emulator, plus an artifact-integrity lane — and the Story 01 artifact pipeline actually fires (its `GITHUB_TOKEN` trigger bug is fixed first).

**Architecture:** Two PRs. PR 1 fixes the artifact-pipeline trigger (dispatch-after-merge in `release.yml` + a level-triggered nightly catch-up sweep in `runner-artifacts.yml`). PR 2 adds contract fixture apps (`test-fixtures/`), a golden-set driver reusing `supervisor-harness.js`, and `.github/workflows/nightly-device-smoke.yml` with iOS/Android smoke lanes (main-HEAD runners, cached builds), an artifact-integrity lane (released bits), and 2-consecutive-red alerting.

**Tech Stack:** GitHub Actions, bash+jq, SwiftUI (swiftc-built fixture, no Xcode project), Kotlin + android.widget (Gradle fixture reusing rn-android-runner's wrapper), Node 22 `node:test` + the existing MCP stdio harness.

**Spec:** `docs/superpowers/specs/2026-07-05-387-phase-b-device-smoke-design.md` (approved 2026-07-05).

## Global Constraints

- Signed commits: `git commit -S`, message trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- NEVER add `skippedTests` to `RnFastRunnerUITests.xctestplan` (D1312) — not touched by this plan; stated so nobody "helpfully" adds it.
- Fixture app id (both platforms, exact): `dev.lykhoyda.rndevagent.fixture`.
- Element identifiers (exact): `fixture_button`, `fixture_count`, `fixture_input`, `fixture_list`, `fixture_row_<n>` (1–100), `fixture_bottom_input`, `fixture_bottom_button`, `fixture_bottom_count`.
- Keyboard-guard contract (#370), asserted platform-conditionally: Android → `ok:true`, `meta.keyboardGuard: "dismissed"`; iOS → refusal with `KEYBOARD_OCCLUDED` and `keyboardGuard=dismiss_failed`.
- Smoke lanes must run the bridge with `RN_RUNNER_BUILD=local` (forces `build-local` provenance — `runner-artifacts.ts:156` — so a version-matching release can never shadow the fresh main-HEAD build).
- Branches: PR 1 = `fix/382-runner-artifacts-trigger`, PR 2 = `feat/387-phase-b-device-smoke` (both off `origin/main`).
- One changeset per PR: `'rn-dev-agent-plugin': patch`.
- Workflow YAML validation command (run from repo root; js-yaml is a root dep):
  `node -e "require('js-yaml').load(require('fs').readFileSync(process.argv[1],'utf8')); console.log('YAML OK')" <file>`
- The driver is **TypeScript** (`device-smoke.ts`), executed directly via Node's type stripping (Node >= 22.18): any new `.mjs`/`.js` file fails ci.yml's `scripts/check-typescript-only.sh` gate on every PR (files not in `scripts/js-migration-baseline.txt` are rejected), so a `.mjs` driver could never merge.
- `oxlint` + `oxfmt --check` must stay green (they cover the new `.ts` driver).
- No `dist/` rebuild needed — this plan changes no bridge TypeScript.
- Workspace docs (`../rn-dev-agent-workspace` = `/Users/anton_personal/GitHub/rn-dev-agent-workspace`): BUGS/DECISIONS/ROADMAP entries are committed in the workspace repo directly (auto-commit is pre-authorized there).
- Android fixture reuses the runner's Gradle wrapper: `scripts/rn-android-runner/gradlew -p test-fixtures/android-fixture …` (no second wrapper jar in the repo). Pin the same toolchain: AGP 8.7.3, Kotlin 2.0.21, compileSdk 35, Java 17.

---

## PR 1 — make the artifact pipeline fire

> **SUPERSEDED at execution start (2026-07-06).** Tasks 1–3 shipped independently on
> main while this session was suspended: PR #473 ("self-healing runner-artifacts
> gate — state-based check + scheduled sweep", B258) implements a superset of
> Task 1 (the state check runs on EVERY trigger, 6-hourly sweep at `23 */6 * * *`),
> and PR #470 fixed the iOS artifact build (macos-15/Xcode 16). No release.yml
> dispatch step exists — the sweep's ≤6 h lag was accepted instead (their call,
> equivalent outcome). Proven end-to-end: `runner-manifest.json` on main is
> populated for v0.64.6 with real sha256/bytes for both platforms. Only PR 2
> (Tasks 4–9) remains to execute; the integrity lane verifies the already-published
> release. Tasks 1–3 below are retained for the record, NOT for execution.

### Task 1: Catch-up sweep in `runner-artifacts.yml`

The pipeline's `detect` job only reacts to a version-bump push — an event that can never fire because `release.yml` merges Version PRs with `GITHUB_TOKEN` (GitHub suppresses workflow triggers for pushes made with that token; bump commits `c4b7afe8`/`462ac66f`/`8e9b844c`/`3fe5e328` have zero runner-artifacts runs). This task makes the workflow level-triggered: on a nightly schedule (and on plain `workflow_dispatch`), it publishes whenever the current version's release is missing any runner asset or the committed manifest lags.

**Files:**
- Modify: `.github/workflows/runner-artifacts.yml` (triggers + the `id: v` detect step)

**Interfaces:**
- Consumes: `.claude-plugin/plugin.json` `.version`; `runner-manifest.json` `.version`; `gh release view v<V> --json assets`.
- Produces: unchanged step outputs `version` / `changed` — the downstream build jobs need no edits.

- [ ] **Step 1: Cut the PR 1 branch**

```bash
git fetch origin main
git checkout -b fix/382-runner-artifacts-trigger origin/main
```

- [ ] **Step 2: Add the schedule trigger**

In `.github/workflows/runner-artifacts.yml`, replace the `on:` block (lines 21–29) with:

```yaml
on:
  push:
    branches: [main]
  # Catch-up sweep (#387 Phase B / GH #382 bug): the Version-PR merge is pushed
  # with GITHUB_TOKEN, so the bump push can never trigger this workflow
  # (recursion guard). Nightly, converge on "current version has all artifacts".
  # Runs before the 03:00 nightly device smoke so its integrity lane sees them.
  schedule:
    - cron: '30 1 * * *'
  workflow_dispatch:
    inputs:
      force_version:
        description: Build+publish artifacts for this exact version (skips bump detection)
        required: false
        default: ''
```

- [ ] **Step 3: Rework the detect step**

Replace the `id: v` step's `run:` block (the whole bash script, lines 52–67) with:

```yaml
        run: |
          if [ -n "$FORCE_VERSION" ]; then
            echo "version=$FORCE_VERSION" >> "$GITHUB_OUTPUT"
            echo "changed=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          CUR=$(jq -r '.version' .claude-plugin/plugin.json)
          echo "version=$CUR" >> "$GITHUB_OUTPUT"
          if [ "$GITHUB_EVENT_NAME" = "schedule" ] || [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ]; then
            # Level-triggered catch-up: rebuild when the current version's release
            # is missing any runner asset, or the committed manifest lags it.
            NEED=false
            if gh release view "v$CUR" --json assets --jq '[.assets[].name]' > /tmp/assets.json 2>/dev/null; then
              for A in "rn-fast-runner-$CUR-sim.zip" "rn-android-runner-$CUR.zip" "runner-manifest.json"; do
                grep -qF "\"$A\"" /tmp/assets.json || { echo "missing asset: $A"; NEED=true; }
              done
            else
              echo "release v$CUR does not exist yet"
              NEED=true
            fi
            MANIFEST_V=$(jq -r '.version // "none"' runner-manifest.json 2>/dev/null || echo none)
            [ "$MANIFEST_V" = "$CUR" ] || NEED=true
            echo "catch-up: version=$CUR need=$NEED (manifest=$MANIFEST_V)"
            echo "changed=$NEED" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          git show HEAD~1:.claude-plugin/plugin.json > /tmp/prev.json 2>/dev/null || echo '{}' > /tmp/prev.json
          PREV=$(jq -r '.version // "none"' /tmp/prev.json)
          echo "current=$CUR previous=$PREV"
          if [ "$CUR" != "$PREV" ]; then
            echo "changed=true" >> "$GITHUB_OUTPUT"
          else
            echo "changed=false" >> "$GITHUB_OUTPUT"
          fi
```

And add `GH_TOKEN` to that step's `env:` (the catch-up branch calls `gh release view`):

```yaml
        env:
          FORCE_VERSION: ${{ github.event.inputs.force_version }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Also update the workflow's header comment (lines 3–19): replace the sentence
"It is wired to fire once per release: on push to main it detects a plugin.json
version bump" with a note that the push trigger cannot fire for bot-merged
Version PRs (GITHUB_TOKEN recursion guard) and that the release-time
`workflow_dispatch` from release.yml plus the nightly catch-up sweep are the
real publish paths.

- [ ] **Step 4: Validate the YAML**

```bash
node -e "require('js-yaml').load(require('fs').readFileSync(process.argv[1],'utf8')); console.log('YAML OK')" .github/workflows/runner-artifacts.yml
```
Expected: `YAML OK`

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/runner-artifacts.yml
git commit -S -m "fix(story-01): level-triggered catch-up sweep for runner artifacts (#382, #387)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: Dispatch-after-merge in `release.yml`

**Files:**
- Modify: `.github/workflows/release.yml` (permissions + one new step after the merge step)

**Interfaces:**
- Consumes: `steps.changesets.outputs.pullRequestNumber` (existing); `origin/main:.claude-plugin/plugin.json` after the merge.
- Produces: a `workflow_dispatch` of `runner-artifacts.yml` with `force_version=<bumped version>`.

- [ ] **Step 1: Add `actions: write` permission**

Replace the `permissions:` block (lines 26–28) with:

```yaml
permissions:
  contents: write
  pull-requests: write
  actions: write
```

(`gh workflow run` needs `actions: write`; with an explicit permissions block, anything unlisted is denied.)

- [ ] **Step 2: Append the dispatch step**

Add after the "Merge the Version Packages PR" step (after line 81):

```yaml
      # #382 trigger bug: the merge above used GITHUB_TOKEN, so the bump push
      # fires no workflows (recursion guard). workflow_dispatch is the
      # documented exception — dispatch the artifact build explicitly. In the
      # --auto path the merge may not have landed yet; skip, and the nightly
      # catch-up sweep in runner-artifacts.yml converges within 24 h.
      - name: Dispatch runner-artifacts for the released version
        if: steps.changesets.outputs.pullRequestNumber
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ steps.changesets.outputs.pullRequestNumber }}
        run: |
          STATE=$(gh pr view "$PR_NUMBER" --json state --jq .state)
          if [ "$STATE" != "MERGED" ]; then
            echo "Version PR #$PR_NUMBER not merged yet (state=$STATE) — leaving artifact publish to the nightly catch-up sweep"
            exit 0
          fi
          git fetch origin main
          V=$(git show origin/main:.claude-plugin/plugin.json | jq -r .version)
          echo "dispatching runner-artifacts for v$V"
          gh workflow run runner-artifacts.yml -f force_version="$V"
```

- [ ] **Step 3: Validate the YAML**

```bash
node -e "require('js-yaml').load(require('fs').readFileSync(process.argv[1],'utf8')); console.log('YAML OK')" .github/workflows/release.yml
```
Expected: `YAML OK`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -S -m "fix(story-01): dispatch runner-artifacts after Version PR merge (#382, #387)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3: Ship PR 1 and prove the pipeline publishes

**Files:**
- Create: `.changeset/story-01-runner-artifacts-trigger-fix.md`
- Workspace: append to `/Users/anton_personal/GitHub/rn-dev-agent-workspace/docs/BUGS.md` and `DECISIONS.md`

- [ ] **Step 1: Changeset**

```markdown
---
'rn-dev-agent-plugin': patch
---

Fix the Story 01 runner-artifact pipeline never firing: Version-PR merges use GITHUB_TOKEN, whose pushes trigger no workflows. release.yml now dispatches runner-artifacts.yml (workflow_dispatch is exempt from the recursion guard) after the merge, and a nightly catch-up sweep publishes whenever the current version's release lacks any runner asset.
```

```bash
git add .changeset/story-01-runner-artifacts-trigger-fix.md
git commit -S -m "chore(story-01): changeset for the artifact-pipeline trigger fix (#382)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Workspace bug + decision entries** (next B/D numbers from the files' tails)

BUGS.md entry (adjust the B-number): the trigger bug, root cause (GITHUB_TOKEN recursion guard vs push-triggered detect), evidence (bump commits with no runs), fix (dispatch + sweep).
DECISIONS.md entry (adjust the D-number): "Artifact publishing is level-triggered (dispatch-after-merge + nightly catch-up sweep) rather than PAT-based — no new credentials; workflow_dispatch is exempt from the recursion guard."
Commit both in the workspace repo (pre-authorized).

- [ ] **Step 3: Push, open PR 1**

```bash
git push -u origin fix/382-runner-artifacts-trigger
gh pr create --title "fix(story-01): make the runner-artifact pipeline actually fire (#382)" --body "<summary of bug + two mechanisms + evidence links>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 4: CI green + review threads addressed → merge** (standing merge rule; squash)

- [ ] **Step 5: Prove publishing end-to-end (acceptance)**

After merge, dispatch the sweep once instead of waiting for the cron:

```bash
gh workflow run runner-artifacts.yml
gh run watch $(gh run list --workflow=runner-artifacts.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: detect → `changed=true` (catch-up), all three build jobs run, and:

```bash
V=$(jq -r .version .claude-plugin/plugin.json)   # after git pull
gh release view "v$V" --json assets --jq '[.assets[].name]'
```
returns all three assets; `origin/main` gains the `chore(release): runner-manifest for v$V [skip ci]` commit with a populated `runner-manifest.json`.

---

## PR 2 — fixtures, driver, nightly workflow

### Task 4: iOS contract fixture

A single-file SwiftUI app compiled with `swiftc` — no Xcode project. `.ignoresSafeArea(.keyboard)` disables SwiftUI's automatic keyboard avoidance so the bottom bar is genuinely occluded by the keyboard (the keyboard-guard scenario depends on this).

**Files:**
- Create: `test-fixtures/ios-fixture/Sources/FixtureApp.swift`
- Create: `test-fixtures/ios-fixture/Info.plist`
- Create: `test-fixtures/ios-fixture/build.sh` (mode 755)
- Create: `test-fixtures/ios-fixture/README.md`
- Modify: `.gitignore` (add `test-fixtures/ios-fixture/build/`)

**Interfaces:**
- Produces: `test-fixtures/ios-fixture/build/Fixture.app` with bundle id `dev.lykhoyda.rndevagent.fixture`; the element identifiers from Global Constraints (iOS matcher is `identifier == %@ OR label == %@`, so `.accessibilityIdentifier(...)` is the contract).

- [ ] **Step 1: Write `Sources/FixtureApp.swift`**

```swift
import SwiftUI

@main
struct FixtureApp: App {
  var body: some Scene {
    WindowGroup { ContentView() }
  }
}

struct ContentView: View {
  @State private var count = 0
  @State private var text = ""
  @State private var bottomText = ""
  @State private var bottomTaps = 0

  var body: some View {
    VStack(spacing: 8) {
      Button("Increment") { count += 1 }
        .accessibilityIdentifier("fixture_button")
      Text("count: \(count)")
        .accessibilityIdentifier("fixture_count")
      TextField("type here", text: $text)
        .textFieldStyle(.roundedBorder)
        .accessibilityIdentifier("fixture_input")
        .padding(.horizontal)
      List(1...100, id: \.self) { n in
        Text("row \(n)")
          .accessibilityIdentifier("fixture_row_\(n)")
      }
      .accessibilityIdentifier("fixture_list")
      HStack {
        TextField("bottom", text: $bottomText)
          .textFieldStyle(.roundedBorder)
          .accessibilityIdentifier("fixture_bottom_input")
        Button("Tap") { bottomTaps += 1 }
          .accessibilityIdentifier("fixture_bottom_button")
      }
      .padding(.horizontal)
      Text("bottom taps: \(bottomTaps)")
        .accessibilityIdentifier("fixture_bottom_count")
    }
    .padding(.vertical)
    // Keyboard-guard contract fixture: keep the bottom bar UNDER the keyboard.
    .ignoresSafeArea(.keyboard)
  }
}
```

- [ ] **Step 2: Write `Info.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>Fixture</string>
  <key>CFBundleIdentifier</key><string>dev.lykhoyda.rndevagent.fixture</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Fixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
  <key>DTPlatformName</key><string>iphonesimulator</string>
  <key>DTSDKName</key><string>iphonesimulator</string>
  <key>LSRequiresIPhoneOS</key><true/>
  <key>MinimumOSVersion</key><string>16.0</string>
  <key>UILaunchScreen</key><dict/>
  <key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string></array>
</dict>
</plist>
```

- [ ] **Step 3: Write `build.sh`**

```bash
#!/usr/bin/env bash
# Builds the iOS contract fixture as an unsigned simulator .app — no Xcode
# project needed (single-file SwiftUI app compiled with swiftc).
set -euo pipefail
cd "$(dirname "$0")"
ARCH="${FIXTURE_ARCH:-$(uname -m)}"
OUT=build/Fixture.app
rm -rf build
mkdir -p "$OUT"
xcrun -sdk iphonesimulator swiftc \
  -parse-as-library -O \
  -target "$ARCH-apple-ios16.0-simulator" \
  Sources/FixtureApp.swift \
  -o "$OUT/Fixture"
cp Info.plist "$OUT/Info.plist"
codesign --force --sign - "$OUT"
echo "built $OUT"
```

```bash
chmod +x test-fixtures/ios-fixture/build.sh
```

- [ ] **Step 4: README.md** — one paragraph: what the fixture is (contract fixture for the nightly golden set, element table from the spec), how to build (`bash build.sh`), install (`xcrun simctl install booted build/Fixture.app`), launch (`xcrun simctl launch booted dev.lykhoyda.rndevagent.fixture`).

- [ ] **Step 5: `.gitignore`** — append:

```
test-fixtures/ios-fixture/build/
```

- [ ] **Step 6: Build + install on the booted local simulator (test)**

```bash
bash test-fixtures/ios-fixture/build.sh
xcrun simctl list devices booted    # boot one via Simulator.app if empty
xcrun simctl install booted test-fixtures/ios-fixture/build/Fixture.app
xcrun simctl launch booted dev.lykhoyda.rndevagent.fixture
```
Expected: launch prints a PID; the app shows the Increment button, count label, field, list, bottom bar.

This step is a HARD GATE: the handcrafted-bundle risk (swiftc-built .app, no Xcode project) lives entirely here — do not start Tasks 6 or 8 until install + launch is verified on a real simulator.

- [ ] **Step 7: Commit**

```bash
git add test-fixtures/ios-fixture .gitignore
git commit -S -m "feat(story-06): iOS contract fixture app for the device smoke (#387)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 5: Android contract fixture

Pure `android.widget` (no androidx dependency), reusing rn-android-runner's Gradle wrapper via `-p`. `android:windowSoftInputMode="adjustNothing"` keeps the bottom bar under the keyboard (occlusion contract). List rows are matched by their visible text (`row <n>`) — note `simple_list_item_1` rows already carry `android:id/text1`, so the snapshot identifier is `text1`; the additional `contentDescription = "fixture_row_<n>"` is informational (the desc fallback only applies to views whose resource-id is blank).

**Files:**
- Create: `test-fixtures/android-fixture/settings.gradle.kts`
- Create: `test-fixtures/android-fixture/build.gradle.kts`
- Create: `test-fixtures/android-fixture/app/build.gradle.kts`
- Create: `test-fixtures/android-fixture/app/src/main/AndroidManifest.xml`
- Create: `test-fixtures/android-fixture/app/src/main/java/dev/lykhoyda/rndevagent/fixture/MainActivity.kt`
- Create: `test-fixtures/android-fixture/app/src/main/res/layout/activity_main.xml`
- Create: `test-fixtures/android-fixture/README.md`
- Modify: `.gitignore` (fixture build dirs)

**Interfaces:**
- Produces: `test-fixtures/android-fixture/app/build/outputs/apk/debug/app-debug.apk`, applicationId `dev.lykhoyda.rndevagent.fixture`; identifiers via `android:id` (top-level elements) and `contentDescription` (list rows).

- [ ] **Step 1: `settings.gradle.kts`**

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "RnDevAgentFixture"
include(":app")
```

- [ ] **Step 2: root `build.gradle.kts`**

```kotlin
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
```

- [ ] **Step 3: `app/build.gradle.kts`**

```kotlin
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.lykhoyda.rndevagent.fixture"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.lykhoyda.rndevagent.fixture"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}
```

- [ ] **Step 4: `AndroidManifest.xml`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="Fixture">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:windowSoftInputMode="adjustNothing">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

- [ ] **Step 5: `MainActivity.kt`**

```kotlin
package dev.lykhoyda.rndevagent.fixture

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.TextView

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val count = findViewById<TextView>(R.id.fixture_count)
        var taps = 0
        findViewById<View>(R.id.fixture_button).setOnClickListener {
            taps += 1
            count.text = "count: $taps"
        }

        val bottomCount = findViewById<TextView>(R.id.fixture_bottom_count)
        var bottomTaps = 0
        findViewById<View>(R.id.fixture_bottom_button).setOnClickListener {
            bottomTaps += 1
            bottomCount.text = "bottom taps: $bottomTaps"
        }

        val rows = (1..100).map { "row $it" }
        val list = findViewById<ListView>(R.id.fixture_list)
        list.adapter = object : ArrayAdapter<String>(this, android.R.layout.simple_list_item_1, rows) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                val v = super.getView(position, convertView, parent)
                v.contentDescription = "fixture_row_${position + 1}"
                return v
            }
        }
    }
}
```

- [ ] **Step 6: `res/layout/activity_main.xml`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="vertical"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:padding="8dp">

    <!-- textAllCaps=false: device_find exact-matches "Increment" case-sensitively;
         the platform default would render/announce "INCREMENT". -->
    <Button
        android:id="@+id/fixture_button"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:textAllCaps="false"
        android:text="Increment" />

    <TextView
        android:id="@+id/fixture_count"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="count: 0" />

    <EditText
        android:id="@+id/fixture_input"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:hint="type here"
        android:inputType="text" />

    <ListView
        android:id="@+id/fixture_list"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1" />

    <LinearLayout
        android:orientation="horizontal"
        android:layout_width="match_parent"
        android:layout_height="wrap_content">

        <EditText
            android:id="@+id/fixture_bottom_input"
            android:layout_width="0dp"
            android:layout_weight="1"
            android:layout_height="wrap_content"
            android:hint="bottom"
            android:inputType="text" />

        <Button
            android:id="@+id/fixture_bottom_button"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:textAllCaps="false"
            android:text="Tap" />
    </LinearLayout>

    <TextView
        android:id="@+id/fixture_bottom_count"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="bottom taps: 0" />
</LinearLayout>
```

- [ ] **Step 7: README.md** — build (`scripts/rn-android-runner/gradlew -p test-fixtures/android-fixture :app:assembleDebug`), install (`adb install -r app/build/outputs/apk/debug/app-debug.apk`), why `adjustNothing` (occlusion contract) and why rows use `contentDescription`.

- [ ] **Step 8: `.gitignore`** — append:

```
test-fixtures/android-fixture/.gradle/
test-fixtures/android-fixture/**/build/
```

- [ ] **Step 9: Build (test)**

```bash
scripts/rn-android-runner/gradlew -p test-fixtures/android-fixture :app:assembleDebug --no-daemon
ls test-fixtures/android-fixture/app/build/outputs/apk/debug/app-debug.apk
```
Expected: `BUILD SUCCESSFUL`; the APK exists. If an emulator is running, also `adb install -r …` + launch and eyeball the layout.

- [ ] **Step 10: Commit**

```bash
git add test-fixtures/android-fixture .gitignore
git commit -S -m "feat(story-06): Android contract fixture app for the device smoke (#387)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 6: Golden-set driver + npm entries (iOS local green)

**Files:**
- Create: `scripts/cdp-bridge/test/smoke/device-smoke.ts`
- Modify: `package.json` (root — two scripts)

**Interfaces:**
- Consumes: `startSupervisor({cwd, env, lineTimeoutMs})` → `{child, nextLine, send, notify, stderrText}` from `../helpers/supervisor-harness.js`; tool envelopes `JSON.parse(result.content[0].text)` = `{ok, data, meta}`; snapshot nodes `{ref, identifier?, label?}`.
- Produces: `npm run smoke:ios` / `smoke:android` (env `SMOKE_PLATFORM` baked in; `SMOKE_APP_ID`, `SMOKE_DEBUG_DIR` optional overrides), exit 0 on green.

- [ ] **Step 1: Root `package.json` scripts** (after `test:native:ios`):

```json
    "smoke:ios": "SMOKE_PLATFORM=ios node scripts/cdp-bridge/test/smoke/device-smoke.ts",
    "smoke:android": "SMOKE_PLATFORM=android node scripts/cdp-bridge/test/smoke/device-smoke.ts",
```

- [ ] **Step 2: Write the driver**

```javascript
// Story 06 Phase B (#387): golden device_* command set through the real
// bridge (dist/supervisor.js over MCP stdio) against the contract fixture
// app (test-fixtures/). SMOKE_PLATFORM=ios|android selects the lane. CDP is
// intentionally absent — device_fill exercises its native read-back path.
// RN_RUNNER_BUILD=local pins runner provenance to the checkout's own build.
// Executed directly as TypeScript via Node >= 22.18 type stripping (a .mjs
// file would fail ci.yml's check-typescript-only gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSupervisor } from '../helpers/supervisor-harness.js';

const PLATFORM = process.env.SMOKE_PLATFORM;
const APP_ID = process.env.SMOKE_APP_ID ?? 'dev.lykhoyda.rndevagent.fixture';
const DEBUG_DIR = process.env.SMOKE_DEBUG_DIR ?? join(tmpdir(), 'rn-agent-smoke-debug');
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

if (PLATFORM !== 'ios' && PLATFORM !== 'android') {
  console.error('SMOKE_PLATFORM must be "ios" or "android"');
  process.exit(1);
}

function assertFixtureInstalled() {
  try {
    if (PLATFORM === 'ios') {
      execFileSync('xcrun', ['simctl', 'get_app_container', 'booted', APP_ID], { stdio: 'pipe' });
    } else {
      const out = execFileSync('adb', ['shell', 'pm', 'path', APP_ID], { stdio: 'pipe' }).toString();
      if (!out.includes('package:')) throw new Error('not installed');
    }
  } catch {
    console.error(
      `Fixture app ${APP_ID} is not installed on the booted ${PLATFORM} device.\n` +
        `Build + install it first — see test-fixtures/${PLATFORM}-fixture/README.md`,
    );
    process.exit(1);
  }
}

async function rpc(s, method, params) {
  const id = s.send(method, params);
  for (;;) {
    const line = JSON.parse(await s.nextLine());
    if (line.id === id) return line;
    // Anything else (notifications, requests from the server) is skipped.
  }
}

async function callTool(s, name, args = {}) {
  const line = await rpc(s, 'tools/call', { name, arguments: args });
  const text = line.result?.content?.[0]?.text ?? '';
  let envelope = null;
  try {
    envelope = JSON.parse(text);
  } catch {
    // Non-JSON tool output (e.g. image content) — callers use `raw`.
  }
  return { raw: line, isError: Boolean(line.result?.isError), envelope, text };
}

const refFor = (snapEnvelope, identifier) =>
  snapEnvelope?.data?.nodes?.find((n) => n.identifier === identifier)?.ref;

test(`Phase B golden set (${PLATFORM})`, { timeout: 900_000 }, async () => {
  assertFixtureInstalled();
  mkdirSync(DEBUG_DIR, { recursive: true });
  const cwd = mkdtempSync(join(tmpdir(), 'rn-agent-smoke-'));
  const s = startSupervisor({ cwd, lineTimeoutMs: 600_000, env: { RN_RUNNER_BUILD: 'local' } });
  const steps = [];
  const record = (name, r) => {
    steps.push({ name, isError: r.isError, envelope: r.envelope });
    console.log(`step ${name}: ${r.isError ? 'ERROR' : (r.envelope?.ok ?? 'n/a')}`);
    return r;
  };

  try {
    const init = await rpc(s, 'initialize');
    assert.ok(init.result, 'initialize must return a result');
    s.notify('notifications/initialized');

    const open = record(
      'open',
      await callTool(s, 'device_snapshot', { action: 'open', platform: PLATFORM, appId: APP_ID }),
    );
    assert.equal(open.envelope?.ok, true, `open failed: ${open.text.slice(0, 500)}`);

    let snap = record('snapshot', await callTool(s, 'device_snapshot', { action: 'snapshot' }));
    assert.equal(snap.envelope?.ok, true, `snapshot failed: ${snap.text.slice(0, 500)}`);
    for (const id of ['fixture_button', 'fixture_count', 'fixture_input', 'fixture_bottom_button']) {
      assert.ok(refFor(snap.envelope, id), `snapshot missing @ref for ${id}`);
    }

    const find = record('find', await callTool(s, 'device_find', { text: 'Increment', exact: true }));
    assert.equal(find.envelope?.ok, true, `find failed: ${find.text.slice(0, 500)}`);

    const press = record(
      'press',
      await callTool(s, 'device_press', { ref: refFor(snap.envelope, 'fixture_button') }),
    );
    assert.equal(press.envelope?.ok, true, `press failed: ${press.text.slice(0, 500)}`);
    assert.ok(press.envelope?.meta?.settle, 'press must report meta.settle');

    snap = record('snapshot-2', await callTool(s, 'device_snapshot', { action: 'snapshot' }));
    const countNode = snap.envelope?.data?.nodes?.find((n) => n.identifier === 'fixture_count');
    assert.ok(countNode, 'fixture_count missing from the post-press snapshot');
    assert.match(countNode.label ?? '', /count: 1/, 'counter must increment after press');

    // device_scrollintoview does exactly ONE blind swipe when the target is
    // absent from the snapshot (device-interact.ts:1383) — row 80 is ~3 screens
    // away, so scroll until the row is IN a snapshot, then let the verb finish
    // on its supported (target-visible) path.
    let rowVisible = false;
    for (let i = 0; i < 10 && !rowVisible; i++) {
      const scroll = record(`scroll-${i}`, await callTool(s, 'device_scroll', { direction: 'down' }));
      assert.equal(scroll.envelope?.ok, true, `scroll failed: ${scroll.text.slice(0, 500)}`);
      const look = record(`snapshot-scroll-${i}`, await callTool(s, 'device_snapshot', { action: 'snapshot' }));
      rowVisible = Boolean(
        look.envelope?.data?.nodes?.some((n) => n.label === 'row 80' || n.identifier === 'fixture_row_80'),
      );
    }
    assert.ok(rowVisible, 'row 80 never appeared in a snapshot after 10 scrolls');

    const into = record(
      'scrollintoview',
      await callTool(s, 'device_scrollintoview', { text: 'row 80' }),
    );
    assert.equal(into.envelope?.ok, true, `scrollintoview failed: ${into.text.slice(0, 500)}`);

    const shot = record('screenshot', await callTool(s, 'device_screenshot', {}));
    const shotPath = shot.envelope?.data?.path;
    if (shotPath) {
      const head = [...readFileSync(shotPath).subarray(0, 8)];
      assert.deepEqual(head, PNG_MAGIC, 'screenshot file must be a PNG');
    } else {
      const img = shot.raw.result?.content?.find((c) => c.type === 'image');
      assert.ok(img?.data, `screenshot returned neither a path nor image content: ${shot.text.slice(0, 300)}`);
    }

    snap = record('snapshot-3', await callTool(s, 'device_snapshot', { action: 'snapshot' }));
    const fill = record(
      'fill',
      await callTool(s, 'device_fill', { ref: refFor(snap.envelope, 'fixture_input'), text: 'hello smoke' }),
    );
    assert.equal(fill.envelope?.ok, true, `fill failed: ${fill.text.slice(0, 500)}`);

    // Keyboard-guard scenario (#370 contract): the fill above left the
    // keyboard up; the bottom bar sits under it by fixture design.
    const kb = record(
      'keyboard-guard',
      await callTool(s, 'device_press', { ref: refFor(snap.envelope, 'fixture_bottom_button') }),
    );
    const guard = kb.envelope?.meta?.keyboardGuard;
    if (PLATFORM === 'android') {
      // no_keyboard = environment problem (soft IME never appeared), not a
      // contract result — fail with the fix, don't let it masquerade.
      assert.notEqual(
        guard,
        'no_keyboard',
        'Soft keyboard never appeared — the emulator needs `adb shell settings put secure show_ime_with_hard_keyboard 1` (the nightly workflow sets it)',
      );
      assert.equal(kb.envelope?.ok, true, `keyboard-guard press failed: ${kb.text.slice(0, 500)}`);
      assert.equal(guard, 'dismissed', 'Android must dismiss the keyboard first');
    } else {
      assert.notEqual(
        kb.envelope?.ok,
        true,
        `iOS keyboard-guard scenario invalid: the tap went through (keyboardGuard=${guard}). ` +
          'The software keyboard likely never appeared on this headless simulator — environment problem, not a contract pass.',
      );
      const body = kb.text;
      assert.match(body, /KEYBOARD_OCCLUDED/, `expected KEYBOARD_OCCLUDED: ${body.slice(0, 500)}`);
      assert.match(body, /dismiss_failed/, `expected keyboardGuard=dismiss_failed: ${body.slice(0, 500)}`);
    }

    const neg = record(
      'negative-find',
      await callTool(s, 'device_find', { text: 'fixture_does_not_exist_zz', exact: true }),
    );
    assert.ok(neg.isError || neg.envelope?.ok === false, 'nonexistent element must yield an error envelope');

    const alive = record('snapshot-4', await callTool(s, 'device_snapshot', { action: 'snapshot' }));
    assert.equal(alive.envelope?.ok, true, 'bridge must stay healthy after the negative case');
    const total = Object.values(alive.envelope?.meta?.timings_ms ?? {}).reduce(
      (a, b) => (typeof b === 'number' ? a + b : a),
      0,
    );
    assert.ok(total < 20_000, `snapshot too slow: ${total}ms (ceiling 20000)`);

    const close = record('close', await callTool(s, 'device_snapshot', { action: 'close' }));
    assert.equal(close.envelope?.ok, true, `close failed: ${close.text.slice(0, 500)}`);
  } finally {
    writeFileSync(join(DEBUG_DIR, `smoke-${PLATFORM}-steps.json`), JSON.stringify(steps, null, 2));
    s.child.kill('SIGTERM');
  }
});
```

- [ ] **Step 3: Run against the local booted iOS simulator (test)**

Prerequisites: simulator booted, fixture installed (Task 4 Step 6), `scripts/cdp-bridge` deps installed (`cd scripts/cdp-bridge && npm ci`).

```bash
npm run smoke:ios
```
Expected: all steps log `ok`, `pass 1`. First run may pay a runner build (RN_RUNNER_BUILD=local with no DerivedData). If an envelope-shape assertion fails (e.g. screenshot path field), fix the DRIVER to the real envelope — the tools are the contract, the driver adapts.

- [ ] **Step 4: Lint + format**

```bash
npx oxlint scripts/cdp-bridge/test/smoke/device-smoke.ts && npx oxfmt --check scripts/cdp-bridge/test/smoke/device-smoke.ts
```

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/test/smoke/device-smoke.ts package.json
git commit -S -m "feat(story-06): golden-set device smoke driver over MCP stdio (#387)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 7: Android local green

**Files:**
- Modify (only if the Android run surfaces driver/fixture issues): `scripts/cdp-bridge/test/smoke/device-smoke.ts`, `test-fixtures/android-fixture/**`

- [ ] **Step 1: Boot an emulator, install the fixture**

```bash
adb devices    # ensure one emulator
adb shell settings put secure show_ime_with_hard_keyboard 1
scripts/rn-android-runner/gradlew -p test-fixtures/android-fixture :app:assembleDebug --no-daemon
adb install -r test-fixtures/android-fixture/app/build/outputs/apk/debug/app-debug.apk
```
(The `show_ime_with_hard_keyboard` setting forces the soft IME even though emulators expose a hardware keyboard — without it the keyboard-guard step reports `no_keyboard`.)

- [ ] **Step 2: Run the driver**

```bash
npm run smoke:android
```
Expected: `pass 1`, including `keyboardGuard: "dismissed"` on the keyboard step. Likely first-run findings: identifier mismatches (resource-id normalization) or `adjustNothing` behavior — fix in the fixture/driver, re-run to green.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A scripts/cdp-bridge/test/smoke test-fixtures/android-fixture
git commit -S -m "fix(story-06): Android lane fixes for the golden-set driver (#387)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
(Skip the commit if no changes were needed — note that in the report.)

### Task 8: Nightly workflow

**Files:**
- Create: `.github/workflows/nightly-device-smoke.yml`

**Interfaces:**
- Consumes: `npm run smoke:ios|android`; fixture build commands from Tasks 4–5; `runner-manifest.json` (`{version, assets: {ios: [{name, sha256, bytes}], android: [...]}}`).
- Produces: nightly schedule + dispatch; tracking-issue alerting on the `nightly-smoke-red` label.

- [ ] **Step 1: Write the workflow**

```yaml
name: Nightly device smoke

# Story 06 Phase B (#387): golden device_* set through the real bridge
# (dist/supervisor.js over MCP stdio) against the contract fixtures, plus an
# artifact-integrity lane for the Story 01 release artifacts. Nightly and NOT
# merge-gating by design; alerting fires only on 2 consecutive red scheduled
# runs (report job). Smoke lanes build main-HEAD runners (cached) —
# RUNNER_COMMANDS_STALE noise from old release bits is impossible here.

on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch: {}

concurrency: nightly-device-smoke

permissions:
  contents: read
  issues: write
  actions: read

jobs:
  ios-smoke:
    name: iOS device smoke
    runs-on: macos-15
    timeout-minutes: 40
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install bridge deps
        working-directory: scripts/cdp-bridge
        run: npm ci
      - name: Xcode version for the cache key
        run: echo "XCODE_V=$(xcodebuild -version | head -1 | tr ' ' '-')" >> "$GITHUB_ENV"
      - name: Restore runner DerivedData
        id: dd-cache
        uses: actions/cache@v4
        with:
          path: scripts/rn-fast-runner/build/DerivedData
          key: rn-fast-runner-dd-${{ runner.os }}-${{ env.XCODE_V }}-${{ hashFiles('scripts/rn-fast-runner/**') }}
      - name: Disable simulator hardware keyboard (software keyboard must appear)
        run: defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false
      - name: Pre-boot simulator
        run: |
          set -euo pipefail
          UDID="$(xcrun simctl list devices available --json | jq -r '[.devices[] | .[] | select(.name == "iPhone 16")][0].udid // empty')"
          if [ -z "$UDID" ]; then
            echo "No 'iPhone 16' on this image — falling back to the first available iPhone" >&2
            UDID="$(xcrun simctl list devices available --json | jq -r '[.devices[] | .[] | select(.name | startswith("iPhone"))][0].udid // empty')"
          fi
          [ -n "$UDID" ]
          xcrun simctl boot "$UDID" || true
          xcrun simctl bootstatus "$UDID" -b
          echo "SMOKE_UDID=$UDID" >> "$GITHUB_ENV"
      - name: Build runner (cache miss only)
        if: steps.dd-cache.outputs.cache-hit != 'true'
        run: |
          xcodebuild build-for-testing \
            -project scripts/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj \
            -scheme RnFastRunner \
            -destination "id=$SMOKE_UDID" \
            -derivedDataPath scripts/rn-fast-runner/build/DerivedData \
            CODE_SIGNING_ALLOWED=NO
      - name: Build + install fixture
        run: |
          bash test-fixtures/ios-fixture/build.sh
          xcrun simctl install "$SMOKE_UDID" test-fixtures/ios-fixture/build/Fixture.app
      - name: Run golden set
        env:
          SMOKE_DEBUG_DIR: ${{ runner.temp }}/smoke-debug
        run: npm run smoke:ios
      - name: Collect simulator diagnostics (on failure)
        if: failure()
        run: |
          mkdir -p "$RUNNER_TEMP/smoke-debug"
          xcrun simctl spawn "$SMOKE_UDID" log collect --output "$RUNNER_TEMP/smoke-debug/sim.logarchive" || true
      - name: Upload smoke debug (on failure)
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: ios-smoke-debug
          path: ${{ runner.temp }}/smoke-debug
          retention-days: 7

  android-smoke:
    name: Android device smoke
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm
      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install bridge deps
        working-directory: scripts/cdp-bridge
        run: npm ci
      - name: Set up Java
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
      - name: Set up Gradle (cache)
        uses: gradle/actions/setup-gradle@v4
      - name: Build runner APKs + fixture APK (before the emulator boots)
        run: |
          (cd scripts/rn-android-runner && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon)
          scripts/rn-android-runner/gradlew -p test-fixtures/android-fixture :app:assembleDebug --no-daemon
      - name: Run golden set on emulator
        uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 34
          target: google_apis
          arch: x86_64
          profile: pixel_6
          disable-animations: true
          script: |
            adb shell settings put secure show_ime_with_hard_keyboard 1
            adb install -r test-fixtures/android-fixture/app/build/outputs/apk/debug/app-debug.apk
            SMOKE_DEBUG_DIR="$RUNNER_TEMP/smoke-debug" npm run smoke:android
      - name: Upload smoke debug (on failure)
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: android-smoke-debug
          path: ${{ runner.temp }}/smoke-debug
          retention-days: 7

  artifact-integrity:
    name: Release artifact integrity (Story 01)
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Verify released runner artifacts against the committed manifest
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          V=$(jq -r '.version // empty' runner-manifest.json)
          if [ -z "$V" ] || [ "$V" = "null" ]; then
            echo "runner-manifest.json is still the empty seed — the artifact pipeline has never published." >&2
            echo "Fix: dispatch the runner-artifacts workflow once (catch-up mode publishes the current version)." >&2
            exit 1
          fi
          mkdir -p /tmp/assets && cd /tmp/assets
          gh release download "v$V" --repo "$GITHUB_REPOSITORY" \
            --pattern "rn-fast-runner-$V-sim.zip" \
            --pattern "rn-android-runner-$V.zip"
          for P in ios android; do
            NAME=$(jq -r ".assets.$P[0].name" "$GITHUB_WORKSPACE/runner-manifest.json")
            SHA=$(jq -r ".assets.$P[0].sha256" "$GITHUB_WORKSPACE/runner-manifest.json")
            BYTES=$(jq -r ".assets.$P[0].bytes" "$GITHUB_WORKSPACE/runner-manifest.json")
            echo "$SHA  $NAME" | sha256sum -c -
            ACTUAL=$(stat -c%s "$NAME")
            [ "$ACTUAL" = "$BYTES" ] || { echo "size mismatch for $NAME: manifest=$BYTES actual=$ACTUAL" >&2; exit 1; }
          done
          for Z in *.zip; do
            if unzip -l "$Z" | awk 'NR>3 {print $4}' | grep -E '^/|(^|/)\.\.(/|$)'; then
              echo "suspicious path in $Z" >&2
              exit 1
            fi
          done
          unzip -l "rn-fast-runner-$V-sim.zip" | grep -q '\.xctestrun' || { echo "iOS zip missing .xctestrun" >&2; exit 1; }
          unzip -l "rn-android-runner-$V.zip" | grep -q 'app-debug\.apk' || { echo "android zip missing app-debug.apk" >&2; exit 1; }
          unzip -l "rn-android-runner-$V.zip" | grep -q 'app-debug-androidTest\.apk' || { echo "android zip missing androidTest apk" >&2; exit 1; }
          echo "artifact integrity OK for v$V"

  report:
    name: Consecutive-red alerting
    needs: [ios-smoke, android-smoke, artifact-integrity]
    if: always() && github.event_name == 'schedule'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Open/refresh or close the tracking issue
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          RED: ${{ contains(needs.*.result, 'failure') }}
        run: |
          set -euo pipefail
          PREV=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow nightly-device-smoke.yml \
            --event schedule --limit 2 --json databaseId,conclusion \
            --jq "[.[] | select(.databaseId != $GITHUB_RUN_ID)][0].conclusion // \"none\"")
          echo "this-red=$RED previous=$PREV"
          OPEN=$(gh issue list --repo "$GITHUB_REPOSITORY" --label nightly-smoke-red --state open --json number --jq '.[0].number // empty')
          RUN_URL="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
          if [ "$RED" = "true" ] && [ "$PREV" = "failure" ]; then
            if [ -n "$OPEN" ]; then
              gh issue comment "$OPEN" --repo "$GITHUB_REPOSITORY" --body "Still red: $RUN_URL"
            else
              gh issue create --repo "$GITHUB_REPOSITORY" \
                --title "Nightly device smoke: 2 consecutive red nights" \
                --label nightly-smoke-red \
                --body "The nightly device smoke has failed on 2+ consecutive scheduled runs. Latest: $RUN_URL"
            fi
          elif [ "$RED" = "false" ] && [ -n "$OPEN" ]; then
            gh issue comment "$OPEN" --repo "$GITHUB_REPOSITORY" --body "Recovered: $RUN_URL"
            gh issue close "$OPEN" --repo "$GITHUB_REPOSITORY"
          fi
```

- [ ] **Step 2: Validate the YAML**

```bash
node -e "require('js-yaml').load(require('fs').readFileSync(process.argv[1],'utf8')); console.log('YAML OK')" .github/workflows/nightly-device-smoke.yml
```
Expected: `YAML OK`

- [ ] **Step 3: Create the alert label (one-time; `gh issue create --label` fails on a missing label)**

```bash
gh label create nightly-smoke-red --description "Nightly device smoke red 2+ consecutive scheduled runs" --color B60205 || true
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/nightly-device-smoke.yml
git commit -S -m "feat(story-06): nightly device smoke workflow — iOS/Android lanes + artifact integrity + 2-red alerting (#387)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 9: Docs, PR 2, acceptance runs

**Files:**
- Modify: `docs/stories/06-native-runner-ci-and-evals.md` (Status line + a Phase B "Implemented" blockquote mirroring the Phase A one: main-HEAD provenance rationale, keyboard contract assertion, integrity lane, alerting rule, `smoke:*` local entries)
- Create: `.changeset/story-06-phase-b-device-smoke.md` (`'rn-dev-agent-plugin': patch` — nightly device smoke + fixtures + smoke scripts)
- Workspace: ROADMAP.md narrative entry; DECISIONS.md entries for (a) hybrid provenance, (b) native contract fixtures over RN fixture

- [ ] **Step 1: Story doc + changeset, commit**

```bash
git add docs/stories/06-native-runner-ci-and-evals.md .changeset/story-06-phase-b-device-smoke.md
git commit -S -m "docs(story-06): Phase B status + changeset (#387)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Push, open PR 2** (body: spec link, lane description, local-green evidence from Tasks 6–7, note that scheduled runs start after merge)

- [ ] **Step 3: CI green + threads addressed → merge**

- [ ] **Step 4: Acceptance — real dispatch run green**

```bash
gh workflow run nightly-device-smoke.yml
gh run watch $(gh run list --workflow=nightly-device-smoke.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```
Expected: iOS + Android smoke lanes and integrity lane green (integrity requires Task 3's published artifacts); report job skipped (`workflow_dispatch`). Wall-clock ≤ 45 min.

- [ ] **Step 5: Acceptance — seeded-bug check (story criterion)**

```bash
git checkout -b scratch/387-seeded-tap-offset origin/main
```
In `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Interaction.swift`, find the tap command's coordinate computation and add a deliberate `+ 120` to the y coordinate (marker comment `// DO NOT MERGE — seeded bug for #387 Phase B acceptance`). Push the branch, then:

```bash
gh workflow run nightly-device-smoke.yml --ref scratch/387-seeded-tap-offset
```
Expected: iOS smoke lane RED (counter never increments → the `count: 1` assertion fails). Record the run URL, then delete the branch:

```bash
git push origin --delete scratch/387-seeded-tap-offset
```

- [ ] **Step 6: Workspace docs + issue comment**

ROADMAP.md entry (Phase B shipped: PRs, acceptance run links, seeded-bug run link); DECISIONS entries; comment on #387 mirroring the Phase A comment (Phase B shipped, Phase C remaining). Commit workspace repo.

---

## Self-review notes

- Spec coverage: Task 0 fix (Tasks 1–3), fixtures (4–5), golden set incl. keyboard contract + negative case + timings (6–7), workflow with lanes/integrity/alerting + local `smoke:*` entries (6, 8), acceptance incl. seeded bug (9). Deferred items (RN fixture lane, iOS 26, Phase C) are spec-explicit non-goals.
- The driver adapts to envelope reality on first local run by design (Task 6 Step 3 note) — the tools are the contract.
- Known risk consciously accepted: `device_screenshot` payload shape is asserted dual-branch (file path OR MCP image content).

## Amendments applied from the multi-LLM plan review (2026-07-05)

Participants: Codex (gpt-5.5) + Claude coordinator with file-verified research; Antigravity failed (agy hung with 0-byte output on all three dispatches — tool-side stall, not quota).

Blockers fixed (all file-verified):
1. **`.mjs` driver → `.ts`** (Codex — the review's biggest catch): ci.yml's `check-typescript-only.sh` rejects any new `.js`/`.mjs` not in `scripts/js-migration-baseline.txt` on every PR, so PR 2 could never merge. Driver renamed to `device-smoke.ts`, run via Node >= 22.18 type stripping.
2. **`device_scrollintoview` one-blind-swipe cap** (`device-interact.ts:1383`): row 80 was unreachable — replaced with a bounded scroll loop that gets the row into a snapshot first, then exercises the verb on its supported path.
3. **Android `textAllCaps`**: exact-find on "Increment" is case-sensitive against the node text; platform default renders "INCREMENT". Both fixture buttons now set `android:textAllCaps="false"`.
4. **Android soft keyboard never forced**: emulators expose a hardware keyboard, so the guard would report `no_keyboard`. Workflow + local instructions set `adb shell settings put secure show_ime_with_hard_keyboard 1`; the driver fails actionably on `no_keyboard`.
5. **iOS keyboard hardening**: `defaults write … ConnectHardwareKeyboard` may be a no-op for headless simctl; the driver's iOS branch now names the likely environment cause when the tap unexpectedly succeeds instead of refusing.
6. **swiftc fixture proof made a hard gate** (Task 4 Step 6) + simulator `log collect` diagnostics on CI failure.

Nice-to-haves applied: `target: google_apis` on the emulator step; `fixture_count` existence asserted before the increment match; catch-up detect logs the missing asset names; single `version=` write in the force branch; Task 5 rows rationale corrected (`simple_list_item_1` rows carry `android:id/text1`, so contentDescription is informational); spec DerivedData path typo fixed.

Review findings verified as already-correct (no change): `device_find` without `action` is locate-only (cannot corrupt the counter); the DerivedData cache key busts on the Task 9 seeded mutation (the acceptance check is sound); the fixture Gradle pins match the runner wrapper exactly; PR 1's detect bash is `set -e`-safe and the report job's previous-run logic yields no false page on the first scheduled run.
