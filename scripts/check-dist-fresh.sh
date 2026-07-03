#!/usr/bin/env bash
# CI gate: the committed compiled MCP server (scripts/cdp-bridge/dist/) must
# equal a CLEAN rebuild from src/. Users run the committed dist via
# plugin.json mcpServers.cdp; CI's rebuild-before-test silently repairs a
# stale artifact in CI while shipping it broken (GH #432, audit 2026-07-03).
# Clean-slate so all three drift shapes surface in porcelain:
#   ' M' stale committed file, '??' emitted-but-uncommitted, ' D' orphan.
# observability/web-dist/ is preserved — Vite output owned by
# check-web-bundle.sh (tsconfig excludes src/observability/web).
# Env overrides (guard test): REPO_ROOT, DIST_BUILD_CMD.
set -euo pipefail

ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BRIDGE="$ROOT/scripts/cdp-bridge"
DIST_REL="scripts/cdp-bridge/dist"
# npm run build (= tsc) fails closed; bare `npx tsc` would auto-install
# typescript@latest in non-interactive CI if resolution ever broke.
BUILD_CMD="${DIST_BUILD_CMD:-npm run build}"

find "$BRIDGE/dist" -mindepth 1 -maxdepth 1 ! -name observability -exec rm -rf {} +
if [ -d "$BRIDGE/dist/observability" ]; then
  find "$BRIDGE/dist/observability" -mindepth 1 -maxdepth 1 ! -name web-dist -exec rm -rf {} +
fi

( cd "$BRIDGE" && eval "$BUILD_CMD" )

STATUS="$(git -C "$ROOT" status --porcelain -- "$DIST_REL")"
if [ -n "$STATUS" ]; then
  echo "ERROR: committed $DIST_REL is not a clean rebuild of src/."
  echo "$STATUS"
  echo "  ' M' = stale committed file, '??' = emitted but uncommitted, ' D' = orphan no longer emitted"
  echo "  Fix: (cd scripts/cdp-bridge && npm run build) && git add $DIST_REL"
  exit 1
fi
echo "dist fresh"
