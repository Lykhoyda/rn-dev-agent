#!/usr/bin/env bash
# reload-mcp.sh — Send SIGUSR1 to the CDP bridge wrapper to trigger a hot-reload.
# The wrapper kills the running node process and restarts it with the latest dist.
# Usage: bash scripts/reload-mcp.sh

PID_FILE="${TMPDIR:-/tmp}/rn-dev-agent-cdp-bridge.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "No CDP bridge PID file found at $PID_FILE — is the MCP server running?" >&2
  exit 1
fi

WRAPPER_PID=$(cat "$PID_FILE")

if ! kill -0 "$WRAPPER_PID" 2>/dev/null; then
  echo "CDP bridge wrapper (PID $WRAPPER_PID) is not running. Stale PID file." >&2
  rm -f "$PID_FILE"
  exit 1
fi

kill -USR1 "$WRAPPER_PID"
echo "Sent SIGUSR1 to CDP bridge wrapper (PID $WRAPPER_PID). Server will restart in ~1s."
