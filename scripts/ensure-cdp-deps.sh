#!/usr/bin/env bash
# ensure-cdp-deps.sh — Install CDP bridge node_modules if missing.
# Called from SessionStart hook so the MCP server can start without npm install at runtime.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDP_DIR="$SCRIPT_DIR/cdp-bridge"

if [ ! -d "$CDP_DIR/node_modules" ]; then
  cd "$CDP_DIR" && npm install --production --ignore-scripts --silent 2>/dev/null
fi
