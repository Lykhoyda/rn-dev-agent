---
name: rn-device-control
description: This skill should be used when the user asks to "control the simulator", "take a screenshot", "boot the emulator", "install the app", "read UI hierarchy", "manage device state", "open a deep link", "grant permissions", "stream native logs", "disable animations", "change device locale", or needs guidance on xcrun simctl, adb commands, screenshot capture, Expo/EAS builds, or device lifecycle management for React Native testing.
---

# rn-device-control — Device Lifecycle and State Extraction

Commands for controlling iOS Simulator and Android Emulator, taking screenshots,
reading UI state, and managing device settings. All commands run via bash.

---

## iOS Simulator (simctl)

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
bash scripts/snapshot_state.sh [ios|android] [output_dir]

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

## agent-device CLI (Cross-Platform Native Control)

agent-device provides unified device interaction across iOS and Android without
platform-specific branching. Prefer it over raw simctl/adb for interactive testing.

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

If agent-device is unavailable, fall back to:
- iOS: `xcrun simctl` for device lifecycle, Maestro for interaction
- Android: `adb` for device lifecycle, Maestro for interaction

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
