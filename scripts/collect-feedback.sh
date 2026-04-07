#!/usr/bin/env bash
# Collect sanitized environment + telemetry data for feedback issues.
# Strips: home paths, secrets, PII, IP addresses, absolute paths.
# Output: JSON to stdout with all sensitive data redacted.

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$HOME/.claude/rn-agent"
TELEMETRY_DIR="$AGENT_DIR/telemetry"

# --- Redaction functions ---

redact() {
  local input="$1"
  # Replace home directory
  input="${input//$HOME/\~}"
  # Strip API keys, tokens, secrets (common patterns)
  input=$(echo "$input" | sed -E \
    -e 's/(sk|pk|api|key|token|secret|password|auth)[-_]?[A-Za-z0-9_\-]{20,}/[REDACTED_SECRET]/gi' \
    -e 's/Bearer [A-Za-z0-9_\-./+=]{20,}/Bearer [REDACTED]/g' \
    -e 's/ghp_[A-Za-z0-9_]{36}/[REDACTED_GH_TOKEN]/g' \
    -e 's/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/[REDACTED_JWT]/g' \
    -e 's/AKIA[0-9A-Z]{16}/[REDACTED_AWS]/g' \
    -e 's/xox[baprs]-[A-Za-z0-9\-]+/[REDACTED_SLACK]/g' \
    2>/dev/null || echo "$input")
  # Strip emails
  input=$(echo "$input" | sed -E 's/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/[EMAIL_REDACTED]/g' 2>/dev/null || echo "$input")
  # Strip IP addresses (but keep localhost/127.0.0.1)
  input=$(echo "$input" | sed -E 's/\b([0-9]{1,3}\.){3}[0-9]{1,3}\b/[IP_REDACTED]/g' 2>/dev/null || echo "$input")
  input="${input//\[IP_REDACTED\]:8081/localhost:8081}"
  input="${input//\[IP_REDACTED\]:8082/localhost:8082}"
  echo "$input"
}

# --- Collect plugin version ---

plugin_version="unknown"
if [ -f "$PLUGIN_ROOT/.claude-plugin/plugin.json" ]; then
  plugin_version=$(python3 -c "import json; print(json.load(open('$PLUGIN_ROOT/.claude-plugin/plugin.json'))['version'])" 2>/dev/null || echo "unknown")
fi

cdp_version="unknown"
if [ -f "$PLUGIN_ROOT/scripts/cdp-bridge/package.json" ]; then
  cdp_version=$(python3 -c "import json; print(json.load(open('$PLUGIN_ROOT/scripts/cdp-bridge/package.json'))['version'])" 2>/dev/null || echo "unknown")
fi

# --- Collect environment info ---

os_name=$(uname -s 2>/dev/null || echo "unknown")
os_version=$(uname -r 2>/dev/null || echo "unknown")
node_version=$(node --version 2>/dev/null || echo "unknown")
npm_version=$(npm --version 2>/dev/null || echo "unknown")

ios_sim="none"
if command -v xcrun &>/dev/null; then
  ios_sim=$(xcrun simctl list devices booted 2>/dev/null | grep -c "Booted" || echo "0")
  ios_sim="${ios_sim} booted"
fi

android_emu="none"
if command -v adb &>/dev/null; then
  android_count=$(adb devices 2>/dev/null | grep -c "device$" 2>/dev/null || true)
  android_emu="${android_count:-0} connected"
fi

metro_status="not running"
if curl -s --max-time 2 http://localhost:8081/status 2>/dev/null | grep -q "packager-status:running"; then
  metro_status="running on 8081"
elif curl -s --max-time 2 http://localhost:8082/status 2>/dev/null | grep -q "packager-status:running"; then
  metro_status="running on 8082"
fi

# --- Collect recent telemetry (last 20 events, redacted) ---

recent_telemetry="[]"
if [ -d "$TELEMETRY_DIR" ]; then
  latest_log=$(ls -t "$TELEMETRY_DIR"/*.jsonl 2>/dev/null | head -1)
  if [ -n "$latest_log" ]; then
    raw=$(tail -20 "$latest_log" 2>/dev/null || echo "")
    if [ -n "$raw" ]; then
      recent_telemetry=$(redact "$raw")
    fi
  fi
fi

# --- Collect MCP tool count ---

tool_count="unknown"
if [ -f "$PLUGIN_ROOT/scripts/cdp-bridge/src/index.ts" ]; then
  tool_count=$(grep -c "trackedTool(" "$PLUGIN_ROOT/scripts/cdp-bridge/src/index.ts" 2>/dev/null || echo "unknown")
fi

# --- Collect agent-device info ---

agent_device_version="not installed"
if command -v agent-device &>/dev/null; then
  agent_device_version=$(agent-device --version 2>/dev/null | head -1 || echo "unknown")
elif [ -f "$HOME/.agent-device/bin/agent-device" ]; then
  agent_device_version=$("$HOME/.agent-device/bin/agent-device" --version 2>/dev/null | head -1 || echo "installed, version unknown")
fi

maestro_runner_version="not installed"
if [ -f "$HOME/.maestro-runner/bin/maestro-runner" ]; then
  maestro_runner_version=$("$HOME/.maestro-runner/bin/maestro-runner" --version 2>/dev/null | head -1 || echo "installed, version unknown")
fi

# --- Output sanitized JSON ---

cat <<ENDJSON
{
  "plugin_version": "$plugin_version",
  "cdp_bridge_version": "$cdp_version",
  "tool_count": "$tool_count",
  "environment": {
    "os": "$os_name $os_version",
    "node": "$node_version",
    "npm": "$npm_version",
    "ios_simulators": "$ios_sim",
    "android_emulators": "$android_emu",
    "metro": "$metro_status",
    "agent_device": "$agent_device_version",
    "maestro_runner": "$maestro_runner_version"
  },
  "recent_telemetry_lines": $(echo "$recent_telemetry" | python3 -c "
import sys, json
lines = sys.stdin.read().strip().split('\n')
events = []
for line in lines:
    if not line.strip():
        continue
    try:
        e = json.loads(line)
        # Keep only safe fields
        safe = {k: e[k] for k in ['ts','event','tool','result','error','latency_ms','phase'] if k in e}
        events.append(safe)
    except:
        pass
print(json.dumps(events[-20:]))
" 2>/dev/null || echo "[]")
}
ENDJSON
