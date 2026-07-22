---
name: rn-device-control
description: This skill should be used when the user asks to "control the simulator", "take a screenshot", "boot the emulator", "install the app", "read UI hierarchy", "manage device state", "open a deep link", "grant permissions", "stream native logs", "disable animations", "change device locale", or needs guidance on xcrun simctl, adb commands, screenshot capture, Expo/EAS builds, or device lifecycle management for React Native testing.
---

# rn-device-control — Device Lifecycle and State Extraction

Commands for controlling iOS Simulator and Android Emulator, taking screenshots,
reading UI state, and managing device settings. All commands run via bash.

**See also:** [3-Tier Interaction Model](references/interaction-model.md) — when to use cdp_interact vs device_press vs Maestro.

When a packaged helper is referenced, resolve `<package-root>` as `../..` from
this exact `SKILL.md`. Never interpret it as the user's workspace or scan Codex
caches.

---

## iOS Simulator (simctl)

`booted` below is a convenience alias for a single-simulator machine. As soon as
a second simulator is up it is ambiguous and silently targets the wrong device —
substitute the exact UDID (`xcrun simctl list devices booted`), which is the same
exact-device identity the plugin's own device session and Maestro replay authority
are checked against.

### Boot and Manage Devices

```bash
# List all available simulators
xcrun simctl list devices

# List only booted simulators
xcrun simctl list devices booted

# Boot a specific simulator by name or UDID
xcrun simctl boot "iPhone 16 Pro"
xcrun simctl boot <UDID>

# Shutdown a simulator
xcrun simctl shutdown booted

# Install an app (.app bundle)
xcrun simctl install booted /path/to/YourApp.app

# Uninstall an app
xcrun simctl uninstall booted com.example.app

# Launch an app
xcrun simctl launch booted com.example.app

# Terminate a running app
xcrun simctl terminate booted com.example.app

# Erase all content (reset to factory)
xcrun simctl erase booted
```

### Deep Links

```bash
# Open a deep link in the booted simulator
xcrun simctl openurl booted "myapp://home"
xcrun simctl openurl booted "myapp://product/123"
xcrun simctl openurl booted "myapp://checkout"
```

Prefer deep links over Maestro navigation flows — faster and more deterministic.

### Screenshots (prefer JPEG — 2x faster, good enough for AI analysis)

```bash
# JPEG — recommended (80ms, ~200KB)
xcrun simctl io booted screenshot --type=jpeg /tmp/rn-screenshot.jpg

# PNG — slower (150ms, ~800KB), avoid for testing loops
xcrun simctl io booted screenshot --type=png /tmp/rn-screenshot.png
```

JPEG is 2x faster and 4x smaller than PNG. Always use JPEG for iOS testing.

### Native Log Streaming (for crash investigation)

```bash
# Stream error-level logs from a specific app process
# Replace "YourApp" with the actual binary name (not the bundle ID).
# Find binary name: ls $(xcrun simctl get_app_container booted com.example.app)
xcrun simctl spawn booted log stream \
  --predicate 'processImagePath ENDSWITH "/YourApp" AND logType == error'

# Grab a log snapshot from last 1 minute
xcrun simctl spawn booted log show \
  --predicate 'processImagePath ENDSWITH "/YourApp"' \
  --last 1m
```

**Note:** `processImagePath` matches the Mach-O binary name, not the bundle
ID. Use `ENDSWITH "/BinaryName"` for precision — `contains` may match
system processes with similar substrings.

Use native logs when `cdp_error_log` is empty but the app has crashed — the
problem is native, not JavaScript.

### Device Settings

```bash
# Change device language and locale (requires restart)
xcrun simctl spawn booted defaults write -g AppleLanguages '("fr")'
xcrun simctl spawn booted defaults write -g AppleLocale fr_FR

# Grant permissions programmatically
xcrun simctl privacy booted grant camera com.example.app
xcrun simctl privacy booted grant location com.example.app
xcrun simctl privacy booted grant photos com.example.app
xcrun simctl privacy booted revoke camera com.example.app
xcrun simctl privacy booted reset all com.example.app

# Push notification payload testing
xcrun simctl push booted com.example.app payload.json
```

### iOS Limitations

