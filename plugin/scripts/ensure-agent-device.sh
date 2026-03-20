#!/bin/bash
# ensure-agent-device.sh — Check for agent-device CLI and install if missing
#
# Called from SessionStart hook. Silent if already installed.
# Stdout is shown to the user. Diagnostics go to stderr.
#
# Exit codes:
#   0 — agent-device available (already installed or just installed)
#   1 — installation failed

set -euo pipefail

if command -v agent-device &>/dev/null; then
  exit 0
fi

# Check common global npm location
NPM_GLOBAL_BIN="$(npm bin -g 2>/dev/null || echo "")"
if [ -n "$NPM_GLOBAL_BIN" ] && [ -x "$NPM_GLOBAL_BIN/agent-device" ]; then
  echo "agent-device found at $NPM_GLOBAL_BIN but not in PATH."
  echo "Add to PATH or run: npm install -g agent-device"
  exit 0
fi

echo ""
echo "agent-device is not installed. It enables native device control:"
echo "  - List devices, take screenshots, read accessibility snapshots"
echo "  - Find elements by text, press, fill inputs, swipe, navigate back"
echo "  - Cross-platform iOS/Android interaction without Maestro"
echo ""
echo "Installing agent-device..."

if npm install -g agent-device 2>&1; then
  echo ""
  echo "agent-device installed successfully."
  if command -v agent-device &>/dev/null; then
    VERSION=$(agent-device --version 2>&1 | head -1 || echo "unknown")
    echo "Version: $VERSION"
  fi
  exit 0
else
  echo "agent-device installation failed. Install manually:"
  echo "  npm install -g agent-device"
  exit 1
fi
