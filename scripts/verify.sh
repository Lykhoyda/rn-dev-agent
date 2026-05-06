#!/bin/bash
# rn-verify — Headless CI runner for Maestro flows in .rn-agent/actions/
#
# Discovers and runs all plugin-managed Maestro flows in .rn-agent/actions/
# without requiring a Claude Code session. Wraps maestro-runner directly.
# Pass --flow-dir to point at any other directory (e.g. your own .maestro/flows/).
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
  # Walk up from CWD to find .rn-agent/actions/
  LEGACY_FOUND=""
  DIR="$PWD"
  while [ "$DIR" != "/" ]; do
    if [ -d "$DIR/.rn-agent/actions" ]; then
      FLOW_DIR="$DIR/.rn-agent/actions"
      break
    fi
    if [ -z "$LEGACY_FOUND" ] && [ -d "$DIR/.maestro/flows" ]; then
      LEGACY_FOUND="$DIR/.maestro/flows"
    fi
    DIR=$(dirname "$DIR")
  done
  if [ -z "$FLOW_DIR" ]; then
    if [ -n "$LEGACY_FOUND" ]; then
      echo "ERROR: No .rn-agent/actions/ directory found." >&2
      echo "NOTE: D1208 changed the default flow directory from .maestro/flows/ to .rn-agent/actions/." >&2
      echo "      Found .maestro/flows/ at $LEGACY_FOUND — run with --flow-dir $LEGACY_FOUND" >&2
      echo "      to keep prior behavior, or run /rn-dev-agent:setup to scaffold the new layout." >&2
    else
      echo "ERROR: No .rn-agent/actions/ directory found. Run /rn-dev-agent:setup or pass --flow-dir explicitly." >&2
    fi
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