No built-in CLI equivalent to Android's `uiautomator dump` exists on iOS.
Use Maestro for UI assertions and CDP for React fiber tree introspection.

---

## Android Emulator / Device (adb)

### Device Management

```bash
# List connected devices and emulators
adb devices

# Install an APK
adb install /path/to/app.apk
adb install -r /path/to/app.apk  # -r to reinstall without uninstalling

# Uninstall an app
adb uninstall com.example.app

# Launch an activity
adb shell am start -n com.example.app/.MainActivity

# Force stop an app
adb shell am force-stop com.example.app

# Clear app data (full reset)
adb shell pm clear com.example.app
```

### Deep Links

```bash
# Open a deep link on Android
adb shell am start -a android.intent.action.VIEW -d "myapp://home"
adb shell am start -a android.intent.action.VIEW -d "myapp://product/123"
```

### Screenshots (prefer exec-out — skips device storage round-trip)

```bash
# Recommended — direct pipe via exec-out (300ms, ~800KB)
adb exec-out screencap -p > /tmp/rn-screenshot.png
```

`exec-out` pipes raw PNG directly to the host, skipping the
write-to-`/sdcard/` + `adb pull` round-trip.

### UI Hierarchy Extraction

Android provides a full structured accessibility tree dump — more useful than
screenshots for understanding screen state.

```bash
# Full UI hierarchy as XML (300-500ms)
# Note: dump to file on device, then pull — /dev/stdout prepends a status message that corrupts XML
adb shell uiautomator dump --compressed /data/local/tmp/uidump.xml && \
  adb exec-out cat /data/local/tmp/uidump.xml; \
  adb shell rm -f /data/local/tmp/uidump.xml

# Parse to JSON — only interactive and visible elements
adb shell uiautomator dump --compressed /data/local/tmp/uidump.xml && \
  adb exec-out cat /data/local/tmp/uidump.xml | \
  python3 -c "
import xml.etree.ElementTree as ET, json, sys
tree = ET.parse(sys.stdin)
els = [{'text':n.get('text',''),'id':n.get('resource-id',''),
        'desc':n.get('content-desc',''),'bounds':n.get('bounds',''),
        'clickable':n.get('clickable')=='true'}
       for n in tree.iter('node')
       if n.get('text') or n.get('resource-id') or n.get('content-desc')]
json.dump(els, sys.stdout, indent=2)"; \
  adb shell rm -f /data/local/tmp/uidump.xml
```

Raw dump: ~15-30KB XML, 200+ nodes. After pruning: ~2-3KB JSON, 15-40
elements — about 100 tokens for the LLM.

### Disable Animations (run once before testing)

```bash
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
```

Restore after testing:
```bash
adb shell settings put global window_animation_scale 1
adb shell settings put global transition_animation_scale 1
adb shell settings put global animator_duration_scale 1
```

### Native Logs (for crash investigation)

```bash
# Stream crash-level logs
adb logcat -b crash

# Stream only React Native errors (filter by PID)
# pidof -s may not exist on all Android versions; use grep fallback:
APP_PID=$(adb shell pidof com.example.app 2>/dev/null | awk '{print $1}') || \
  APP_PID=$(adb shell ps | grep com.example.app | awk '{print $2}')
adb logcat -s ReactNative:E ReactNativeJS:E --pid=$APP_PID

# Clear logcat buffer before a test run
adb logcat -c
```

### Permissions

```bash
# Grant a runtime permission
adb shell pm grant com.example.app android.permission.CAMERA
adb shell pm grant com.example.app android.permission.ACCESS_FINE_LOCATION

# Revoke a runtime permission
adb shell pm revoke com.example.app android.permission.CAMERA
```

### Language and Locale

```bash
adb shell settings put system locale fr_FR
```

**Note:** Behavior varies by Android API level; may require device restart.

---

## Concurrent State Snapshot Script

`scripts/snapshot_state.sh` captures screenshot + UI hierarchy simultaneously,
cutting state-check time by ~40%.

```bash
# Usage
bash <package-root>/scripts/snapshot_state.sh [ios|android] [output_dir]

# iOS output: /tmp/rn-dev-agent/screenshot.jpg
# Android output: /tmp/rn-dev-agent/screenshot.png + ui_elements.json
```

On Android, both `screencap` and `uiautomator dump` run as background processes
completing in parallel (~300ms total instead of ~800ms sequential).

