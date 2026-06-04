---
skill: setup
description: Check and install all rn-dev-agent prerequisites — Node.js, Metro, simulators, rn-fast-runner (iOS), agent-device (Android), maestro-runner, CDP bridge. Run this when tools fail or on first setup.
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
**Required:** Node.js >= 22 LTS (even-numbered release).
If odd-numbered (e.g., v25) or < 22: warn the user to install Node 22.
- If `nvm` is installed (`command -v nvm`): `nvm install 22 && nvm use 22`
- If `fnm` is installed: `fnm install 22 && fnm use 22`
- Otherwise: download from https://nodejs.org/en/download/ or `brew install node@22`

### 2. CDP bridge dependencies
```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts/cdp-bridge && npm ls --depth=0 2>&1 | head -5
```
If missing or showing WARN/ERR, run the ensure script:
```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/ensure-cdp-deps.sh
```
Then re-check: `cd ${CLAUDE_PLUGIN_ROOT}/scripts/cdp-bridge && npm ls --depth=0 2>&1 | head -5`

If it still fails, give the user manual instructions:
1. `cd ${CLAUDE_PLUGIN_ROOT}/scripts/cdp-bridge && npm install`
2. If ENOENT: the plugin directory may be corrupt — reinstall: `/plugin install rn-dev-agent@Lykhoyda-rn-dev-agent`

### 3. rn-fast-runner (iOS — in-tree XCTest rig)

iOS device automation is owned by the in-tree `rn-fast-runner` XCTest project, NOT the upstream `agent-device` CLI (see D1219). Verify the Xcode project ships with the plugin and the build artifacts are present:

```bash
ls ${CLAUDE_PLUGIN_ROOT}/scripts/rn-fast-runner/RnFastRunner/RnFastRunner.xcodeproj 2>/dev/null && \
  ls ${CLAUDE_PLUGIN_ROOT}/scripts/rn-fast-runner/build/DerivedData/Build/Products/Debug-iphonesimulator/RnFastRunnerUITests-Runner.app 2>/dev/null
```

- **Both present** → OK (built). The runner spawns lazily on the first `device_snapshot action=open` via the fast `xcodebuild test-without-building` path.
- **xcodeproj present, build artifacts MISSING** → NEEDS_BUILD. The runner now **self-builds on first use**: `startFastRunner()` falls back to a full `xcodebuild test` (build + test) when no `.xctestrun` exists, so the first `device_snapshot action=open` will succeed on a fresh machine — it just takes several minutes while Xcode compiles the rig (the ready-signal timeout widens to 360s for this cold path).

  To avoid that first-call latency, **offer to run the one-time pre-build now** ("Pre-build the iOS runner now to avoid a slow first call? [y/n]"). If the user accepts, run it with a booted iOS simulator UDID (substitute from `xcrun simctl list devices booted -j`):
  ```bash
  cd ${CLAUDE_PLUGIN_ROOT}/scripts/rn-fast-runner/RnFastRunner && \
    xcodebuild build-for-testing \
      -project RnFastRunner.xcodeproj \
      -scheme RnFastRunner \
      -destination "platform=iOS Simulator,id=<UDID>" \
      -derivedDataPath ../build/DerivedData
  ```
  Expect `** TEST BUILD SUCCEEDED **`. The artifacts land at `scripts/rn-fast-runner/build/DerivedData/Build/Products/Debug-iphonesimulator/`. If the user declines, leave it — the lazy fallback covers correctness; the only cost is a slow first interaction.
- **xcodeproj missing** → the plugin install is corrupt; reinstall via `/plugin install rn-dev-agent@Lykhoyda-rn-dev-agent`.

Skip this check on systems without `xcodebuild` (non-macOS, no Xcode) — `rn-fast-runner` is iOS-only. The plugin still works on those systems for Android via the `agent-device` CLI (check 3b).

