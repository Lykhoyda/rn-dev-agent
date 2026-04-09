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
  # Strip IP addresses (POSIX-compatible, preserve 127.0.0.1 and localhost)
  input=$(echo "$input" | sed -E 's/(^|[^0-9])(192|10|172|169)\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}([^0-9]|$)/\1[IP_REDACTED]\3/g' 2>/dev/null || echo "$input")
  # Strip absolute paths that aren't home (already handled) — catches stack traces
  input=$(echo "$input" | sed -E 's#/(Users|home|opt|var|tmp)/[A-Za-z0-9_./-]{10,}#[PATH_REDACTED]#g' 2>/dev/null || echo "$input")
  # Strip bundle IDs (com.company.app, org.company.app) — contain company names
  input=$(echo "$input" | sed -E 's/(com|org|io|dev|net)\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.-]+/[BUNDLE_REDACTED]/g' 2>/dev/null || echo "$input")
  # Strip app display names and project names from app.json if present
  local project_root="${RN_PROJECT_ROOT:-${CLAUDE_USER_CWD:-$PWD}}"
  if [ -f "$project_root/app.json" ]; then
    local app_name=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('expo',d).get('name',''))" "$project_root/app.json" 2>/dev/null)
    local app_slug=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('expo',d).get('slug',''))" "$project_root/app.json" 2>/dev/null)
    if [ -n "$app_name" ] && [ ${#app_name} -gt 2 ]; then
      input="${input//$app_name/[APP_NAME_REDACTED]}"
    fi
    if [ -n "$app_slug" ] && [ ${#app_slug} -gt 2 ]; then
      input="${input//$app_slug/[APP_SLUG_REDACTED]}"
    fi
  fi
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

# --- Collect CDP bridge log tail (last 30 lines, redacted) ---

cdp_log_tail=""
cdp_log_path=""
if [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ -f "$CLAUDE_PLUGIN_DATA/cdp-bridge.log" ]; then
  cdp_log_path="$CLAUDE_PLUGIN_DATA/cdp-bridge.log"
elif [ -f "$HOME/.claude/logs/rn-dev-agent-cdp-bridge.log" ]; then
  cdp_log_path="$HOME/.claude/logs/rn-dev-agent-cdp-bridge.log"
fi
if [ -n "$cdp_log_path" ]; then
  raw_log=$(tail -30 "$cdp_log_path" 2>/dev/null || echo "")
  if [ -n "$raw_log" ]; then
    cdp_log_tail=$(redact "$raw_log")
  fi
fi

# --- Output sanitized JSON via python3 (safe escaping) ---

telemetry_json=$(echo "$recent_telemetry" | python3 -c "
import sys, json
lines = sys.stdin.read().strip().split('\n')
events = []
for line in lines:
    if not line.strip():
        continue
    try:
        e = json.loads(line)
        safe = {k: e[k] for k in ['ts','event','tool','result','latency_ms','phase'] if k in e}
        events.append(safe)
    except:
        pass
print(json.dumps(events[-20:]))
" 2>/dev/null || echo "[]")

python3 -c "
import json, sys
data = {
    'plugin_version': sys.argv[1],
    'cdp_bridge_version': sys.argv[2],
    'tool_count': sys.argv[3],
    'environment': {
        'os': sys.argv[4],
        'node': sys.argv[5],
        'npm': sys.argv[6],
        'ios_simulators': sys.argv[7],
        'android_emulators': sys.argv[8],
        'metro': sys.argv[9],
        'agent_device': sys.argv[10],
        'maestro_runner': sys.argv[11],
    },
    'recent_telemetry_lines': json.loads(sys.argv[12]),
}
log_tail = sys.argv[13].strip()
if log_tail:
    data['cdp_bridge_log_tail'] = log_tail.split('\n')
print(json.dumps(data, indent=2))
" \
  "$plugin_version" \
  "$cdp_version" \
  "$tool_count" \
  "$os_name $os_version" \
  "$node_version" \
  "$npm_version" \
  "$ios_sim" \
  "$android_emu" \
  "$metro_status" \
  "$agent_device_version" \
  "$maestro_runner_version" \
  "$telemetry_json" \
  "$cdp_log_tail"
