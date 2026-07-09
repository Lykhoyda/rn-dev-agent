#!/usr/bin/env bash
# CI gate: the committed compiled MCP server and packaged host runtimes must
# equal a CLEAN rebuild from src/. Users run the committed artifacts via host
# plugin MCP registrations; CI's rebuild-before-test silently repairs a stale
# artifact in CI while shipping it broken (GH #432, audit 2026-07-03).
# Clean-slate so all three drift shapes surface in porcelain:
#   ' M' stale committed file, '??' emitted-but-uncommitted, ' D' orphan.
# observability/web-dist/ is preserved — Vite output owned by
# check-web-bundle.sh (tsconfig excludes src/observability/web).
# The porcelain scope covers EVERY path scripts/build-host-runtimes.ts writes
# (both host packages) so no generator output can drift stale unnoticed.
# Env overrides (guard test): REPO_ROOT, DIST_BUILD_CMD, CODEX_RUNTIME_BUILD_CMD.
set -euo pipefail

ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BRIDGE="$ROOT/packages/rn-dev-agent-core"
DIST_REL="packages/rn-dev-agent-core/dist"
CODEX_RUNTIME_ROOT_REL="packages/codex-plugin/rn-dev-agent-core"
CODEX_RUNTIME="$ROOT/$CODEX_RUNTIME_ROOT_REL/dist"
CLAUDE_RUNTIME_ROOT_REL="packages/claude-plugin/rn-dev-agent-core"
CLAUDE_RUNTIME="$ROOT/$CLAUDE_RUNTIME_ROOT_REL/dist"
HOST_OUTPUT_RELS=(
  "$CODEX_RUNTIME_ROOT_REL"
  "$CLAUDE_RUNTIME_ROOT_REL"
  "packages/codex-plugin/runner-manifest.json"
  "packages/claude-plugin/runner-manifest.json"
  "packages/codex-plugin/CLAUDE-MD-TEMPLATE.md"
  "packages/claude-plugin/CLAUDE-MD-TEMPLATE.md"
  "packages/codex-plugin/scripts"
  "packages/claude-plugin/scripts"
)
# corepack yarn build (= tsc) fails closed; bare `npx tsc` would auto-install
# typescript@latest in non-interactive CI if resolution ever broke.
BUILD_CMD="${DIST_BUILD_CMD:-corepack yarn build}"
CODEX_RUNTIME_BUILD_CMD="${CODEX_RUNTIME_BUILD_CMD:-node scripts/build-host-runtimes.ts}"

find "$BRIDGE/dist" -mindepth 1 -maxdepth 1 ! -name observability -exec rm -rf {} +
if [ -d "$BRIDGE/dist/observability" ]; then
  find "$BRIDGE/dist/observability" -mindepth 1 -maxdepth 1 ! -name web-dist -exec rm -rf {} +
fi

( cd "$BRIDGE" && eval "$BUILD_CMD" )
for runtime in "$CODEX_RUNTIME" "$CLAUDE_RUNTIME"; do
  mkdir -p "$runtime"
  find "$runtime" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
done
( cd "$ROOT" && eval "$CODEX_RUNTIME_BUILD_CMD" )

STATUS="$(
  git -C "$ROOT" status --porcelain -- \
    "$DIST_REL" \
    "${HOST_OUTPUT_RELS[@]}"
)"
if [ -n "$STATUS" ]; then
  echo "ERROR: committed MCP artifacts and host package outputs are not a clean rebuild of src/."
  echo "$STATUS"
  echo "  ' M' = stale committed file, '??' = emitted but uncommitted, ' D' = orphan no longer emitted"
  echo "  Fix: corepack yarn workspace rn-dev-agent-core build && corepack yarn build:host-runtimes"
  echo "       git add $DIST_REL ${HOST_OUTPUT_RELS[*]}"
  exit 1
fi
echo "dist fresh"
