---
name: rn-setup
description: This skill should be used when the user runs /rn-dev-agent:setup, on first use of the plugin in a project, or when tooling fails — "set up rn-dev-agent", "check prerequisites", "cdp_status fails", "CDP connection failed", "device runner not ready", "maestro-runner not found", "rn-fast-runner did not become ready", "rn-android-runner not started", "Metro not running", "no booted simulator", "plugin tools not working", "wrong Node version".
---

# Environment Setup & Dependency Check

You are helping a developer set up the rn-dev-agent plugin environment.
This skill checks every prerequisite and installs missing dependencies.

## When to use

- First time using the plugin
- After SessionStart shows WARNING messages about missing tools
- When `cdp_status` fails to connect
- When `device_*` tools fail with "session not open" or "command not found"
- When the user runs `/rn-dev-agent:setup`

## Checklist — run each check in order

### 1. Node.js version
```bash
node --version
```
**Required:** Node.js >= 22.18 LTS (even-numbered release).
If odd-numbered (e.g., v25), < 22, or Node 22 with minor < 18: warn the user to install current Node 22 LTS.
- If `nvm` is installed (`command -v nvm`): `nvm install 22 && nvm use 22`
- If `fnm` is installed: `fnm install 22 && fnm use 22`
- Otherwise: download from https://nodejs.org/en/download/ or `brew install node@22`

### 2. CDP bridge runtime
```bash
test -f ${CLAUDE_PLUGIN_ROOT}/rn-dev-agent-core/dist/supervisor.js && \
  test -f ${CLAUDE_PLUGIN_ROOT}/rn-dev-agent-core/dist/index.js && echo OK
```
The packaged runtime is a self-contained esbuild bundle — no npm install step is
needed at plugin-install time. If either file is missing:
1. Installed plugin: the install is corrupt — reinstall: `/plugin install rn-dev-agent@rn-dev-agent`
2. rn-dev-agent repo checkout: `corepack yarn install --immutable && corepack yarn build:host-runtimes`

If SessionStart reported a CDP-deps warning, run `bash ${CLAUDE_PLUGIN_ROOT}/scripts/ensure-cdp-deps.sh`
(only dev checkouts running the unbundled core actually need installed deps).

### 3. rn-fast-runner (iOS — in-tree XCTest rig)

iOS device automation is owned by the in-tree `rn-fast-runner` XCTest project (see D1219) — the in-tree runner is the sole iOS device backend, there is no external CLI involved. Verify the Xcode project ships with the plugin and the build artifacts are present:

```bash
ls ${CLAUDE_PLUGIN_ROOT}/scripts/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj 2>/dev/null && \
  ls ${CLAUDE_PLUGIN_ROOT}/scripts/rn-fast-runner/build/DerivedData/Build/Products/Debug-iphonesimulator/RnFastRunnerUITests-Runner.app 2>/dev/null
```

