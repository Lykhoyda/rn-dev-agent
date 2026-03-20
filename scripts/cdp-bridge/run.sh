#!/usr/bin/env bash
# Auto-restart wrapper for the CDP bridge MCP server.
# Restarts on non-zero exit (crash), stops on exit 0 (clean SIGTERM).
# Max 5 restarts within a 60s window to prevent infinite crash loops.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SCRIPT="$SCRIPT_DIR/dist/index.js"

if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  cd "$SCRIPT_DIR" && npm install --production --silent 2>/dev/null
fi

trap 'exit 0' SIGINT

MAX_RESTARTS=5
CRASH_WINDOW_SECS=60
STABLE_RUN_SECS=30

crash_count=0
window_start=$(date +%s)

while true; do
  run_start=$(date +%s)

  exit_code=0
  node "$NODE_SCRIPT" || exit_code=$?

  if [ "$exit_code" -eq 0 ]; then
    exit 0
  fi

  run_duration=$(( $(date +%s) - run_start ))

  if [ "$run_duration" -ge "$STABLE_RUN_SECS" ]; then
    crash_count=0
    window_start=$(date +%s)
  fi

  elapsed=$(( $(date +%s) - window_start ))
  if [ "$elapsed" -gt "$CRASH_WINDOW_SECS" ]; then
    crash_count=0
    window_start=$(date +%s)
  fi

  crash_count=$((crash_count + 1))

  if [ "$crash_count" -gt "$MAX_RESTARTS" ]; then
    echo "CDP bridge: exceeded $MAX_RESTARTS restarts within ${CRASH_WINDOW_SECS}s — giving up" >&2
    exit 1
  fi

  echo "CDP bridge: exited with code $exit_code, restart $crash_count/$MAX_RESTARTS in 2s..." >&2
  sleep 2
done
