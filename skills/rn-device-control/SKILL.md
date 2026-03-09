# React Native Device Control

Commands for managing iOS Simulators and Android Emulators.

## iOS Simulator (xcrun simctl)

### Lifecycle
```bash
# List booted simulators
xcrun simctl list devices booted

# Boot a specific simulator
xcrun simctl boot "iPhone 16 Pro"

# Shutdown
xcrun simctl shutdown booted

# Install app
xcrun simctl install booted /path/to/App.app

# Launch app
xcrun simctl launch booted com.example.app

# Terminate app
xcrun simctl terminate booted com.example.app

# Uninstall app
xcrun simctl uninstall booted com.example.app
```

### Deep Links
```bash
xcrun simctl openurl booted "myapp://home"
xcrun simctl openurl booted "myapp://product/123"
```

### Fast Screenshot (prefer JPEG — 2x faster)
```bash
xcrun simctl io booted screenshot --type=jpeg /tmp/rn-screenshot.jpg
```

### Permissions
```bash
# Grant permissions
xcrun simctl privacy booted grant photos com.example.app
xcrun simctl privacy booted grant camera com.example.app
xcrun simctl privacy booted grant location com.example.app

# Reset all permissions
xcrun simctl privacy booted reset all com.example.app
```

### Language/Locale
```bash
# Set simulator language (requires restart)
xcrun simctl spawn booted defaults write NSGlobalDomain AppleLanguages -array "es"
xcrun simctl spawn booted defaults write NSGlobalDomain AppleLocale -string "es_ES"
```

### Clear App Data
```bash
# Full reset (uninstall + reinstall)
xcrun simctl uninstall booted com.example.app
xcrun simctl install booted /path/to/App.app
```

## Android Emulator (adb)

### Lifecycle
```bash
# List connected devices
adb devices

# Install APK
adb install -r /path/to/app.apk

# Launch app
adb shell am start -n com.example.app/.MainActivity

# Force stop app
adb shell am force-stop com.example.app

# Clear app data
adb shell pm clear com.example.app
```

### Deep Links
```bash
adb shell am start -a android.intent.action.VIEW -d "myapp://home" com.example.app
```

### Fast Screenshot
```bash
# Standard (300ms)
adb exec-out screencap -p > /tmp/rn-screenshot.png

# Faster with gzip (150ms)
adb exec-out "screencap | gzip -1" > /tmp/s.gz && gunzip -f /tmp/s.gz
```

### UI Hierarchy (structured screen state)
```bash
# Get XML of all visible elements — 10x more token-efficient than screenshot
adb shell uiautomator dump --compressed /dev/stdout
```

Parse to JSON for agent consumption:
```bash
adb shell uiautomator dump --compressed /dev/stdout | \
  python3 -c "
import xml.etree.ElementTree as ET, json, sys
tree = ET.parse(sys.stdin)
els = [{'text':n.get('text',''),'id':n.get('resource-id',''),
        'bounds':n.get('bounds',''),'clickable':n.get('clickable')=='true'}
       for n in tree.iter('node')
       if n.get('text') or n.get('resource-id')]
json.dump(els, sys.stdout, indent=2)"
```

### Disable Animations (faster testing)
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

### Native Logs
```bash
# React Native JS errors
adb logcat -s ReactNative:E ReactNativeJS:E

# App-specific with PID
adb logcat --pid=$(adb shell pidof -s com.example.app) -s ReactNative:E ReactNativeJS:E

# Native crashes
adb logcat -b crash
```

### Permissions
```bash
adb shell pm grant com.example.app android.permission.CAMERA
adb shell pm grant com.example.app android.permission.ACCESS_FINE_LOCATION
```

## Concurrent State Snapshot

Use `scripts/snapshot_state.sh` for concurrent screenshot + UI hierarchy capture:
```bash
bash scripts/snapshot_state.sh ios /tmp/state
bash scripts/snapshot_state.sh android /tmp/state
```

## Decision: When to Use What

| Need | iOS | Android |
|------|-----|---------|
| Screenshot | `xcrun simctl io booted screenshot --type=jpeg` | `adb exec-out screencap -p >` |
| Screen state (structured) | CDP `cdp_component_tree` | `adb shell uiautomator dump` or CDP |
| Deep link | `xcrun simctl openurl booted` | `adb shell am start -a VIEW -d` |
| App lifecycle | `xcrun simctl launch/terminate` | `adb shell am start/force-stop` |
| Native crash logs | `xcrun simctl spawn booted log stream` | `adb logcat -b crash` |
