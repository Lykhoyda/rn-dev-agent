#!/bin/bash
# rn-verify — Headless CI runner for Maestro flows in .rn-agent/actions/
#
# Discovers and runs all plugin-managed Maestro flows in .rn-agent/actions/
# without requiring a Claude Code session. Uses only the exact pin-cache
# maestro-runner (version + checksum). Never PATH, ~/.maestro-runner, or
# maestro-cli. Pass --flow-dir only for an owned .rn-agent/actions directory.
#
# Usage:
#   rn-verify                              # Run all flows on auto-detected platform
#   rn-verify --platform ios               # Run on iOS only
#   rn-verify --platform android           # Run on Android only
#   rn-verify --pattern "cart|checkout"     # Filter flows by regex
#   rn-verify --flow-dir .rn-agent/actions # Explicit owned action corpus
#   rn-verify --timeout 60000              # Per-flow timeout in ms (default: 120000)
#   rn-verify --stop-on-failure            # Stop after first failure
#
# Exit codes:
#   0 — all flows passed
#   1 — one or more flows failed
#   2 — setup error (pin missing/drifted/checksum, no flows, no platform)

set -euo pipefail

resolve_script_dir() {
  local source="$1"
  while [ -L "$source" ]; do
    local dir
    dir="$(cd "$(dirname "$source")" && pwd)"
    source="$(readlink "$source")"
    case "$source" in
      /*) ;;
      *) source="$dir/$source" ;;
    esac
  done
  cd "$(dirname "$source")" && pwd
}

SCRIPT_DIR="$(resolve_script_dir "${BASH_SOURCE[0]}")"
VERIFY_CLI="$SCRIPT_DIR/../packages/rn-dev-agent-core/dist/maestro-runner-pin.js"
if [ ! -f "$VERIFY_CLI" ]; then
  VERIFY_CLI="$SCRIPT_DIR/../rn-dev-agent-core/dist/maestro-runner-pin.js"
fi

PLATFORM=""
FLOW_DIR=""
PATTERN=""
TIMEOUT=120000
STOP_ON_FAILURE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --platform|-p)   PLATFORM="$2"; shift 2 ;;
    --flow-dir|-d)   FLOW_DIR="$2"; shift 2 ;;
    --pattern|-f)    PATTERN="$2"; shift 2 ;;
    --timeout|-t)    TIMEOUT="$2"; shift 2 ;;
    --stop-on-failure|-s) STOP_ON_FAILURE=true; shift ;;
    --help|-h)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

if [ ! -f "$VERIFY_CLI" ]; then
  echo "ERROR: packaged maestro-runner replay entry point was not found."
  exit 2
fi

# Auto-detect platform if not specified
if [ -z "$PLATFORM" ]; then
  if xcrun simctl list devices booted 2>/dev/null | grep -q "(Booted)"; then
    PLATFORM="ios"
  elif adb devices 2>/dev/null | grep -q "device$"; then
    PLATFORM="android"
  else
    echo "ERROR: No booted simulator or emulator found. Pass --platform explicitly."
    exit 2
  fi
fi

# Find flow directory
if [ -z "$FLOW_DIR" ]; then
  # Walk up from CWD to find .rn-agent/actions/
  DIR="$PWD"
  while [ "$DIR" != "/" ]; do
    if [ -d "$DIR/.rn-agent/actions" ]; then
      FLOW_DIR="$DIR/.rn-agent/actions"
      break
    fi
    DIR=$(dirname "$DIR")
  done
  if [ -z "$FLOW_DIR" ]; then
    echo "ERROR: No owned .rn-agent/actions/ directory found. Run /rn-dev-agent:setup and migrate or create compatible owned actions." >&2
    exit 2
  fi
fi

VERIFY_ARGS=(verify-actions --platform "$PLATFORM" --flow-dir "$FLOW_DIR" --timeout "$TIMEOUT")
[ -n "$PATTERN" ] && VERIFY_ARGS+=(--pattern "$PATTERN")
$STOP_ON_FAILURE && VERIFY_ARGS+=(--stop-on-failure)
exec node "$VERIFY_CLI" "${VERIFY_ARGS[@]}"
