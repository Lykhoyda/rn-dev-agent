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
  # Replace home directory (pure bash, cannot fail)
  input="${input//$HOME/\~}"
  # All regex redactions run as ONE sed program so a partial failure cannot ship
  # partially-redacted output, and fail CLOSED (placeholder, never the original).
  # Dash is placed last inside every bracket expression to avoid BSD/macOS sed
  # "invalid character range" errors that previously made this stage fail open.
  local redacted
  redacted=$(printf '%s\n' "$input" | sed -E \
    -e 's/(sk|pk|api|key|token|secret|password|auth)[-_]?[A-Za-z0-9_-]{20,}/[REDACTED_SECRET]/gi' \
    -e 's/Bearer [A-Za-z0-9_./+=-]{20,}/Bearer [REDACTED]/g' \
    -e 's/ghp_[A-Za-z0-9_]{36}/[REDACTED_GH_TOKEN]/g' \
    -e 's/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/[REDACTED_JWT]/g' \
    -e 's/AKIA[0-9A-Z]{16}/[REDACTED_AWS]/g' \
    -e 's/xox[baprs]-[A-Za-z0-9-]+/[REDACTED_SLACK]/g' \
    -e 's/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/[EMAIL_REDACTED]/g' \
    -e 's/(^|[^0-9])(192|10|172|169)\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}([^0-9]|$)/\1[IP_REDACTED]\3/g' \
    -e 's#(localhost|127\.0\.0\.1):[0-9]{2,5}#[LOOPBACK_ENDPOINT_REDACTED]#g' \
    -e 's/"(metroPort|observePort|port)"[[:space:]]*:[[:space:]]*[0-9]+/"\1":"[PORT_REDACTED]"/g' \
    -e 's#/(Users|home|opt|var|tmp)/[A-Za-z0-9_./-]{10,}#[PATH_REDACTED]#g' \
    -e 's/(com|org|io|dev|net)\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.-]+/[BUNDLE_REDACTED]/g') \
    || { printf '%s' '[REDACTION_FAILED]'; return 0; }
  input="$redacted"
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
  printf '%s\n' "$input"
}

# --- Collect plugin version ---

plugin_version="unknown"
for manifest in \
  "$PLUGIN_ROOT/.codex-plugin/plugin.json" \
  "$PLUGIN_ROOT/.claude-plugin/plugin.json" \
  "$PLUGIN_ROOT/plugin.json" \
  "$PLUGIN_ROOT/packages/claude-plugin/plugin.json"; do
  if [ -f "$manifest" ]; then
    plugin_version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$manifest" 2>/dev/null || echo "unknown")
    break
  fi
done

cdp_version="unknown"
for manifest in \
  "$PLUGIN_ROOT/rn-dev-agent-core/package.json" \
  "$PLUGIN_ROOT/packages/rn-dev-agent-core/package.json"; do
  if [ -f "$manifest" ]; then
    cdp_version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$manifest" 2>/dev/null || echo "unknown")
    break
  fi
done

# --- Collect environment info ---

os_name=$(uname -s 2>/dev/null || echo "unknown")
os_version=$(uname -r 2>/dev/null || echo "unknown")
node_version=$(node --version 2>/dev/null || echo "unknown")
npm_version=$(npm --version 2>/dev/null || echo "unknown")

ios_sim="none"
if command -v xcrun &>/dev/null; then
  ios_sim=$(xcrun simctl list devices booted 2>/dev/null | grep -c "Booted" || true)
  ios_sim="${ios_sim:-0} booted"
fi

android_emu="none"
if command -v adb &>/dev/null; then
  android_count=$(adb devices 2>/dev/null | grep -c "device$" 2>/dev/null || true)
  android_emu="${android_count:-0} connected"
fi