---

## Benchmark Reference

| Operation | Command | Time | Size |
|-----------|---------|------|------|
| iOS screenshot (JPEG) | `xcrun simctl io booted screenshot --type=jpeg` | 80ms | 200KB |
| iOS screenshot (PNG) | `xcrun simctl io booted screenshot --type=png` | 150ms | 800KB |
| Android screenshot (exec-out) | `adb exec-out screencap -p >` | 300ms | 800KB |
| Android UI hierarchy | `adb shell uiautomator dump --compressed` | 300-500ms | 15-30KB XML |
| Android UI hierarchy (parsed) | above + python3 filter | 350-550ms | 2-3KB JSON |

---

## Expo/EAS Build Integration

For Expo/EAS build workflows including `eas_resolve_artifact.sh` and
`expo_ensure_running.sh` scripts, exit codes, artifact handling, and
combined workflow examples, consult **`references/expo-eas-builds.md`**.

Quick decision table:

| Situation | Action |
|-----------|--------|
| App running + Metro connected | Skip — proceed to testing |
| Metro not running, app missing | `expo_ensure_running.sh ios` or `android` |
| Test a specific EAS build | `eas_resolve_artifact.sh` → `expo_ensure_running.sh --artifact` |

---

## Device tools (Cross-Platform Native Control)

The `device_*` MCP tools provide unified device interaction across iOS and Android
without platform-specific branching. They route through the in-tree runners — the
SOLE device backend (iOS: `rn-fast-runner` via `POST /command`; Android:
`rn-android-runner` via UiAutomator instrumentation) — so prefer them over raw
simctl/adb for interactive testing. There is no external `agent-device` CLI involved.

### When to Use

| Task | Preferred Tool | Why |
|------|---------------|-----|
| List available devices | `device_list` | Cross-platform, structured JSON |
| Take a screenshot | `device_screenshot` | Works on both platforms identically |
| Read UI element tree | `device_snapshot` | Returns @refs for subsequent interaction |
| Tap an element by text | `device_find text="Sign In" action=click` | No testID needed |
| Tap by element ref | `device_press ref=@e3` | After getting refs from snapshot |
| Fill a text input | `device_fill ref=@e5 text="hello"` | Clears and types with verification |
| Scroll/swipe | `device_swipe direction=up` | Native gesture |
| Navigate back | `device_back` | System back (Android) or gesture (iOS) |
| Persistent E2E test file | maestro-runner (YAML) | CI-ready test artifacts |
| Deep React state inspection | `cdp_store_state` | Redux/Zustand internals |

### Session Lifecycle

```
1. device_snapshot action=open appId="com.example.app" platform="ios"
   → Boots device, installs app, creates session

2. device_snapshot  → Returns accessibility tree with @refs
3. device_find text="Login" action=click  → Tap by text
4. device_press ref=@e5  → Tap by ref from snapshot
5. device_fill ref=@e7 text="user@example.com"  → Fill input

6. device_snapshot action=close  → End session
```

### Fallback

The in-tree runner IS the device backend — there is nothing to "fall back from" for primitive interaction. When a `device_*` call can't serve a need, route to the right mechanism instead:
- **Reliable testID** → `cdp_interact(testID=..., action="press")` (JS-level; deterministic, no native round-trip).
- **Raw device lifecycle** (boot / install / launch / terminate) → `xcrun simctl` (iOS) / `adb` (Android). The runners drive interaction, not device state.
- **Whole-flow E2E** → maestro-runner (`.yaml`).

If the runner itself is down, the bridge returns an actionable `RN_FAST_RUNNER_DOWN` (iOS) / `RN_ANDROID_RUNNER_DOWN` (Android) — fix the runner build (see `$rn-dev-agent:doctor`), it does not silently fall back to a legacy CLI.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Simulator not booting | Stale state or Xcode mismatch | `xcrun simctl shutdown all && xcrun simctl erase all` then re-boot |
| `adb devices` shows "unauthorized" | USB debugging not re-authorized | Revoke USB debugging in device settings, reconnect, tap "Allow" |
| Screenshot command hangs | Device not fully booted | Wait for home screen, verify with `adb shell getprop sys.boot_completed` |
| `uiautomator dump` fails | Screen off or system UI blocking | Wake screen: `adb shell input keyevent KEYEVENT_WAKEUP` |
| `pidof` not found | Older Android version (< API 24) | Use `ps | grep` fallback shown in Native Logs section |

