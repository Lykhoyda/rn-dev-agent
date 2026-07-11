#!/usr/bin/env bash
# CI guard: the committed single-file observability SPA bundle must match a
# fresh rebuild from source. Catches a stale dist/observability/web-dist/index.html
# when src/observability/web/ changes without a rebuild.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/packages/rn-dev-agent-core/src/observability/web"
BUNDLE="packages/rn-dev-agent-core/dist/observability/web-dist/index.html"

# Deterministic rebuild: npm ci installs the lockfile-exact tree, so CI cannot
# drift the bundle via a newer in-range dep and false-fail every PR.
# Typecheck runs here because vite build only transpiles — without tsc the
# shared wire-types (server ↔ SPA, GH #438) would never actually gate drift.
( cd "$WEB" && npm ci --silent && npm run typecheck && npm run build >/dev/null 2>&1 )

if ! git -C "$ROOT" diff --quiet -- "$BUNDLE"; then
  echo "ERROR: committed SPA bundle is stale."
  echo "  $BUNDLE does not match a fresh rebuild of src/observability/web/."
  echo "  Fix: corepack yarn workspace rn-dev-agent-core build:web && git add $BUNDLE"
  git -C "$ROOT" --no-pager diff --stat -- "$BUNDLE" || true
  exit 1
fi
echo "web bundle fresh"
