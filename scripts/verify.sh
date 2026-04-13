#!/bin/bash
# rn-verify — Headless CI runner for Maestro E2E regression suite
#
# Discovers and runs all Maestro flows in .maestro/flows/ without requiring
# a Claude Code session. Wraps maestro-runner directly.
#
# Usage:
#   rn-verify                              # Run all flows on auto-detected platform
#   rn-verify --platform ios               # Run on iOS only
#   rn-verify --platform android           # Run on Android only
#   rn-verify --pattern "cart|checkout"     # Filter flows by regex
#   rn-verify --flow-dir ./e2e/flows       # Custom flow directory
#   rn-verify --timeout 60000              # Per-flow timeout in ms (default: 120000)
#   rn-verify --stop-on-failure            # Stop after first failure
#
# Exit codes:
#   0 — all flows passed
#   1 — one or more flows failed
#   2 — setup error (no maestro-runner, no flows, no platform)

set -euo pipefail

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

# Find maestro-runner
RUNNER=""
if command -v maestro-runner &>/dev/null; then
  RUNNER="maestro-runner"
elif [ -x "$HOME/.maestro-runner/bin/maestro-runner" ]; then
  RUNNER="$HOME/.maestro-runner/bin/maestro-runner"
else
  echo "ERROR: maestro-runner not found."
  echo "Install: curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash"
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
  # Walk up from CWD to find .maestro/flows/
  DIR="$PWD"
  while [ "$DIR" != "/" ]; do
    if [ -d "$DIR/.maestro/flows" ]; then
      FLOW_DIR="$DIR/.maestro/flows"
      break
    fi
    DIR=$(dirname "$DIR")
  done
  if [ -z "$FLOW_DIR" ]; then
    echo "ERROR: No .maestro/flows/ directory found. Pass --flow-dir explicitly."
    exit 2
  fi
fi

# Discover flows
FLOWS=()
while IFS= read -r -d '' f; do
  if [ -n "$PATTERN" ]; then
    if echo "$f" | grep -qiE "$PATTERN"; then
      FLOWS+=("$f")
    fi
  else
    FLOWS+=("$f")
  fi
done < <(find "$FLOW_DIR" -name '*.yaml' -o -name '*.yml' | sort | tr '\n' '\0')

if [ ${#FLOWS[@]} -eq 0 ]; then
  echo "ERROR: No Maestro flows found in $FLOW_DIR"
  [ -n "$PATTERN" ] && echo "  (pattern: $PATTERN)"
  exit 2
fi

# Run flows
echo "rn-verify — Maestro E2E Regression Suite"
echo "========================================="
echo "Platform:  $PLATFORM"
echo "Flow dir:  $FLOW_DIR"
echo "Flows:     ${#FLOWS[@]}"
echo "Timeout:   ${TIMEOUT}ms per flow"
[ -n "$PATTERN" ] && echo "Pattern:   $PATTERN"
echo ""

PASSED=0
FAILED=0
ERRORS=()

for FLOW in "${FLOWS[@]}"; do
  NAME=$(basename "$FLOW")
  START=$(python3 -c 'import time; print(int(time.time()*1000))')

  if "$RUNNER" --platform "$PLATFORM" --timeout "$((TIMEOUT / 1000))" test "$FLOW" > /tmp/rn-verify-output.txt 2>&1; then
    DURATION=$(( $(python3 -c 'import time; print(int(time.time()*1000))') - START ))
    echo "  PASS  $NAME  (${DURATION}ms)"
    PASSED=$((PASSED + 1))
  else
    DURATION=$(( $(python3 -c 'import time; print(int(time.time()*1000))') - START ))
    echo "  FAIL  $NAME  (${DURATION}ms)"
    FAILED=$((FAILED + 1))
    ERRORS+=("$NAME")
    if $STOP_ON_FAILURE; then
      echo ""
      echo "Stopped after first failure (--stop-on-failure)"
      break
    fi
  fi
done

echo ""
echo "-----------------------------------------"
echo "Results: $PASSED passed, $FAILED failed (${#FLOWS[@]} total)"

if [ $FAILED -gt 0 ]; then
  echo ""
  echo "Failed flows:"
  for E in "${ERRORS[@]}"; do
    echo "  - $E"
  done
  exit 1
fi

exit 0
