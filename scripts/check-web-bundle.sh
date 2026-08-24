#!/usr/bin/env bash
# CI guard: committed HOST observability SPA bundles must match a fresh rebuild
# of src/observability/web/. Core dist/observability/web-dist is generated and
# untracked; marketplace installs serve the host-package copies.
set -euo pipefail

ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
WEB="${WEB_DIR:-$ROOT/packages/rn-dev-agent-core/src/observability/web}"
GENERATED="${GENERATED_BUNDLE:-$ROOT/packages/rn-dev-agent-core/dist/observability/web-dist/index.html}"
DEFAULT_HOST_BUNDLES=(
  packages/claude-plugin/rn-dev-agent-core/dist/observability/web-dist/index.html
  packages/claude-plugin/rn-dev-agent-core/dist/web-dist/index.html
  packages/codex-plugin/rn-dev-agent-core/dist/observability/web-dist/index.html
  packages/codex-plugin/rn-dev-agent-core/dist/web-dist/index.html
)
WEB_BUILD_CMD="${WEB_BUILD_CMD:-}"

if [ -n "$WEB_BUILD_CMD" ]; then
  eval "$WEB_BUILD_CMD"
else
  # Deterministic rebuild: npm ci installs the lockfile-exact tree.
  # Typecheck runs here because vite build only transpiles — without tsc the
  # shared wire-types (server ↔ SPA, GH #438) would never actually gate drift.
  ( cd "$WEB" && npm ci --silent && npm run typecheck && npm run build >/dev/null 2>&1 )
fi

if [ ! -f "$GENERATED" ]; then
  echo "ERROR: SPA rebuild did not emit $GENERATED"
  echo "  Fix: corepack yarn workspace rn-dev-agent-core build:web"
  exit 1
fi

status=0
if [ -n "${HOST_BUNDLES:-}" ]; then
  # shellcheck disable=SC2206
  host_rels=($HOST_BUNDLES)
else
  host_rels=("${DEFAULT_HOST_BUNDLES[@]}")
fi

for rel in "${host_rels[@]}"; do
  host="$ROOT/$rel"
  if [ ! -f "$host" ]; then
    echo "ERROR: missing committed host SPA bundle: $rel"
    status=1
    continue
  fi
  if ! cmp -s "$GENERATED" "$host"; then
    echo "ERROR: committed host SPA bundle is stale: $rel"
    echo "  $GENERATED does not match $rel"
    echo "  Fix: corepack yarn workspace rn-dev-agent-core build:web && corepack yarn build:host-runtimes"
    echo "       git add $rel"
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  exit 1
fi
echo "web bundle fresh"
