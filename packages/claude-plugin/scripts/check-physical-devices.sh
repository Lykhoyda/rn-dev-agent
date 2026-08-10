#!/usr/bin/env bash
# M9 / Phase 111 (D668): physical-device prerequisite probe.
#
# Detects USB-connected physical devices and reports configuration readiness:
#   - Physical Android: exact authorized serial plus any pre-existing reverse
#     forwards. Session authority is the sole writer of its exact Metro forward.
#   - Physical iOS: `idb-companion` installed (required for idb-based tools).
#
# This script is read-only. It is a no-op when only simulators/emulators are
# running and exits 0 in all cases — an advisory probe, not a gate. Output goes
# to stdout for the /setup skill to parse/summarize.
#
# WiFi debugging is not supported automatically — users must connect by
# USB. We still report `adb connect`'d devices as physical, but never mutate
# their transport or reverse-forward state.

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
# Filter out emulators so we only inspect real hardware.
PHYSICAL_ANDROID=""
if command -v adb >/dev/null 2>&1; then
  PHYSICAL_ANDROID=$(adb devices 2>/dev/null \
    | awk '/\tdevice$/ && $1 !~ /^emulator-/ {print $1}' || true)
fi

if [ -n "${PHYSICAL_ANDROID:-}" ]; then
  echo "Physical Android detected: $(echo "$PHYSICAL_ANDROID" | tr '\n' ' ')"
  for dev in $PHYSICAL_ANDROID; do
    echo "  [READY] authorized adb serial $dev — session authority manages the exact Metro reverse"
    if EXISTING_REVERSE=$(adb -s "$dev" reverse --list 2>/dev/null); then
      if [ -n "$EXISTING_REVERSE" ]; then
        echo "  [WARN] pre-existing adb reverse forwards on $dev (a matching session port is foreign and will be refused):"
        echo "$EXISTING_REVERSE" | sed 's/^/    /'
      else
        echo "  [OK] no pre-existing adb reverse forwards on $dev"
      fi
    else
      echo "  [WARN] could not inspect existing adb reverse forwards on $dev — the session will verify or refuse exact reachability"
    fi
  done
else
  echo "No physical Android devices detected (skipping physical readiness check)"
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