- **Both present** → OK (built). The runner spawns lazily on the first `device_snapshot action=open` via the fast `xcodebuild test-without-building` path.
- **xcodeproj present, build artifacts MISSING** → NEEDS_BUILD. The runner now **self-builds on first use**: `startFastRunner()` runs `xcodebuild build-for-testing` first when no `.xctestrun` exists (persisting the artifact — #424), then launches via the same `test-without-building` path as every later start, so the first `device_snapshot action=open` will succeed on a fresh machine — it just takes several minutes while Xcode compiles the rig (the build phase gets a 360s timeout on this cold path).

  To avoid that first-call latency, **offer to run the one-time pre-build now** ("Pre-build the iOS runner now to avoid a slow first call? [y/n]"). If the user accepts, run it with a booted iOS simulator UDID (substitute from `xcrun simctl list devices booted -j`):
  ```bash
  cd ${CLAUDE_PLUGIN_ROOT}/scripts/rn-fast-runner/RnFastRunner && \
    xcodebuild build-for-testing \
      -project RnFastRunner.xcodeproj \
      -scheme RnFastRunner \
      -destination "platform=iOS Simulator,id=<UDID>" \
      -derivedDataPath ../build/DerivedData
  ```
  Expect `** TEST BUILD SUCCEEDED **`. The artifacts land at `packages/rn-fast-runner/build/DerivedData/Build/Products/Debug-iphonesimulator/`. If the user declines, leave it — the lazy fallback covers correctness; the only cost is a slow first interaction.
- **xcodeproj missing** → the plugin install is corrupt; reinstall via `/plugin install rn-dev-agent@rn-dev-agent`.

Skip this check on systems without `xcodebuild` (non-macOS, no Xcode) — `rn-fast-runner` is iOS-only. The plugin still works on those systems for Android via the in-tree `rn-android-runner` (check 3b).

**Expected simulator icons (not clutter).** Because the UI-test target is *hosted* (`TEST_TARGET_NAME = RnFastRunner`), building/running the runner installs **two** apps on the simulator home screen: `RnFastRunner` (the minimal host app, bundle `dev.lykhoyda.rndevagent.fastrunner`) and `RnFastRunnerUITests-Runner` (the XCUITest harness — the icon may show truncated as "RnFastRunnerUI…"; same pattern as WebDriverAgent's `WebDriverAgentRunner`). The Runner hosts the `POST /command` server on an OS-assigned port (reported back in its READY handshake, so parallel simulators never collide) and drives the *target* app via `XCUIApplication(bundleIdentifier:)` — it does not drive itself, and it stays installed/running on purpose so subsequent `device_*` calls are fast. If a user asks "what is RnFastRunnerUI on my simulator?", that's the answer — leave it in place. (This is distinct from the legacy upstream `AgentDeviceRunner`, which IS unwanted — see the daemon-leak note in the project CLAUDE.md.)

### 3b. rn-android-runner (Android — in-tree UiAutomator rig; optional on iOS-only setups)

Android device automation is owned by the in-tree `rn-android-runner` Gradle project (`packages/rn-android-runner/`) — the sole Android device backend, there is no external CLI to install. Only flag this row as critical when the user is targeting Android.

Verify the project ships with the plugin and its prebuilt APKs are present:

```bash
ls ${CLAUDE_PLUGIN_ROOT}/scripts/rn-android-runner/build.gradle.kts 2>/dev/null && \
  ls ${CLAUDE_PLUGIN_ROOT}/scripts/rn-android-runner/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk 2>/dev/null
```

- **Both present** → OK. The runner installs its APKs and starts its UiAutomator instrumentation (`dev.lykhoyda.rndevagent.androidrunner`) lazily on the first `device_*` call against a booted emulator. The runner is default-on; opt out with `RN_ANDROID_RUNNER=0` (which now ERRORS with `RUNNER_DISABLED` on a `device_*` call — it does NOT fall back to anything).
- **build.gradle.kts present, APK MISSING** → NEEDS_BUILD. Build the runner once with a booted emulator: `cd ${CLAUDE_PLUGIN_ROOT}/scripts/rn-android-runner && ./gradlew assembleDebug assembleDebugAndroidTest`. The APKs land under `app/build/outputs/apk/`.
- **build.gradle.kts missing** → the plugin install is corrupt; reinstall via `/plugin install rn-dev-agent@rn-dev-agent`.

Skip this check on systems without `adb` / no Android target. If the user is iOS-only, mark this row N/A (Android-only) and continue. Since #202 the plugin terminates a stale legacy `AgentDeviceRunner` at session-open by default (scoped to the target simulator UDID) and clears orphaned `~/.agent-device/daemon.{json,lock}`; opt out with `RN_DEVICE_KILL_LEGACY=0`.

### 4. maestro-runner
```bash
command -v maestro-runner && maestro-runner --version
```
If missing, check the default install location first:
```bash
ls -la ~/.maestro-runner/bin/maestro-runner 2>/dev/null
```
If not there, run the ensure script to attempt automatic installation:
```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/ensure-maestro-runner.sh
```
Then re-check: `command -v maestro-runner || ~/.maestro-runner/bin/maestro-runner --version`

If it still fails, give the user these manual instructions:
1. `curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash -s -- --version 1.0.9` — downloads the ~24MB binary at the plugin's tested pin
2. If curl fails: check internet, proxy settings, or firewall
3. After install, add to PATH: `export PATH="$HOME/.maestro-runner/bin:$PATH"` (add to `~/.zshrc` or `~/.bashrc`)
4. Fallback: install Maestro CLI instead: `brew install maestro` (slower but compatible)
5. Verify: `maestro-runner --version` should print a version number

The plugin pins the tested engine version (GH #397; the pin lives in `packages/rn-dev-agent-core/src/domain/engine-pin.ts`, currently `1.0.9`). `cdp_status` → `replayEngine` reports `engine`, `version`, `pin.status` (`pinned-ok` / `unverified` / `drift-newer` / `drift-older` / `checksum-mismatch` / `unknown-version` / `not-installed`), and the engine's known quirks. Report the row as:
- `pinned-ok` → healthy, e.g. `maestro-runner 1.0.9 (pinned, quirks: android-hidekeyboard-noop, requires-adb-on-ios)`
- drift/checksum states → WARN with the installed vs pinned versions; a drifted install still works but is untested (B223-class behavior changes arrive silently). Reinstall the pin with the command in step 1 above.
- `unverified` → informational only (no hash shipped for this platform, or hashing failed); not a failure.

### 5. iOS Simulator (if macOS)
```bash
xcrun simctl list devices booted 2>/dev/null | grep -i booted
```
If none booted: suggest opening Simulator.app or `xcrun simctl boot "iPhone 16"`

### 6. Android Emulator (if applicable)
```bash
adb devices 2>/dev/null | grep -v "List"
```
If none: check `$ANDROID_HOME/emulator/emulator -list-avds`

### 7. Metro dev server
Call `rn_session(action="status")`, then inspect the bound Metro with
`cdp_status`. If an integrated session has no running Metro, suggest literal
`pnpm ios` or `pnpm android`.

### 8. CDP connection
Call `cdp_status` MCP tool. Should return `ok: true` with `cdp.connected: true`.
If it fails: check Metro is running, app is loaded on simulator, no other debugger connected.

### 8b. Injected helpers (`__RN_AGENT`)
From the same `cdp_status` response, check `capabilities.helpersInjected`. Should be `true` once `cdp.connected: true`.

If `helpersInjected: false`:
- The bridge's auto-reinject already ran 1-shot during the call. If it's still false, the JS world is hung — Hermes is up but `__RN_AGENT` won't land.
- Surface this in the table as MISSING with action: "JS-tier tools (`cdp_interact`, `cdp_component_tree`, `cdp_store_state`, `cdp_navigation_state`) will fail with HELPERS_NOT_INJECTED. Fall back to `device_*` tools (XCTest path — no helpers required) for UI work, or call `cdp_reload` once to rebuild the JS context. If you also see `app.hasRedBox: true` or `app.errorCount > 0`, fix those first — `cdp_reload` won't help if the bundle itself errors out."
- Also mention: don't sit in a `cdp_status` retry loop expecting it to flip — the bridge already retried and gave you the authoritative answer.

### 9. ffmpeg (optional — for video recording)
```bash
command -v ffmpeg && ffmpeg -version 2>&1 | head -1
```
If missing: `brew install ffmpeg` (not critical — videos work without it, GIF conversion doesn't)

### 10. idb (optional — fast screen mirroring)
```bash
command -v idb && { command -v idb_companion || command -v idb-companion; }
```
Both binaries present → the observe UI's live mirror uses `idb video-stream`
(20–30fps). Missing → the mirror still works via a ~6fps `simctl screenshot`
loop. SessionStart auto-installs in the background (`scripts/ensure-idb.sh`);
if `~/.rn-dev-agent/idb/install.pid` exists and its PID is alive, report
"installing in background (log: ~/.rn-dev-agent/idb/install.log)" instead of
MISSING. Manual install: `brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion && pipx install fb-idb`.

### 11. Physical device prerequisites (optional — M9 / Phase 111)

Only runs if a physical device is USB-connected. Simulators/emulators skip
this section. Runs two checks + applies one (safe, reversible) side-effect:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/check-physical-devices.sh
```

Expected outputs:
- **Physical Android present**: `[OK] adb reverse tcp:8081 tcp:8081` — device can reach Metro over USB. Auto-applied; no user action needed.
- **Physical iOS present + idb-companion installed**: `[OK] idb-companion installed`.
- **Physical iOS present but idb-companion missing**: `[MISSING] idb-companion — install with: brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion`. Not auto-run (brew installs are slow and can fail mid-flight); user runs the command.
- **No physical devices**: two "skipping" lines. Add "Physical devices" row to the table as "N/A (no devices connected)".

**WiFi debugging is not supported** automatically. Connect by USB. If users
need WiFi they can `adb connect <ip>` manually — the script then treats the
device as physical and runs `adb reverse` over the TCP transport (works
the same as USB).

### 12. Plugin version freshness

Compare the locally installed plugin version against the latest GitHub
release. Read-only — never auto-updates. The user runs
`/plugin update rn-dev-agent` themselves if the row reports BEHIND.

```bash
LOCAL=$(jq -r '.version' "${CLAUDE_PLUGIN_ROOT}/plugin.json" 2>/dev/null)
LATEST=$(curl -fsSL --max-time 3 https://api.github.com/repos/Lykhoyda/rn-dev-agent/releases/latest 2>/dev/null | jq -r '.tag_name // empty' | sed 's/^v//')

if [ -z "$LOCAL" ]; then
  echo "[?] Plugin version: could not read \${CLAUDE_PLUGIN_ROOT}/plugin.json"
elif [ -z "$LATEST" ]; then
  echo "[OFFLINE] Plugin version: installed $LOCAL — couldn't reach GitHub for upstream check"
else
  NEWER=$(printf '%s\n%s\n' "$LOCAL" "$LATEST" | sort -V | tail -1)
  if [ "$LOCAL" = "$LATEST" ]; then
    echo "[OK] Plugin version: $LOCAL (latest)"
  elif [ "$NEWER" = "$LATEST" ]; then
    echo "[BEHIND] Plugin version: installed $LOCAL, latest $LATEST — run /plugin update rn-dev-agent"
  else
    echo "[AHEAD] Plugin version: installed $LOCAL is newer than latest release $LATEST (dev install — fine)"
  fi
fi
```

Expected outputs:
- **OK**: installed version equals the latest release tag.
- **BEHIND**: installed version is older than the latest release. Surface the
  exact `/plugin update rn-dev-agent` command. Common when a user pinned
  an older version or hasn't updated since their last `claude` install.
- **AHEAD (dev install)**: local version is newer — typical for plugin
  contributors running off `main` or a feature branch. Note the discrepancy
  but don't treat as a failure.
- **OFFLINE**: GitHub API was unreachable (no network, rate-limited,
  authentication blocking). Skip without failing — plugin works fine
  without the upstream check.

GitHub's unauthenticated API allows 60 requests/hour per IP. The `/doctor`
command is read-only and not expected to run that often per hour, so no
caching is required for v1. If rate-limit complaints surface, add a 24h
on-disk cache at `~/.cache/rn-dev-agent/upgrade-check.json`.

### 13. Vercel rules sync freshness

Verify the vendored Vercel agent-skills content is present and not stale.
Read-only check; does NOT auto-sync (user runs the resync command if BEHIND).

```bash
[ -f "${CLAUDE_PLUGIN_ROOT}/../../scripts/sync-vercel-skills.mjs" ] && \
  node "${CLAUDE_PLUGIN_ROOT}/../../scripts/sync-vercel-skills.mjs" --check 2>&1 | head -3 || \
  echo "N/A (installed plugin — vendored rules ship with the package; resync is a repo maintenance task)"
```

Expected outputs:
- **OK**: `✓ N files in sync (sha=… fetchedAt=…)`. Compute days since
  `fetchedAt`; if > 30 days, mark row as STALE in the table (still
  functional, just a recommendation to refresh).
- **MISSING**: `error: …/UPSTREAM.lock.json missing`. The vendored
  content was never synced — `rules.index.json` is empty or absent. Surface:
  "Run (rn-dev-agent repo checkout only): `node scripts/sync-vercel-skills.mjs --fix --ref <sha> --accept-missing-license-file`".
- **DRIFT**: `✗ N file(s) out of sync`. The on-disk content was modified
  out-of-band (or upstream LICENSE absence got fixed). Surface the resync
  command; do not auto-run.

## Output format

Present results as a table:

| Check | Status | Action Needed |
|-------|--------|--------------|
| Node.js | OK (v22.18.0) | — |
| CDP bridge | OK | — |
| rn-fast-runner (iOS) | OK (built) / NEEDS_BUILD / N/A (non-macOS) | NEEDS_BUILD self-builds on first use (slow); offer the one-time `xcodebuild build-for-testing` to skip the wait (see check 3 above) |
| rn-android-runner (Android) | OK (APKs present) / NEEDS_BUILD / N/A (iOS-only setup) | NEEDS_BUILD: `cd ${CLAUDE_PLUGIN_ROOT}/scripts/rn-android-runner && ./gradlew assembleDebug assembleDebugAndroidTest` — only if targeting Android |
| maestro-runner | MISSING | Run: npm install -g maestro-runner |
| iOS Simulator | BOOTED (iPhone 16) | — |
| Android Emulator | NOT RUNNING | Boot an emulator |
| Metro | RUNNING (port 8081) | — |
| CDP connection | CONNECTED | — |
| Injected helpers | OK / MISSING | If MISSING: fall back to `device_*` tools or call `cdp_reload`. Do not retry `cdp_status` in a loop. |
| ffmpeg | OK (v7.1) | — |
| idb (screen mirror fast path) | OK / INSTALLING (background) / MISSING | If MISSING: `brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion && pipx install fb-idb` (optional — mirror falls back to ~6fps simctl) |
| Physical devices | N/A (none connected) OR "Android USB reverse: OK" / "iOS: idb-companion missing — install with brew" | Run installed command if iOS-companion missing |
| Plugin version | OK (latest) / BEHIND (installed X, latest Y) / OFFLINE / AHEAD (dev install) | Run: `/plugin update rn-dev-agent` if BEHIND |
| Vercel rules sync | OK (N rules, fetched X days ago) / STALE (> 30 days) / MISSING / DRIFT / N/A (installed plugin) | Repo checkout only: node scripts/sync-vercel-skills.mjs --fix --ref \<sha\> |

If any critical check fails (CDP bridge, **rn-fast-runner on iOS targets**, **rn-android-runner on Android targets**, Metro, or simulator), provide step-by-step instructions to fix it. Do not proceed with feature development until all critical checks pass. Note: iOS-only setups do NOT need `rn-android-runner`; Android-only setups do NOT need `rn-fast-runner` build artifacts.

## After setup

Once all checks pass, tell the user:
"Environment is ready. You can now use `/rn-dev-agent:rn-feature-dev` to implement features."

---

## Common Rationalizations

Setup is boring — agents skip it and pay for it later.

| Excuse | Reality |
|--------|---------|
| "Node v25 should work fine, it's newer than v22" | Odd-numbered Node releases (v23, v25) are NOT LTS. `ws`, `better-sqlite3`, and other native modules the plugin depends on may fail silently. Use Node 22.18+ LTS. |
| "There's no external device CLI to install — surely device control just works" | Both device backends are in-tree (iOS: `rn-fast-runner`; Android: `rn-android-runner`) and there is no `agent-device` install step anymore — but they still need their build artifacts present. The runners build/install lazily on the first `device_*` call, which means the first call cold-builds (slow) if you skipped the pre-build. Verify checks 3 / 3b and offer the one-time pre-build to move that cost out of the first interaction. `RN_ANDROID_RUNNER=0` does NOT fall back to anything — it ERRORS with `RUNNER_DISABLED`. |
| "rn-fast-runner build is fine, it'll lazy-build on demand" | True now, but with a caveat. `startFastRunner()` runs `xcodebuild build-for-testing` + `test-without-building` when no `.xctestrun` exists (#424 — the build artifact persists, so only the FIRST call ever is slow), so the first `device_snapshot action=open` self-builds and succeeds on a fresh machine — it does NOT fail with "no such file or directory" anymore. The cost is latency: that first call blocks for several minutes while Xcode compiles. Offer check 3's one-time `build-for-testing` to move that cost out of the first interaction; don't claim the runner is "broken" when it's just cold-building. |
| "I'll skip the Metro check — I'll start it later when I need it" | Without Metro, `cdp_status` fails, Phase 5.5 fails, and the whole pipeline stops. Start Metro FIRST. |
| "The user can pre-build the device runner themselves" | They ran `/rn-dev-agent:setup` expecting guidance. Give them the exact pre-build command for their target (iOS: the `xcodebuild build-for-testing` form in check 3; Android: `./gradlew assembleDebug assembleDebugAndroidTest` in check 3b) — don't punt. |
| "I'll proceed with the feature — setup can be done in parallel" | No. Feature development depends on critical checks passing (steps 10 + 11 are optional — N/A when no physical device, OFFLINE acceptable for the version check). Get the environment green first, then proceed. |

## Red Flags — Stop and Reconsider

- Attempting to run a `cdp_*` tool when `cdp_status` returns `connected: false`
- Proceeding with feature dev when setup shows any RED row
- Suggesting `sudo npm install -g` without first checking if nvm is available
- Treating a device-runner `RN_FAST_RUNNER_DOWN` / `RN_ANDROID_RUNNER_DOWN` error as something that "self-heals" without checking the runner build artifacts (checks 3 / 3b)
- Claiming "setup passed" without showing the full results table with evidence (row 10 may be "N/A" when no physical device is connected and row 11 may be "OFFLINE" when GitHub is unreachable — both are still evidence)

## Verification — Setup Complete When

- [ ] Node.js is an even-numbered version >= 22.18 (v22.18+, v24, NOT v23, v25)
- [ ] `corepack yarn workspace rn-dev-agent-core exec npm ls --depth=0` shows no WARN/ERR
- [ ] **Android targets**: `packages/rn-android-runner/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk` exists (build once via `./gradlew assembleDebug assembleDebugAndroidTest`) — only required if targeting Android; iOS uses the in-tree `rn-fast-runner` (D1219)
- [ ] **iOS targets**: `packages/rn-fast-runner/build/DerivedData/Build/Products/Debug-iphonesimulator/RnFastRunnerUITests-Runner.app` exists (pre-built once via `xcodebuild build-for-testing`)
- [ ] `~/.maestro-runner/bin/maestro-runner --version` works (or `command -v maestro-runner`)
- [ ] At least ONE of: iOS simulator booted OR Android emulator running
- [ ] `rn_session(action="status")` and `cdp_status` report the bound Metro
- [ ] `cdp_status` returns `ok:true` with `cdp.connected: true` AND `capabilities.helpersInjected: true`
- [ ] Physical-device row is `N/A (no devices)` OR reports `adb reverse: OK` / `idb-companion: OK or install hint` (M9 / D668)
- [ ] idb row is `OK`, `INSTALLING (background)`, or `MISSING` with the manual command — never blocks setup (mirror falls back to simctl)
- [ ] Plugin-version row is `OK` (installed = latest) / `OFFLINE` (acceptable) / `AHEAD (dev install)` — if `BEHIND`, surface the `/plugin update rn-dev-agent` instruction; user decides whether to update before continuing
- [ ] Present the full results table to the user — no hidden failures
