#!/bin/bash
# ensure-idb-companion.sh — Surface (and optionally install) idb-companion when
# a physical iOS device is connected (GH #59 #3).
#
# Without idb-companion, `device_*` tools cannot drive taps/snapshots on a
# physical iPhone. The pre-existing setup probe (`check-physical-devices.sh`)
# only printed a brew command. This script extends that with an opt-in
# auto-install path.
#
# Default behavior (no env var set):
#   - Detect physical iOS device + missing idb-companion → print clear
#     guidance with the install command and the env-var opt-in line.
#   - exit 0 silently in all happy paths (no device, already installed,
#     non-macOS).
#
# Opt-in auto-install (RN_DEV_AGENT_AUTO_INSTALL_IDB=1):
#   - Attempts `brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion`
#     synchronously (the formula lives in the facebook/fb tap). The install can
#     take many minutes on first run (Homebrew may compile from source);
#     opt-in gating prevents this from blocking SessionStart by default.
#   - Returns exit 1 only when the install was attempted and failed.
#
# Called from SessionStart hook. Stdout is shown to the user.
#
# Exit codes:
#   0 — happy path (already installed, no device, non-macOS, brew missing
#       and we printed manual instructions, OR auto-install succeeded)
#   1 — auto-install was attempted (RN_DEV_AGENT_AUTO_INSTALL_IDB=1) and failed

set -uo pipefail

# --- Skip on non-macOS — idb-companion is macOS-only ---
HOST_OS=$(uname -s 2>/dev/null || echo "Unknown")
if [ "$HOST_OS" != "Darwin" ]; then
  exit 0
fi

# --- Skip if already installed ---
# idb ships the binary as idb_companion on some installs, idb-companion on
# others. Check both; either satisfies the prerequisite.
if command -v idb_companion >/dev/null 2>&1 || command -v idb-companion >/dev/null 2>&1; then
  exit 0
fi

# --- Skip if no physical iOS device is connected ---
# Most users develop against simulators only. No point printing a warning
# for users who don't need idb-companion at all. Detect via the same
# two-probe strategy as check-physical-devices.sh: xctrace first (legacy),
# devicectl fallback (modern Xcode 15+). Either finding a device gates
# the warning.
if ! command -v xcrun >/dev/null 2>&1; then
  exit 0
fi

PHYSICAL_IOS_FOUND=""

# Probe 1: xctrace
if XCTRACE_OUT=$(xcrun xctrace list devices 2>/dev/null \
    | awk '/^== Devices ==$/{flag=1; next} /^== /{flag=0} flag && NF>0' \
    | grep -E '(iPhone|iPad|iPod|Apple TV|Apple Vision|Apple Watch)' 2>/dev/null) \
   && [ -n "$XCTRACE_OUT" ]; then
  PHYSICAL_IOS_FOUND="xctrace"
fi

# Probe 2: devicectl (when xctrace empty)
if [ -z "$PHYSICAL_IOS_FOUND" ] && xcrun --find devicectl >/dev/null 2>&1; then
  if DEVICECTL_OUT=$(xcrun devicectl list devices 2>/dev/null \
      | grep -E '(iPhone|iPad|iPod|Apple Vision|Apple Watch|Apple TV)' \
      | grep 'available' \
      | grep -v 'unavailable' 2>/dev/null) \
     && [ -n "$DEVICECTL_OUT" ]; then
    PHYSICAL_IOS_FOUND="devicectl"
  fi
fi

if [ -z "$PHYSICAL_IOS_FOUND" ]; then
  # No physical iOS device connected — nothing to surface
  exit 0
fi

# --- Physical iOS device present + idb-companion missing ---
# Default: print actionable guidance, do NOT auto-install. Auto-install is
# opt-in via RN_DEV_AGENT_AUTO_INSTALL_IDB=1 because brew install can take
# minutes (compile-from-source) and would block SessionStart.

if [ "${RN_DEV_AGENT_AUTO_INSTALL_IDB:-}" != "1" ]; then
  echo ""
  echo "Physical iOS device detected (via $PHYSICAL_IOS_FOUND), but idb-companion is missing."
  echo "idb-companion is required to drive taps/snapshots on a physical iPhone."
  echo ""
  echo "To install manually:"
  echo "  brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion"
  echo ""
  echo "To auto-install on the next session (warning: brew install can take"
  echo "several minutes on first run while compiling from source):"
  echo "  export RN_DEV_AGENT_AUTO_INSTALL_IDB=1"
  exit 0
fi

# --- Opt-in auto-install path ---
echo ""
echo "Physical iOS device detected (via $PHYSICAL_IOS_FOUND), idb-companion is missing,"
echo "and RN_DEV_AGENT_AUTO_INSTALL_IDB=1 — attempting install."

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is not installed. Install manually:"
  echo "  1. Install Homebrew from https://brew.sh"
  echo "  2. Run: brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion"
  # Exit 0 here: brew-missing is not an "install attempted and failed" state
  # — we never even tried. The user already has clear instructions; we don't
  # want detect-rn-project.sh to bubble up a contradictory failure banner.
  exit 0
fi

echo "Installing idb-companion via Homebrew..."
echo "(This may take several minutes — Homebrew may compile from source.)"
echo ""

if brew tap facebook/fb 2>&1 && { brew trust facebook/fb >/dev/null 2>&1 || true; } && brew install idb-companion 2>&1; then
  echo ""
  if command -v idb_companion >/dev/null 2>&1 || command -v idb-companion >/dev/null 2>&1; then
    echo "idb-companion installed successfully."
    exit 0
  fi
  echo "Homebrew reported success but idb-companion is still not on PATH."
  echo "Try: brew link idb-companion"
  echo ""
  echo "To stop auto-retry on every session, unset the opt-in env var:"
  echo "  unset RN_DEV_AGENT_AUTO_INSTALL_IDB"
  exit 1
fi

echo ""
echo "idb-companion installation failed. Install manually:"
echo "  brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion"
echo ""
echo "To stop auto-retry on every session, unset the opt-in env var:"
echo "  unset RN_DEV_AGENT_AUTO_INSTALL_IDB"
exit 1
