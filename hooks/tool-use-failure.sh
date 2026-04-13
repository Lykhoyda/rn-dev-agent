#!/bin/bash
# tool-use-failure.sh — PostToolUseFailure hook (D561)
# Provides diagnostic context when MCP tool calls fail.
# Exit codes: 0 = success (output shown to agent), 1 = error (logged, non-blocking),
#             2 = block operation (not used here).

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")

# Only diagnose rn-dev-agent MCP tool failures
case "$tool_name" in
  mcp__*cdp__*) ;;
  *) exit 0 ;;
esac

# Extract the short tool name
short_name="${tool_name##*__}"

CDP_ACTIVE_FLAG="${TMPDIR:-/tmp}/rn-dev-agent-cdp-active"
CDP_SESSION_FILE="${TMPDIR:-/tmp}/rn-dev-agent-cdp-session.json"
METRO_PORT="${METRO_PORT:-8081}"

# Check CDP session state
cdp_active=false
if [ -f "$CDP_ACTIVE_FLAG" ]; then
  # Check staleness
  flag_age=0
  if [ "$(uname)" = "Darwin" ]; then
    flag_mtime=$(stat -f '%m' "$CDP_ACTIVE_FLAG" 2>/dev/null || echo 0)
    now=$(date +%s)
    flag_age=$(( now - flag_mtime ))
  else
    flag_age=$(( $(date +%s) - $(stat -c '%Y' "$CDP_ACTIVE_FLAG" 2>/dev/null || echo 0) ))
  fi
  if [ "$flag_age" -lt 1800 ]; then
    cdp_active=true
  fi
fi

# Check Metro
metro_running=false
metro_status=$(curl -sf --max-time 1 "http://127.0.0.1:$METRO_PORT/status" 2>/dev/null || echo "")
if [ "$metro_status" = "packager-status:running" ]; then
  metro_running=true
fi

# Check simulator/emulator
ios_booted=false
android_booted=false
if command -v xcrun &>/dev/null; then
  xcrun simctl list devices booted 2>/dev/null | grep -q "(Booted)" && ios_booted=true
fi
if command -v adb &>/dev/null; then
  adb devices 2>/dev/null | grep -v "List" | grep -q "device$" && android_booted=true
fi

# Build diagnostic message
diag=""

if [ "$cdp_active" = false ]; then
  diag="CDP session is not active."
  if [ "$metro_running" = false ]; then
    diag="$diag Metro is not running on port $METRO_PORT."
  fi
  if [ "$ios_booted" = false ] && [ "$android_booted" = false ]; then
    diag="$diag No simulator or emulator is running."
  fi
  diag="$diag Try: cdp_status to reconnect."
elif [ "$metro_running" = false ]; then
  diag="CDP session exists but Metro is not responding on port $METRO_PORT. The app may have crashed or Metro was restarted. Try: cdp_reload(full=true)."
else
  # CDP active + Metro running — likely a stale connection or target switch
  diag="CDP session active, Metro running. The connection may be stale. Try: cdp_status to refresh."
fi

if [ -n "$diag" ]; then
  echo "Tool ${short_name} failed. Diagnostic: ${diag}"
fi
