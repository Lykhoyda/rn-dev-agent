#!/usr/bin/env bash
# CI gate: the committed distributed plugin package must equal a CLEAN rebuild
# from src/. packages/rn-dev-agent-core/dist/ is a local/CI/npm-pack build
# product and must not be committed. Both marketplaces install the ONE committed
# runtime under packages/claude-plugin/rn-dev-agent-core/dist/ plus the Codex
# adapters generated next to it; no other host dist may be tracked.
# Clean-slate so drift shapes surface in porcelain:
#   ' M' stale committed file, '??' emitted-but-uncommitted, ' D' orphan.
# Core dist is wiped and regenerated (tsc + SPA + native copy) as the input to
# scripts/build-host-runtimes.ts; it is gitignored, so it never appears in porcelain.
# The porcelain scope covers EVERY path scripts/build-host-runtimes.ts writes
# so no generator output can drift stale unnoticed.
# Env overrides (guard test): REPO_ROOT, DIST_BUILD_CMD, WEB_BUILD_CMD,
# HOST_RUNTIME_BUILD_CMD, SKIP_PACK_CHECK.
set -euo pipefail

ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BRIDGE="$ROOT/packages/rn-dev-agent-core"
DIST_REL="packages/rn-dev-agent-core/dist"
PLUGIN_REL="packages/claude-plugin"
HOST_RUNTIME_ROOT_REL="$PLUGIN_REL/rn-dev-agent-core"
HOST_RUNTIME="$ROOT/$HOST_RUNTIME_ROOT_REL/dist"
HOST_OUTPUT_RELS=(
  "$HOST_RUNTIME_ROOT_REL"
  "$PLUGIN_REL/runner-manifest.json"
  "$PLUGIN_REL/CLAUDE-MD-TEMPLATE.md"
  "$PLUGIN_REL/AGENTS-MD-TEMPLATE.md"
  "$PLUGIN_REL/scripts"
  "$PLUGIN_REL/bin"
  "$PLUGIN_REL/.codex-plugin"
  "$PLUGIN_REL/codex.mcp.json"
  "$PLUGIN_REL/codex-skills"
  "$PLUGIN_REL/codex-commands"
  "$PLUGIN_REL/codex-agents"
  "$PLUGIN_REL/codex-templates"
)
# corepack yarn build (= tsc + native copy) fails closed; bare `npx tsc` would
# auto-install typescript@latest in non-interactive CI if resolution ever broke.
BUILD_CMD="${DIST_BUILD_CMD:-corepack yarn build}"
WEB_BUILD_CMD="${WEB_BUILD_CMD:-corepack yarn build:web}"
HOST_RUNTIME_BUILD_CMD="${HOST_RUNTIME_BUILD_CMD:-node scripts/build-host-runtimes.ts}"

tracked_core="$(git -C "$ROOT" ls-files -- "$DIST_REL")"
if [ -n "$tracked_core" ]; then
  echo "ERROR: $DIST_REL is generated and must not be committed."
  echo "$tracked_core"
  echo "  Fix: git rm -r --cached $DIST_REL"
  exit 1
fi

second_dist="$(git -C "$ROOT" ls-files | grep -E '^packages/[^/]+/rn-dev-agent-core/dist/' | grep -v "^$HOST_RUNTIME_ROOT_REL/dist/" || true)"
if [ -n "$second_dist" ]; then
  echo "ERROR: only $HOST_RUNTIME_ROOT_REL/dist may carry a committed host runtime."
  echo "$second_dist"
  echo "  Fix: git rm -r --cached <path>; both hosts install $PLUGIN_REL"
  exit 1
fi

rm -rf "$BRIDGE/dist"

( cd "$BRIDGE" && eval "$BUILD_CMD" )
( cd "$BRIDGE" && eval "$WEB_BUILD_CMD" )

if [ ! -f "$BRIDGE/dist/supervisor.js" ]; then
  echo "ERROR: core build did not emit dist/supervisor.js"
  echo "  Fix: $BUILD_CMD (cwd packages/rn-dev-agent-core)"
  exit 1
fi

if [ -L "$HOST_RUNTIME" ]; then
  echo "ERROR: $HOST_RUNTIME_ROOT_REL/dist must be a real directory, not a symlink"
  exit 1
fi
mkdir -p "$HOST_RUNTIME"
find "$HOST_RUNTIME" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
( cd "$ROOT" && eval "$HOST_RUNTIME_BUILD_CMD" )

STATUS="$(
  git -C "$ROOT" status --porcelain -- \
    "${HOST_OUTPUT_RELS[@]}"
)"
if [ -n "$STATUS" ]; then
  echo "ERROR: committed plugin package outputs are not a clean rebuild of src/."
  echo "$STATUS"
  echo "  ' M' = stale committed file, '??' = emitted but uncommitted, ' D' = orphan no longer emitted"
  echo "  Fix: corepack yarn build:host-runtimes"
  echo "       git add ${HOST_OUTPUT_RELS[*]}"
  exit 1
fi

if [ "${SKIP_PACK_CHECK:-}" != 1 ] && [ -f "$BRIDGE/package.json" ] && command -v npm >/dev/null; then
  pack_paths="$(
    cd "$BRIDGE"
    npm pack --dry-run --ignore-scripts --json 2>/dev/null \
      | python3 -c 'import json,sys
payload=json.load(sys.stdin)
files=payload[0]["files"] if isinstance(payload, list) else payload["files"]
print("\n".join(entry["path"] for entry in files))'
  )"
  if ! grep -qx 'dist/supervisor.js' <<< "$pack_paths"; then
    echo "ERROR: npm pack does not include dist/supervisor.js (gitignore must not apply to the tarball)."
    sed -n '1,10p' <<< "$pack_paths"
    exit 1
  fi
fi

echo "dist fresh"
