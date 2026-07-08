#!/bin/bash
# subagent-start.sh — SubagentStart hook (D555)
# Injects CDP connection status when subagents spawn.
# Exit codes: 0 = success (output shown to agent), 1 = error (logged, non-blocking),
#             2 = block operation (not used here).

CDP_ACTIVE_FLAG="${TMPDIR:-/tmp}/rn-dev-agent-cdp-active"
CDP_SESSION_FILE="${TMPDIR:-/tmp}/rn-dev-agent-cdp-session.json"

# Only output if the plugin has an active CDP session
if [ ! -f "$CDP_ACTIVE_FLAG" ]; then
  exit 0
fi

# Check staleness (30 min)
flag_age=0
if [ "$(uname)" = "Darwin" ]; then
  flag_mtime=$(stat -f '%m' "$CDP_ACTIVE_FLAG" 2>/dev/null || echo 0)
  now=$(date +%s)
  flag_age=$(( now - flag_mtime ))
else
  flag_age=$(( $(date +%s) - $(stat -c '%Y' "$CDP_ACTIVE_FLAG" 2>/dev/null || echo 0) ))
fi

if [ "$flag_age" -gt 1800 ]; then
  exit 0
fi

# Read CDP session info if available
platform="unknown"
port="unknown"
if [ -f "$CDP_SESSION_FILE" ]; then
  platform=$(jq -r '.platform // "unknown"' "$CDP_SESSION_FILE" 2>/dev/null || echo "unknown")
  port=$(jq -r '.port // "unknown"' "$CDP_SESSION_FILE" 2>/dev/null || echo "unknown")
fi

cat <<EOF
CDP bridge is connected (platform: ${platform}, port: ${port}). MCP tools (cdp_*, device_*) are available.
EOF