---

## Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| Xcode + Command Line Tools | iOS | Mac App Store |
| xcrun simctl | iOS | Included with Xcode |
| Android SDK (adb) | Android | developer.android.com/studio |
| Python 3 | Android hierarchy parsing | Pre-installed on macOS |
| jq | EAS profile parsing (optional, falls back to node) | `brew install jq` |
| eas-cli | EAS builds (optional) | `npm install -g eas-cli` |
| Expo CLI | Local builds + Metro | Included with Expo projects (`npx expo`) |

---

## Screenshot Guardrails (B150)

Screenshots are expensive to take (50-200ms), expensive in LLM tokens
(an 800px JPEG ≈ 1500-3000 image tokens), and easy to over-use during
debug spirals. The plugin enforces these rules and emits non-blocking
advisories on the tool result so you can self-correct.

### Use the right tool for the question

Before reaching for `device_screenshot`, ask what question you're answering:

| Question | Wrong | Right |
|---|---|---|
| "What's on screen?" | `device_screenshot` | `device_snapshot` (a11y tree + `@ref` handles, ~5ms, ~300 tokens) |
| "Is `testID X` visible?" | `device_screenshot` | `cdp_component_tree(filter='X')` (~200ms, ~200 tokens, exact match) |
| "What's the store value?" | Screenshot a debug overlay | `cdp_store_state(path='...')` (~50ms, structured JSON) |
| "Did the value update?" | Take 2 screenshots and eyeball-diff | `cdp_dispatch(...readBack='cart')` returns the diff in one call |
| "Show the user the bug" | This IS the legitimate case | `device_screenshot` ✓ |
| "PR proof of feature" | This IS the legitimate case | `device_screenshot(path='docs/proof/<feat>/...')` ✓ |

### When you DO screenshot, follow these rules

**WHERE — output path:**
- E2E proof (Phase 8): `docs/proof/<feature-slug>/<NN>-<step>.jpg`
- Debug capture: `docs/diag/<YYYY-MM-DD>/<NN>-<symptom>.jpg`
- Throwaway / scratch: leave `path` unset (defaults to `/tmp`)
- The tool emits `meta.advisories[{code: "EPHEMERAL_PATH", ...}]` whenever
  the path resolves under `/tmp/` or `/var/folders/`. Heed it — those
  files will be cleaned by the OS and are unsafe for PR artifacts.

**WHEN — pre-conditions:**
- `cdp_status` returned `ok:true` (otherwise you may capture a black screen
  or the wrong app)
- `cdp_navigation_state` returned a real route name — NOT `"DevClientLauncher"`,
  NOT `"ServerPicker"`, NOT empty/null. A screenshot of the dev-loader is
  noise; dismiss the picker first.
- UI has settled — 1-2s after the last interaction, OR `device_snapshot`
  confirmed the expected element is on screen.

**HOW — format and size:**
- Default JPEG (4× smaller than PNG; only use PNG when you need alpha or
  pixel-exact comparison)
- Default `maxWidth=800` — saves ~46% on iPhone 15/17 Pro screenshots
  without losing label readability or visual confirmation.
- `maxWidth=0` (full native resolution) is reserved for visual-diff or
  design-review captures only. The tool emits
  `meta.advisories[{code: "FULL_RESOLUTION", ...}]` so you don't reach
  for it reflexively.

**HOW MANY — volume:**
- E2E proof: exactly N screenshots = number of rows in the architect's
  Phase 4 flow table. No more, no fewer.
- Debug session: max 5 captures per session. Past 5, you're rationalising
  visual inspection over `cdp_*` introspection — switch to
  `cdp_component_tree`, `cdp_store_state`, or `cdp_error_log`.
- Identical-state captures (same UI, same store, same screen) are wasted —
  use `cdp_component_tree(filter=...)` to compare structurally instead.

### How to read `meta.advisories[]`

The screenshot tool returns advisories alongside `meta.resize`:

