#!/usr/bin/env bash
# M9 / Phase 111 (D668): physical-device prerequisite probe.
#
# Detects USB-connected physical devices and applies (or suggests) the
# configuration metro-mcp flags as top-3 troubleshooting issues:
#   - Physical Android: `adb reverse tcp:8081 tcp:8081` so the device can
#     reach Metro running on the Mac.
#   - Physical iOS: `idb-companion` installed (required for idb-based tools).
#
# No-op when only simulators/emulators are running. Exits 0 in all cases —
# this is an advisory probe, not a gate. Output goes to stdout for the
# /setup skill to parse/summarize.
#
# WiFi debugging is not supported automatically — users must connect by
# USB. We do treat `adb connect`'d devices as physical for adb reverse
# purposes since the command works the same across transports.

set -uo pipefail

# --- Host OS ---
# The iOS probe uses xcrun (macOS-only). Linux/WSL hosts have no way to
# connect physical iOS devices, so we report the OS context up-front.
# Android is cross-platform (adb works on Linux/Windows too).
HOST_OS=$(uname -s 2>/dev/null || echo "Unknown")
echo "Host OS: $HOST_OS"

# --- Physical Android ---
# `adb devices` lists every transport-available device. Emulator entries
# start with "emulator-"; physical USB + `adb connect`'d devices do not.
# Filter out emulators so we only operate on real hardware.
PHYSICAL_ANDROID=""
if command -v adb >/dev/null 2>&1; then
  PHYSICAL_ANDROID=$(adb devices 2>/dev/null \
    | awk '/\tdevice$/ && $1 !~ /^emulator-/ {print $1}' || true)
fi

if [ -n "${PHYSICAL_ANDROID:-}" ]; then
  echo "Physical Android detected: $(echo "$PHYSICAL_ANDROID" | tr '\n' ' ')"
  for dev in $PHYSICAL_ANDROID; do
    if adb -s "$dev" reverse tcp:8081 tcp:8081 >/dev/null 2>&1; then
      echo "  [OK] adb reverse tcp:8081 tcp:8081 on $dev"
    else
      echo "  [FAIL] adb reverse on $dev — device may not be authorized (check for USB-debug dialog on phone)"
    fi
  done
else
  echo "No physical Android devices detected (skipping adb reverse)"
fi

# --- Physical iOS ---
# Two probes — modern Xcode (15+) ships `devicectl` which lists devices
# missed by the legacy `xctrace` tool, especially iOS 17+ devices that
# only appear via CoreDevice. GH #59 #2: a paired iPhone 15 Pro Max
# was visible to `devicectl list devices` but invisible to xctrace,
# so the script reported "No physical iOS devices detected" despite
# `available (paired)` state.
#
# Strategy: try xctrace first (compatible across older Xcode), then
# fall back to devicectl. Either tool finding a device counts.
PHYSICAL_IOS=""
PHYSICAL_IOS_SOURCE=""
if [ "$HOST_OS" != "Darwin" ]; then
  echo "Physical iOS probe skipped (requires macOS; host is $HOST_OS)"
elif command -v xcrun >/dev/null 2>&1; then
  # xctrace's "== Devices ==" includes the host Mac itself (for Mac Catalyst
  # targeting). Filter positively on iOS form factors so the host doesn't get
  # mistaken for a connected iPhone/iPad.
  PHYSICAL_IOS=$(xcrun xctrace list devices 2>/dev/null \
    | awk '/^== Devices ==$/{flag=1; next} /^== /{flag=0} flag && NF>0' \
    | grep -E '(iPhone|iPad|iPod|Apple TV|Apple Vision|Apple Watch)' || true)
  if [ -n "$PHYSICAL_IOS" ]; then
    PHYSICAL_IOS_SOURCE="xctrace"
  fi

  # Augment with devicectl when available (Xcode 15+). Catches iOS 17+
  # devices that xctrace misses. devicectl prints a header banner + table;
  # filter rows where the State column contains "available" (skips
  # "unavailable"/"connecting" states) and the Model column starts with
  # an iOS form factor (skips the host Mac when present).
  if [ -z "$PHYSICAL_IOS" ] && xcrun --find devicectl >/dev/null 2>&1; then
    PHYSICAL_IOS=$(xcrun devicectl list devices 2>/dev/null \
      | grep -E '(iPhone|iPad|iPod|Apple Vision|Apple Watch|Apple TV)' \
      | grep 'available' \
      | grep -v 'unavailable' || true)
    if [ -n "$PHYSICAL_IOS" ]; then
      PHYSICAL_IOS_SOURCE="devicectl"
    fi
  fi
fi

if [ -n "${PHYSICAL_IOS:-}" ]; then
  echo "Physical iOS detected (via $PHYSICAL_IOS_SOURCE):"
  echo "$PHYSICAL_IOS" | sed 's/^/  /'
  # idb ships the binary as idb_companion on some installs, idb-companion on
  # others. Check both; either satisfies the prerequisite.
  if command -v idb_companion >/dev/null 2>&1 || command -v idb-companion >/dev/null 2>&1; then
    echo "  [OK] idb-companion installed"
  else
    echo "  [MISSING] idb-companion — install with: brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion"
  fi
elif [ "$HOST_OS" = "Darwin" ]; then
  echo "No physical iOS devices detected (skipping idb-companion check)"
fi

echo ""
echo "Note: WiFi debugging is not supported automatically. Use USB connections."