authority_json='{"sessionAvailable":false,"authorityState":"unavailable","ownMetroAllocated":false,"ownMetroBound":false,"foreignSessionCount":0}'
for session_cli in \
  "${RN_DEV_AGENT_SESSION_CLI:-}" \
  "$PLUGIN_ROOT/rn-dev-agent-core/dist/rn-session.js" \
  "$PLUGIN_ROOT/packages/rn-dev-agent-core/dist/rn-session.js"; do
  if [ -n "$session_cli" ] && [ -f "$session_cli" ]; then
    node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    node_minor=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
    if { [ "$node_major" -eq 22 ] && [ "$node_minor" -ge 5 ]; } || { [ "$node_major" -eq 23 ] && [ "$node_minor" -lt 6 ]; }; then
      candidate=$(node --experimental-sqlite "$session_cli" feedback-json 2>/dev/null || true)
    else
      candidate=$(node "$session_cli" feedback-json 2>/dev/null || true)
    fi
    if printf '%s' "$candidate" | python3 -c 'import json,sys; value=json.load(sys.stdin); assert value.get("sessionAvailable") is True' 2>/dev/null; then
      authority_json="$candidate"
      break
    fi
  fi
done

metro_status=$(printf '%s' "$authority_json" | python3 -c '
import json,sys
value=json.load(sys.stdin)
if value.get("ownMetroBound"):
  print("session allocated and bound")
elif value.get("ownMetroAllocated"):
  print("session allocated, not bound")
else:
  print("no session allocation")
' 2>/dev/null || echo "authority unavailable")

# --- Collect recent telemetry (last 20 events, redacted) ---
# GH #266: the per-tool-call telemetry writer was removed with the Experience
# Engine (GH #200), so on current plugin versions these files stop updating.
# Cross-check the newest event's age against now and only ship events that are
# actually recent (<24h, e.g. a legacy plugin version still writing); report
# staleness explicitly instead of presenting weeks-old events as current.

recent_telemetry="[]"
telemetry_status="none"
if [ -d "$TELEMETRY_DIR" ]; then
  # `|| true`: an empty dir makes the unmatched glob fail `ls`, and under
  # `set -euo pipefail` that used to kill the WHOLE collector (zero JSON).
  latest_log=$(ls -t "$TELEMETRY_DIR"/*.jsonl 2>/dev/null | head -1 || true)
  if [ -n "$latest_log" ]; then
    age_days=$(python3 -c "import os,sys,time; print(int((time.time()-os.path.getmtime(sys.argv[1]))//86400))" "$latest_log" 2>/dev/null || echo "")
    # `-ge 0`: a future mtime (clock skew, fs restore) yields a negative age
    # and must not count as fresh.
    if [ -n "$age_days" ] && [ "$age_days" -ge 0 ] 2>/dev/null && [ "$age_days" -lt 1 ] 2>/dev/null; then
      telemetry_status="ok"
      raw=$(tail -20 "$latest_log" 2>/dev/null || echo "")
      if [ -n "$raw" ]; then
        recent_telemetry=$(redact "$raw")
      fi
    else
      case "$age_days" in
        ''|-*) age_label="unknown";;
        *) age_label="$age_days";;
      esac
      telemetry_status="stale (last event ${age_label} day(s) ago — telemetry capture is not active in this plugin version; it was removed with the Experience Engine, GH #200. Old events omitted.)"
    fi
  fi
fi

# --- Collect MCP tool count ---

tool_count="unknown"
if [ -f "$PLUGIN_ROOT/packages/rn-dev-agent-core/src/index.ts" ]; then
  tool_count=$(grep -c "trackedTool(" "$PLUGIN_ROOT/packages/rn-dev-agent-core/src/index.ts" 2>/dev/null || echo "unknown")
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
        if not isinstance(e, dict):
            continue
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
    'telemetry_status': sys.argv[14],
    'authority': json.loads(sys.argv[15]),
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
  "$cdp_log_tail" \
  "$telemetry_status" \
  "$authority_json"