```json
{
  "ok": true,
  "data": { "path": "/tmp/rn-screenshot-1730289600.jpg" },
  "meta": {
    "resize": { "resized": true, "savedPercent": 46 },
    "advisories": [
      {
        "code": "EPHEMERAL_PATH",
        "message": "Screenshot saved to an ephemeral path (/tmp/...). Pass path=\"docs/proof/...\" for deliverables."
      }
    ]
  }
}
```

Treat advisories as guidance, not errors — the call still succeeded. But
if you're capturing PR proof artifacts and see `EPHEMERAL_PATH`, you have
the wrong path; re-take with the correct one before declaring the proof
complete.

---

## Common Rationalizations

Device control commands are low-level — agents reach for bash too readily.

| Excuse | Reality |
|--------|---------|
| "I need a screenshot fast — `xcrun simctl io booted screenshot` is simpler" | `device_screenshot` handles path conventions, format fallbacks, and works cross-platform with the same call. Use it. |
| "I'll `xcrun simctl launch` to restart — faster than going through the plugin" | `cdp_reload` (full=true) is the supported path, auto-reconnects CDP, and re-injects helpers. `simctl launch` loses the CDP session. |
| "I'll `adb shell input text` directly instead of `device_fill`" | `device_fill` handles percent-escaping (B97), `%s` literals, and shell quoting. Direct `adb input text` breaks on spaces and special characters silently. |
| "I need to read UI — `xcrun simctl ui` gives hierarchy" | For React components, use `cdp_component_tree`. For the native a11y tree, use `device_snapshot`. Both give structured data agents can filter — raw `simctl ui` output is lossy. |
| "The simulator isn't booted, I'll `xcrun simctl boot` quickly" | Fine for one-off boots. But if you're booting to run the agent, `device_list` first — the user may already have a target booted, and you'd boot a different one. |
| "Let me screenshot to see what's on screen" | Use `device_snapshot` — returns the a11y tree with `@ref` handles in ~5ms vs ~150ms for a screenshot, and the JSON is far cheaper in LLM context than an image. Screenshot only when a human needs to see it. |
| "I'll just screenshot to verify the testID rendered" | Use `cdp_component_tree(filter='<testID>')` — it returns the rendered fiber, props, and children. A screenshot tells you the pixel exists; the fiber tells you the React state is correct. |
| "I took a screenshot to /tmp because I wasn't sure where it goes" | The tool returns `meta.advisories[{code: "EPHEMERAL_PATH"}]` for that exact case. Use `docs/proof/<feature>/<NN>-<step>.jpg` for deliverables and `docs/diag/<YYYY-MM-DD>/...` for debug. |
| "I always set `maxWidth=0` so I get the real image" | Native iPhone screenshots are 1.5-2.5MB JPEGs and blow context budgets. Default 800px keeps label readability. The tool flags `FULL_RESOLUTION` so you can audit when you actually needed it. |
| "I'll take 10 screenshots and pick the right one later" | Past 5 in a debug session you're substituting visual inspection for `cdp_*` introspection. Re-frame the question: what state are you trying to read, and which `cdp_*` tool surfaces it? |

## Red Flags — Stop and Reconsider

- Reaching for `xcrun simctl` or `adb` when a `device_*` MCP tool exists
- Calling `simctl io booted screenshot` — use `device_screenshot`
- Calling `adb shell input text` — use `device_fill`
- Booting a simulator without first running `device_list` (user may have one booted)
- Running bash commands in a tight loop — use `device_batch` instead
- About to call `device_screenshot` to answer "what's on screen" / "is X visible" / "what's the store value" — none of those are screenshot questions. Use `device_snapshot` / `cdp_component_tree` / `cdp_store_state` instead.
- Saving a PR-proof screenshot to `/tmp/` — the tool's `meta.advisories[]` flagged it; re-route to `docs/proof/<feature>/<NN>-<step>.jpg` before claiming the proof is done.
- Setting `maxWidth=0` for a non-visual-diff capture — full-resolution screenshots blow context budgets; the tool flags `FULL_RESOLUTION` so you can catch this.
- Past 5 screenshots in a single debug session without using `cdp_component_tree` / `cdp_store_state` / `cdp_error_log` to investigate state.
- Capturing a screenshot when `cdp_navigation_state` returned `"DevClientLauncher"` / `"ServerPicker"` / empty — that's a screenshot of the dev loader, not your app.
