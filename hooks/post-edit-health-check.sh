#!/bin/bash
# post-edit-health-check.sh — PostToolUse hook for Edit/Write/MultiEdit
# Checks for app crashes and compilation errors after RN source file edits.
# Uses last-write-wins debounce: only the most recent edit triggers the check.

set -uo pipefail

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")

# Bail if we couldn't parse the file path
if [[ -z "$file_path" ]]; then
  exit 0
fi

# Only check React Native source files (not .d.ts, test files, or config)
if [[ ! "$file_path" =~ \.(tsx?|jsx?)$ ]]; then
  exit 0
fi
if [[ "$file_path" =~ \.(d\.ts)$ ]]; then
  exit 0
fi
if [[ "$file_path" =~ (__tests__|\.test\.|\.spec\.|\.config\.) ]]; then
  exit 0
fi

# Last-write-wins debounce:
# Write a unique token, sleep, then only proceed if our token is still current.
LOCKFILE="${TMPDIR:-/tmp}/rn-dev-agent-health-check.token"
token="$$-$(date +%s%N 2>/dev/null || date +%s)"
echo "$token" > "$LOCKFILE" 2>/dev/null || exit 0

# Bounded poll: check up to 3s, exit early if Metro + targets are ready
METRO_PORT="${METRO_PORT:-8081}"
max_wait=3
waited=0

while [ "$waited" -lt "$max_wait" ]; do
  sleep 1
  waited=$((waited + 1))

  # Check if a newer edit superseded us
  current_token=$(cat "$LOCKFILE" 2>/dev/null || echo "")
  if [[ "$current_token" != "$token" ]]; then
    exit 0  # Newer edit took over, let it do the check
  fi

  # Check Metro
  metro_status=$(curl -sf --max-time 2 "http://127.0.0.1:$METRO_PORT/status" 2>/dev/null || echo "")
  if [[ "$metro_status" != "packager-status:running" ]]; then
    continue  # Metro might be rebundling, keep waiting
  fi

  # Check debug targets
  targets=$(curl -sf --max-time 2 "http://127.0.0.1:$METRO_PORT/json" 2>/dev/null || echo "[]")
  target_count=$(echo "$targets" | jq 'length' 2>/dev/null || echo "0")

  if [[ "$target_count" != "0" ]]; then
    # Targets exist — verify at least one is Hermes/RN
    has_hermes=$(echo "$targets" | jq '[.[] | select(.title | test("Hermes|React Native"; "i"))] | length' 2>/dev/null || echo "0")
    if [[ "$has_hermes" != "0" ]]; then
      exit 0  # All healthy
    fi
  fi
done

# Final token check before reporting
current_token=$(cat "$LOCKFILE" 2>/dev/null || echo "")
if [[ "$current_token" != "$token" ]]; then
  exit 0
fi

# If we got here, checks failed after max_wait seconds
metro_status=$(curl -sf --max-time 2 "http://127.0.0.1:$METRO_PORT/status" 2>/dev/null || echo "")
if [[ "$metro_status" != "packager-status:running" ]]; then
  exit 0  # Metro not running — not in a dev session, skip
fi

targets=$(curl -sf --max-time 2 "http://127.0.0.1:$METRO_PORT/json" 2>/dev/null || echo "[]")
target_count=$(echo "$targets" | jq 'length' 2>/dev/null || echo "0")

if [[ "$target_count" == "0" ]]; then
  echo "Post-edit health check FAILED: No Hermes debug targets found after editing $(basename "$file_path"). The app likely crashed. Take a screenshot of the simulator and run cdp_status + cdp_error_log to diagnose before continuing." >&2
  exit 2
fi

has_hermes=$(echo "$targets" | jq '[.[] | select(.title | test("Hermes|React Native"; "i"))] | length' 2>/dev/null || echo "0")
if [[ "$has_hermes" == "0" ]]; then
  echo "Post-edit health check WARNING: Debug targets found but none are Hermes/React Native after editing $(basename "$file_path"). Run cdp_status to verify." >&2
  exit 2
fi

exit 0
