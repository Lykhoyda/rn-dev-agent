#!/bin/bash
# ensure-android-ready.sh — Android emulator readiness checks
#
# Called from SessionStart hook when an Android emulator is detected.
# Verifies the emulator is fully booted, cleans stale port forwarding,
# and warns about common Android pitfalls.
#
# Exit codes:
#   0 — Android ready (or no Android device detected — silent skip)
#   1 — Android detected but not ready (message printed)

set -uo pipefail

if ! command -v adb &>/dev/null; then
  exit 0
fi

device_line=$(adb devices 2>/dev/null | grep -m1 "device$" || true)
if [ -z "$device_line" ]; then
  exit 0
fi

device_id=$(echo "$device_line" | awk '{print $1}')
errors=()

# 1. Check boot completion
boot_done=$(adb -s "$device_id" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || echo "")
if [ "$boot_done" != "1" ]; then
  errors+=("Emulator $device_id is still booting (sys.boot_completed != 1). Wait for full boot.")
fi

# 2. Clean stale Maestro port forwarding (port 7001 is classic Maestro's gRPC)
if adb forward --list 2>/dev/null | grep -q "tcp:7001"; then
  adb forward --remove tcp:7001 2>/dev/null || true
fi

# 3. Persist ANDROID_SERIAL for child processes (export alone doesn't propagate to parent)
SERIAL_FILE="${TMPDIR:-/tmp}/rn-dev-agent-android-serial"
device_count=$(adb devices 2>/dev/null | grep -c "device$" || echo "0")
if [ "$device_count" -gt 1 ] && [ -z "${ANDROID_SERIAL:-}" ]; then
  echo "$device_id" > "$SERIAL_FILE"
  echo "Multiple Android devices detected. Auto-selected: $device_id"
  echo "Persisted to $SERIAL_FILE for child processes."
elif [ "$device_count" -eq 1 ]; then
  echo "$device_id" > "$SERIAL_FILE"
fi

# 4. Check maestro-runner availability (required for Android — classic Maestro gRPC is unreliable)
if ! command -v maestro-runner &>/dev/null; then
  mr_bin="$HOME/.maestro-runner/bin/maestro-runner"
  if [ ! -x "$mr_bin" ]; then
    errors+=("maestro-runner not found. Required for Android E2E testing (classic Maestro gRPC is unreliable on Android). Install: curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash")
  fi
fi

# 5. Warn about Play Protect (can silently block Maestro APK installation)
# Only warn once per emulator boot — use a flag file
play_protect_flag="${TMPDIR:-/tmp}/rn-dev-agent-play-protect-warned-${device_id}"
if [ ! -f "$play_protect_flag" ]; then
  echo ""
  echo "Android emulator $device_id detected."
  echo "Tip: Disable Google Play Protect on the emulator to prevent it from"
  echo "blocking test APK installations (Settings > Security > Play Protect)."
  touch "$play_protect_flag" 2>/dev/null || true
fi

if [ ${#errors[@]} -gt 0 ]; then
  for err in "${errors[@]}"; do
    echo "Warning: $err" >&2
  done
  exit 1
fi

exit 0
