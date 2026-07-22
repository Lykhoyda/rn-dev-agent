#!/bin/bash
# snapshot_state.sh — Exact-device screenshot and UI hierarchy capture
# Usage: bash scripts/snapshot_state.sh [ios|android|auto] --device-id <id> [--output-dir <dir>]

set -euo pipefail
umask 077

PLATFORM="auto"
DEVICE_ID=""
OUTPUT_DIR=""

if [ "$#" -gt 0 ] && { [ "$1" = "ios" ] || [ "$1" = "android" ] || [ "$1" = "auto" ]; }; then
  PLATFORM="$1"
  shift
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --device-id)
      [ "$#" -ge 2 ] || { echo "Error: --device-id requires a value." >&2; exit 1; }
      DEVICE_ID="$2"
      shift 2
      ;;
    --output-dir)
      [ "$#" -ge 2 ] || { echo "Error: --output-dir requires a value." >&2; exit 1; }
      OUTPUT_DIR="$2"
      shift 2
      ;;
    *)
      echo "Error: Unknown argument '$1'." >&2
      exit 1
      ;;
  esac
done

if [ -z "$DEVICE_ID" ]; then
  echo "Error: --device-id is required." >&2
  exit 1
fi

ios_device_is_booted() {
  local devices
  devices=$(xcrun simctl list devices booted 2>/dev/null) || return 1
  printf '%s\n' "$devices" | grep -Fq "($DEVICE_ID) (Booted)"
}

android_device_is_connected() {
  local devices
  devices=$(adb devices 2>/dev/null) || return 1
  printf '%s\n' "$devices" | awk -v id="$DEVICE_ID" '$1 == id && $2 == "device" { found = 1 } END { exit !found }'
}

if [ "$PLATFORM" = "auto" ]; then
  IOS_MATCH=0
  ANDROID_MATCH=0
  ios_device_is_booted && IOS_MATCH=1
  android_device_is_connected && ANDROID_MATCH=1
  if [ "$IOS_MATCH" -eq 1 ] && [ "$ANDROID_MATCH" -eq 0 ]; then
    PLATFORM="ios"
  elif [ "$IOS_MATCH" -eq 0 ] && [ "$ANDROID_MATCH" -eq 1 ]; then
    PLATFORM="android"
  elif [ "$IOS_MATCH" -eq 1 ]; then
    echo "Error: Device identity is ambiguous across iOS and Android: $DEVICE_ID" >&2
    exit 1
  else
    echo "Error: Selected device is not booted or connected: $DEVICE_ID" >&2
    exit 1
  fi
fi

if [ "$PLATFORM" = "ios" ]; then
  if ! [[ "$DEVICE_ID" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]]; then
    echo "Error: Invalid iOS simulator UDID: $DEVICE_ID" >&2
    exit 1
  fi
  if ! ios_device_is_booted; then
    echo "Error: Selected iOS simulator is not booted: $DEVICE_ID" >&2
    exit 1
  fi
elif [ "$PLATFORM" = "android" ]; then
  if ! [[ "$DEVICE_ID" =~ ^[A-Za-z0-9._:-]+$ ]]; then
    echo "Error: Invalid Android device serial: $DEVICE_ID" >&2
    exit 1
  fi
  if ! android_device_is_connected; then
    echo "Error: Selected Android device is not connected: $DEVICE_ID" >&2
    exit 1
  fi
else
  echo "Error: Unknown platform '$PLATFORM'. Use 'ios', 'android', or 'auto'." >&2
  exit 1
fi

if [ -z "$OUTPUT_DIR" ]; then
  OUTPUT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/rn-snapshot.XXXXXX") || {
    echo "Error: Unable to create a private snapshot directory." >&2
    exit 1
  }
elif [ ! -e "$OUTPUT_DIR" ]; then
  mkdir -m 700 -- "$OUTPUT_DIR" || {
    echo "Error: Unable to create snapshot directory: $OUTPUT_DIR" >&2
    exit 1
  }
fi

if [ -L "$OUTPUT_DIR" ] || [ ! -d "$OUTPUT_DIR" ]; then
  echo "Error: Snapshot output must be a real directory, not a symlink: $OUTPUT_DIR" >&2
  exit 1
fi

if [ "$(uname)" = "Darwin" ]; then
  OUTPUT_OWNER=$(stat -f '%u' "$OUTPUT_DIR" 2>/dev/null || true)
  OUTPUT_MODE=$(stat -f '%Lp' "$OUTPUT_DIR" 2>/dev/null || true)
else
  OUTPUT_OWNER=$(stat -c '%u' "$OUTPUT_DIR" 2>/dev/null || true)
  OUTPUT_MODE=$(stat -c '%a' "$OUTPUT_DIR" 2>/dev/null || true)
fi
if [ "$OUTPUT_OWNER" != "$(id -u)" ] || [ "$OUTPUT_MODE" != "700" ]; then
  echo "Error: Snapshot output must be owned by the current user with mode 0700: $OUTPUT_DIR" >&2
  exit 1
fi

OUTPUT_DIR=$(cd "$OUTPUT_DIR" && pwd -P)

validate_output_target() {
  local target="$1"
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
    echo "Error: Snapshot target must be a regular file path: $target" >&2
    exit 1
  fi
}

case "$PLATFORM" in
  ios)
    SCREENSHOT_PATH="$OUTPUT_DIR/screenshot.jpg"
    validate_output_target "$SCREENSHOT_PATH"
    if ! xcrun simctl io "$DEVICE_ID" screenshot --type=jpeg "$SCREENSHOT_PATH"; then
      rm -f -- "$SCREENSHOT_PATH"
      echo "Error: iOS screenshot capture failed." >&2
      exit 1
    fi
    echo "iOS snapshot saved to $SCREENSHOT_PATH"
    ;;

  android)
    SCREENSHOT_PATH="$OUTPUT_DIR/screenshot.png"
    HIERARCHY_PATH="$OUTPUT_DIR/ui_elements.json"
    validate_output_target "$SCREENSHOT_PATH"
    validate_output_target "$HIERARCHY_PATH"
    TMP_XML="/data/local/tmp/rn-dev-agent-uidump-$$.xml"
    cleanup_device_xml() {
      adb -s "$DEVICE_ID" shell rm -f "$TMP_XML" >/dev/null 2>&1 || true
    }
    trap cleanup_device_xml EXIT

    SCREENSHOT_OK=0
    if adb -s "$DEVICE_ID" exec-out screencap -p > "$SCREENSHOT_PATH"; then
      :
    else
      SCREENSHOT_OK=$?
      rm -f -- "$SCREENSHOT_PATH"
      echo "Warning: Screenshot capture failed (exit $SCREENSHOT_OK)." >&2
    fi

    HIERARCHY_OK=0
    if adb -s "$DEVICE_ID" shell uiautomator dump --compressed "$TMP_XML" >/dev/null 2>&1 && \
      adb -s "$DEVICE_ID" exec-out cat "$TMP_XML" | python3 -c "
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
    sys.exit(1)
" > "$HIERARCHY_PATH"; then
      :
    else
      HIERARCHY_OK=$?
      rm -f -- "$HIERARCHY_PATH"
      echo "Warning: UI hierarchy dump failed (exit $HIERARCHY_OK)." >&2
    fi

    cleanup_device_xml
    trap - EXIT
    echo "Android snapshot saved to $OUTPUT_DIR/"
    if [ "$SCREENSHOT_OK" -ne 0 ] && [ "$HIERARCHY_OK" -ne 0 ]; then
      exit 1
    fi
    ;;
esac
