#!/bin/bash
# scripts/snapshot_state.sh
# Captures screenshot + UI hierarchy concurrently
# Usage: snapshot_state.sh [ios|android] [output_dir]

set -euo pipefail

PLATFORM=${1:-$([ -n "$(xcrun simctl list devices booted 2>/dev/null | grep Booted)" ] && echo "ios" || echo "android")}
OUT_DIR=${2:-/tmp/rn-dev-agent}
mkdir -p "$OUT_DIR"

if [ "$PLATFORM" = "ios" ]; then
  xcrun simctl io booted screenshot --type=jpeg "$OUT_DIR/screenshot.jpg" &
  PID_SCREENSHOT=$!

  wait $PID_SCREENSHOT
  echo "{\"platform\":\"ios\",\"screenshot\":\"$OUT_DIR/screenshot.jpg\"}"

elif [ "$PLATFORM" = "android" ]; then
  adb exec-out screencap -p > "$OUT_DIR/screenshot.png" &
  PID_SCREENSHOT=$!

  adb shell uiautomator dump --compressed /dev/stdout > "$OUT_DIR/ui_hierarchy.xml" &
  PID_HIERARCHY=$!

  wait $PID_SCREENSHOT $PID_HIERARCHY

  python3 -c "
import xml.etree.ElementTree as ET, json, sys
try:
    tree = ET.parse('$OUT_DIR/ui_hierarchy.xml')
    elements = []
    for node in tree.iter('node'):
        text = node.get('text', '')
        rid = node.get('resource-id', '')
        desc = node.get('content-desc', '')
        bounds = node.get('bounds', '')
        clickable = node.get('clickable') == 'true'
        visible = node.get('visible-to-user', 'true') != 'false'
        if (text or rid or desc) and visible:
            elements.append({
                'text': text, 'id': rid, 'desc': desc,
                'bounds': bounds, 'clickable': clickable,
                'class': node.get('class', '').split('.')[-1]
            })
    json.dump({'elements': elements, 'count': len(elements)}, sys.stdout, indent=2)
except Exception as e:
    json.dump({'error': str(e)}, sys.stdout)
" > "$OUT_DIR/ui_elements.json"

  echo "{\"platform\":\"android\",\"screenshot\":\"$OUT_DIR/screenshot.png\",\"hierarchy\":\"$OUT_DIR/ui_elements.json\"}"
else
  echo "{\"error\":\"Unknown platform: $PLATFORM. Use 'ios' or 'android'.\"}"
  exit 1
fi
