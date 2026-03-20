#!/bin/bash
# snapshot_state.sh — Concurrent screenshot + UI hierarchy capture
# Usage: bash scripts/snapshot_state.sh [ios|android] [output_dir]
#
# iOS output: screenshot.jpg
# Android output: screenshot.png + ui_elements.json

set -euo pipefail

PLATFORM="${1:-auto}"
OUTPUT_DIR="${2:-/tmp/rn-dev-agent}"

mkdir -p "$OUTPUT_DIR"

# Cleanup background jobs on exit to prevent orphaned processes
cleanup() {
  local pids
  pids=$(jobs -p 2>/dev/null) || true
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
    wait $pids 2>/dev/null || true
  fi
}
trap cleanup EXIT

detect_platform() {
  if xcrun simctl list devices booted 2>/dev/null | grep -q "Booted"; then
    echo "ios"
  elif adb devices 2>/dev/null | grep -q "device$"; then
    echo "android"
  else
    echo "none"
  fi
}

if [ "$PLATFORM" = "auto" ]; then
  PLATFORM=$(detect_platform)
  if [ "$PLATFORM" = "none" ]; then
    echo "Error: No iOS Simulator or Android device/emulator detected." >&2
    exit 1
  fi
fi

case "$PLATFORM" in
  ios)
    xcrun simctl io booted screenshot --type=jpeg "$OUTPUT_DIR/screenshot.jpg"
    echo "iOS snapshot saved to $OUTPUT_DIR/screenshot.jpg"
    ;;

  android)
    # Check for multiple connected devices — auto-select first if ANDROID_SERIAL not set
    DEVICE_COUNT=$(adb devices 2>/dev/null | grep -c "device$" || true)
    if [ "$DEVICE_COUNT" -gt 1 ] && [ -z "${ANDROID_SERIAL:-}" ]; then
      export ANDROID_SERIAL
      ANDROID_SERIAL=$(adb devices | grep -m1 "device$" | awk '{print $1}')
      echo "Warning: Multiple Android devices ($DEVICE_COUNT). Auto-selecting $ANDROID_SERIAL." >&2
    fi

    # Use PID-suffixed temp file to avoid race conditions on concurrent runs
    TMP_XML="/data/local/tmp/uidump_$$.xml"

    # Run screenshot and UI hierarchy dump concurrently
    adb exec-out screencap -p > "$OUTPUT_DIR/screenshot.png" &
    PID_SCREENSHOT=$!

    # Dump UI hierarchy to device file first, then pull it — piping /dev/stdout
    # prepends a status message that corrupts the XML output.
    # Note: || true after uiautomator dump prevents set -e from aborting the subshell
    (
      adb shell uiautomator dump --compressed "$TMP_XML" >/dev/null 2>&1 || true
      adb exec-out cat "$TMP_XML" | \
        python3 -c "
import xml.etree.ElementTree as ET, json, sys
try:
    tree = ET.parse(sys.stdin)
    els = [{'text':n.get('text',''),'id':n.get('resource-id',''),
            'desc':n.get('content-desc',''),'bounds':n.get('bounds',''),
            'clickable':n.get('clickable')=='true'}
           for n in tree.iter('node')
           if n.get('text') or n.get('resource-id') or n.get('content-desc')]
    json.dump(els, sys.stdout, indent=2)
except Exception as e:
    print(f'Error parsing UI hierarchy XML: {e}', file=sys.stderr)
    json.dump([], sys.stdout)
    sys.exit(1)
"
      adb shell rm -f "$TMP_XML" 2>/dev/null || true
    ) > "$OUTPUT_DIR/ui_elements.json" &
    PID_HIERARCHY=$!

    # Wait for both jobs — capture exit codes individually
    SCREENSHOT_OK=0
    HIERARCHY_OK=0
    wait $PID_SCREENSHOT || SCREENSHOT_OK=$?
    wait $PID_HIERARCHY || HIERARCHY_OK=$?

    if [ "$SCREENSHOT_OK" -ne 0 ]; then
      echo "Warning: Screenshot capture failed (exit $SCREENSHOT_OK)." >&2
    fi
    if [ "$HIERARCHY_OK" -ne 0 ]; then
      echo "Warning: UI hierarchy dump failed (exit $HIERARCHY_OK)." >&2
    fi

    echo "Android snapshot saved to $OUTPUT_DIR/"
    echo "  screenshot.png + ui_elements.json"

    # Exit with error only if both failed
    if [ "$SCREENSHOT_OK" -ne 0 ] && [ "$HIERARCHY_OK" -ne 0 ]; then
      exit 1
    fi
    ;;

  *)
    echo "Error: Unknown platform '$PLATFORM'. Use 'ios' or 'android'." >&2
    exit 1
    ;;
esac