**Expected simulator icons (not clutter).** Because the UI-test target is *hosted* (`TEST_TARGET_NAME = RnFastRunner`), building/running the runner installs **two** apps on the simulator home screen: `RnFastRunner` (the minimal host app, bundle `dev.lykhoyda.rndevagent.fastrunner`) and `RnFastRunnerUITests-Runner` (the XCUITest harness — the icon may show truncated as "RnFastRunnerUI…"; same pattern as WebDriverAgent's `WebDriverAgentRunner`). The Runner hosts the `POST /command` server on port 22088 and drives the *target* app via `XCUIApplication(bundleIdentifier:)` — it does not drive itself, and it stays installed/running on purpose so subsequent `device_*` calls are fast. If a user asks "what is RnFastRunnerUI on my simulator?", that's the answer — leave it in place. (This is distinct from the legacy upstream `AgentDeviceRunner`, which IS unwanted — see the daemon-leak note in the project CLAUDE.md.)

### 3b. agent-device CLI (Android — optional on iOS-only setups)

Android device automation still routes through the upstream `agent-device` CLI. iOS no longer needs it (PR #164). Only flag this row as critical when the user is targeting Android.

```bash
command -v agent-device && agent-device --version
```

If missing AND the user targets Android, run the ensure script to attempt automatic installation:
```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/ensure-agent-device.sh
```
Then re-check: `command -v agent-device && agent-device --version`

If it still fails, give the user these manual instructions:
1. `npm install -g agent-device` — most common install method
2. If EACCES permission error: check if using nvm (`command -v nvm`). With nvm, global installs go to the user directory and don't need sudo. Without nvm: `sudo npm install -g agent-device`
3. If npm registry error: check internet connection, then `npm cache clean --force && npm install -g agent-device`
4. Verify: `agent-device --version` should print a version number

If the user is iOS-only, mark this row N/A (Android-only) and continue. Since #202 the plugin terminates a stale legacy runner at session-open by default (scoped to the target simulator UDID) and clears orphaned `~/.agent-device/daemon.{json,lock}`; opt out with `RN_DEVICE_KILL_LEGACY=0`.

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
1. `curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash` — downloads ~24MB binary
2. If curl fails: check internet, proxy settings, or firewall
3. After install, add to PATH: `export PATH="$HOME/.maestro-runner/bin:$PATH"` (add to `~/.zshrc` or `~/.bashrc`)
4. Fallback: install Maestro CLI instead: `brew install maestro` (slower but compatible)
5. Verify: `maestro-runner --version` should print a version number

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
```bash
curl -s http://127.0.0.1:8081/status 2>/dev/null
```
Should return `packager-status:running`. If not: suggest `npx expo start` or `npx react-native start`

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

### 10. Physical device prerequisites (optional — M9 / Phase 111)

Only runs if a physical device is USB-connected. Simulators/emulators skip
this section. Runs two checks + applies one (safe, reversible) side-effect:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/check-physical-devices.sh
```

Expected outputs:
- **Physical Android present**: `[OK] adb reverse tcp:8081 tcp:8081` — device can reach Metro over USB. Auto-applied; no user action needed.
- **Physical iOS present + idb-companion installed**: `[OK] idb-companion installed`.
- **Physical iOS present but idb-companion missing**: `[MISSING] idb-companion — install with: brew install idb-companion`. Not auto-run (brew installs are slow and can fail mid-flight); user runs the command.
- **No physical devices**: two "skipping" lines. Add "Physical devices" row to the table as "N/A (no devices connected)".

**WiFi debugging is not supported** automatically. Connect by USB. If users
need WiFi they can `adb connect <ip>` manually — the script then treats the
device as physical and runs `adb reverse` over the TCP transport (works
the same as USB).

### 11. Plugin version freshness

Compare the locally installed plugin version against the latest GitHub
release. Read-only — never auto-updates. The user runs
`/plugin update rn-dev-agent` themselves if the row reports BEHIND.

```bash
LOCAL=$(jq -r '.version' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null)
LATEST=$(curl -fsSL --max-time 3 https://api.github.com/repos/Lykhoyda/rn-dev-agent/releases/latest 2>/dev/null | jq -r '.tag_name // empty' | sed 's/^v//')

if [ -z "$LOCAL" ]; then
  echo "[?] Plugin version: could not read \${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json"
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

### 12. Vercel rules sync freshness

Verify the vendored Vercel agent-skills content is present and not stale.
Read-only check; does NOT auto-sync (user runs the resync command if BEHIND).

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/sync-vercel-skills.mjs --check 2>&1 | head -3
```

Expected outputs:
- **OK**: `✓ N files in sync (sha=… fetchedAt=…)`. Compute days since
  `fetchedAt`; if > 30 days, mark row as STALE in the table (still
  functional, just a recommendation to refresh).
- **MISSING**: `error: …/UPSTREAM.lock.json missing`. The vendored
  content was never synced — `rules.index.json` is empty or absent. Surface:
  "Run: `node ${CLAUDE_PLUGIN_ROOT}/scripts/sync-vercel-skills.mjs --fix --ref <sha> --accept-missing-license-file`".
- **DRIFT**: `✗ N file(s) out of sync`. The on-disk content was modified
  out-of-band (or upstream LICENSE absence got fixed). Surface the resync
  command; do not auto-run.

## Output format

Present results as a table:

| Check | Status | Action Needed |
|-------|--------|--------------|
| Node.js | OK (v22.15.0) | — |
| CDP bridge | OK | — |
| rn-fast-runner (iOS) | OK (built) / NEEDS_BUILD / N/A (non-macOS) | NEEDS_BUILD self-builds on first use (slow); offer the one-time `xcodebuild build-for-testing` to skip the wait (see check 3 above) |
| agent-device (Android) | OK / MISSING / N/A (iOS-only setup) | Run: npm install -g agent-device — only if targeting Android |
| maestro-runner | MISSING | Run: npm install -g maestro-runner |
| iOS Simulator | BOOTED (iPhone 16) | — |
| Android Emulator | NOT RUNNING | Boot an emulator |
| Metro | RUNNING (port 8081) | — |
| CDP connection | CONNECTED | — |
| Injected helpers | OK / MISSING | If MISSING: fall back to `device_*` tools or call `cdp_reload`. Do not retry `cdp_status` in a loop. |
| ffmpeg | OK (v7.1) | — |
| Physical devices | N/A (none connected) OR "Android USB reverse: OK" / "iOS: idb-companion missing — install with brew" | Run installed command if iOS-companion missing |
| Plugin version | OK (latest) / BEHIND (installed X, latest Y) / OFFLINE / AHEAD (dev install) | Run: `/plugin update rn-dev-agent` if BEHIND |
| Vercel rules sync | OK (N rules, fetched X days ago) / STALE (> 30 days) / MISSING / DRIFT | Run: node ${CLAUDE_PLUGIN_ROOT}/scripts/sync-vercel-skills.mjs --fix --ref \<sha\> |

If any critical check fails (CDP bridge, **rn-fast-runner on iOS targets**, **agent-device on Android targets**, Metro, or simulator), provide step-by-step instructions to fix it. Do not proceed with feature development until all critical checks pass. Note: iOS-only setups do NOT need `agent-device`; Android-only setups do NOT need `rn-fast-runner` build artifacts.

## After setup

Once all checks pass, tell the user:
"Environment is ready. You can now use `/rn-dev-agent:rn-feature-dev` to implement features."

---

## Common Rationalizations

Setup is boring — agents skip it and pay for it later.

| Excuse | Reality |
|--------|---------|
| "Node v25 should work fine, it's newer than v22" | Odd-numbered Node releases (v23, v25) are NOT LTS. `ws`, `better-sqlite3`, and other native modules the plugin depends on may fail silently. Use v22 LTS. |
| "The SessionStart banner says 'WARNING: agent-device not installed' — it'll auto-install next time" | The SessionStart hook only attempts the `agent-device` install when a live Android device/emulator is detected (`adb devices`), since iOS uses the in-tree `rn-fast-runner` (PR #164 / D1219). So if you see this warning at all, an Android target WAS present and the auto-install ran and FAILED — run the ensure script NOW and read the actual error. iOS-only macOS sessions no longer attempt the install or print this warning. |
| "rn-fast-runner build is fine, it'll lazy-build on demand" | True now, but with a caveat. `startFastRunner()` falls back to a full `xcodebuild test` (build + test) when no `.xctestrun` exists, so the first `device_snapshot action=open` self-builds and succeeds on a fresh machine — it does NOT fail with "no such file or directory" anymore. The cost is latency: that first call blocks for several minutes while Xcode compiles. Offer check 3's one-time `build-for-testing` to move that cost out of the first interaction; don't claim the runner is "broken" when it's just cold-building. |
| "I'll skip the Metro check — I'll start it later when I need it" | Without Metro, `cdp_status` fails, Phase 5.5 fails, and the whole pipeline stops. Start Metro FIRST. |
| "The user can install agent-device themselves" | They ran `/rn-dev-agent:setup` expecting guidance. Give them the exact command with the flag they need (sudo? nvm? permission fix?). |
| "I'll proceed with the feature — setup can be done in parallel" | No. Feature development depends on critical checks passing (steps 10 + 11 are optional — N/A when no physical device, OFFLINE acceptable for the version check). Get the environment green first, then proceed. |

## Red Flags — Stop and Reconsider

- Attempting to run a `cdp_*` tool when `cdp_status` returns `connected: false`
- Proceeding with feature dev when setup shows any RED row
- Suggesting `sudo npm install -g` without first checking if nvm is available
- Ignoring "WARNING: not installed" from the SessionStart banner
- Claiming "setup passed" without showing the 11-row table with evidence (row 10 may be "N/A" when no physical device is connected and row 11 may be "OFFLINE" when GitHub is unreachable — both are still evidence)

## Verification — Setup Complete When

- [ ] Node.js is an even-numbered version >= 22 (v22, v24, NOT v23, v25)
- [ ] `cd scripts/cdp-bridge && npm ls --depth=0` shows no WARN/ERR
- [ ] `agent-device --version` prints a version number — only required if targeting Android; iOS uses the in-tree `rn-fast-runner` (D1219)
- [ ] **iOS targets**: `scripts/rn-fast-runner/build/DerivedData/Build/Products/Debug-iphonesimulator/RnFastRunnerUITests-Runner.app` exists (pre-built once via `xcodebuild build-for-testing`)
- [ ] `~/.maestro-runner/bin/maestro-runner --version` works (or `command -v maestro-runner`)
- [ ] At least ONE of: iOS simulator booted OR Android emulator running
- [ ] `curl -s http://127.0.0.1:8081/status` returns `packager-status:running`
- [ ] `cdp_status` returns `ok:true` with `cdp.connected: true` AND `capabilities.helpersInjected: true`
- [ ] Physical-device row is `N/A (no devices)` OR reports `adb reverse: OK` / `idb-companion: OK or install hint` (M9 / D668)
- [ ] Plugin-version row is `OK` (installed = latest) / `OFFLINE` (acceptable) / `AHEAD (dev install)` — if `BEHIND`, surface the `/plugin update rn-dev-agent` instruction; user decides whether to update before continuing
- [ ] Present the 11-row results table to the user — no hidden failures
