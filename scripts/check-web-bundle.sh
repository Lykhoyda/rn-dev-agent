#!/usr/bin/env bash
# CI guard: the committed single-file observability SPA bundle must match a
# fresh rebuild from source. Catches a stale dist/observability/web-dist/index.html
# when src/observability/web/ changes without a rebuild (Gemini 4).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/scripts/cdp-bridge/src/observability/web"
BUNDLE="scripts/cdp-bridge/dist/observability/web-dist/index.html"

# Deterministic rebuild: npm ci installs the lockfile-exact tree, so CI cannot
# drift the bundle via a newer in-range dep and false-fail every PR.
( cd "$WEB" && npm ci --silent && npm run build >/dev/null 2>&1 )

if ! git -C "$ROOT" diff --quiet -- "$BUNDLE"; then
  echo "ERROR: committed SPA bundle is stale."
  echo "  $BUNDLE does not match a fresh rebuild of src/observability/web/."
  echo "  Fix: (cd scripts/cdp-bridge && npm run build:web) && git add $BUNDLE"
  git -C "$ROOT" --no-pager diff --stat -- "$BUNDLE" || true
  exit 1
fi
echo "web bundle fresh"
