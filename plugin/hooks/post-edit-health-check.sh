#!/bin/bash
# post-edit-health-check.sh — PostToolUse hook for Edit/Write/MultiEdit
# Checks for app crashes and compilation errors after RN source file edits.
# Uses last-write-wins debounce: only the most recent edit triggers the check.
#
# Skips when: no active CDP session (rn-dev-agent not in use), file is outside
# an RN project, no simulator/emulator running, Metro not running.
# Non-blocking warning for "no Hermes target" (GH #1, #2).

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

# --- Guard: only run if the CDP bridge has an active session ---
# The MCP server writes this flag when connected to a Hermes target.
# Without it, there's no active rn-dev-agent workflow — skip.
CDP_ACTIVE_FLAG="${TMPDIR:-/tmp}/rn-dev-agent-cdp-active"
if [[ ! -f "$CDP_ACTIVE_FLAG" ]]; then
  exit 0
fi

# --- Guard: only run if the edited file is inside a React Native project ---
# Walk up from the file. Stop at the first package.json and check if it has
# react-native as a dependency key (not just a substring match).
is_rn_project=false
check_dir=$(dirname "$file_path")
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [[ -f "$check_dir/package.json" ]]; then
    if grep -qE '"react-native"[[:space:]]*:' "$check_dir/package.json" 2>/dev/null; then
      is_rn_project=true
    fi
    break  # Stop at the first package.json boundary regardless
  fi
  [[ "$check_dir" == "/" || -z "$check_dir" ]] && break
  check_dir="${check_dir%/*}"
  [[ -z "$check_dir" ]] && check_dir="/"
done

if [[ "$is_rn_project" != "true" ]]; then
  exit 0  # Not inside an RN project — skip entirely
fi

# --- Guard: check if a simulator/emulator is running ---
ios_booted=false
if command -v xcrun &>/dev/null; then
  if xcrun simctl list devices booted 2>/dev/null | grep -q "(Booted)"; then
    ios_booted=true
  fi
fi

android_booted=false
if command -v adb &>/dev/null; then
  if adb devices 2>/dev/null | grep -v "List" | grep -q "device$"; then
    android_booted=true
  fi
fi

if [[ "$ios_booted" != "true" && "$android_booted" != "true" ]]; then
  exit 0  # No simulator or emulator running — skip
fi

# --- Guard: check if Metro is running before starting the poll ---
METRO_PORT="${METRO_PORT:-8081}"
metro_status=$(curl -sf --max-time 1 "http://127.0.0.1:$METRO_PORT/status" 2>/dev/null || echo "")
if [[ "$metro_status" != "packager-status:running" ]]; then
  exit 0  # Metro not running — not in a dev session, skip
fi

# --- Guard: check if the app is actually installed on the simulator ---
if [[ "$ios_booted" == "true" ]]; then
  app_json="$check_dir/app.json"
  if [[ -f "$app_json" ]]; then
    bundle_id=$(jq -r '.expo.ios.bundleIdentifier // empty' "$app_json" 2>/dev/null)
    if [[ -n "$bundle_id" ]]; then
      installed=$(xcrun simctl listapps booted 2>/dev/null | grep -c "$bundle_id" || echo "0")
      if [[ "$installed" == "0" ]]; then
        exit 0  # App not installed on simulator — skip
      fi
    fi
  fi
fi

# Last-write-wins debounce:
# Write a unique token, sleep, then only proceed if our token is still current.
LOCKFILE="${TMPDIR:-/tmp}/rn-dev-agent-health-check.token"
token="$$-$(date +%s%N 2>/dev/null || date +%s)"
echo "$token" > "$LOCKFILE" 2>/dev/null || exit 0

# Bounded poll: check up to 3s, exit early if Metro + targets are ready
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
    has_hermes=$(echo "$targets" | jq '[.[] | select((.title // "" | test("Hermes|React Native"; "i")) or (.description // "" | test("React Native"; "i")))] | length' 2>/dev/null || echo "0")
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

# Metro is running but no Hermes targets found. Non-blocking warning. (GH #1)
echo "Post-edit health check: No Hermes debug targets found after editing $(basename "$file_path"). The app may have crashed or is not running. Run cdp_status to check." >&2
exit 0
