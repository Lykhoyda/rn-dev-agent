#!/usr/bin/env bash
# Packaging contract (GH #622, GH #892): core dist is generated and untracked;
# exactly one host runtime stays committed under packages/claude-plugin for both
# marketplaces; gitignore must not leak into npm pack.
set -euo pipefail

ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CORE_DIST="packages/rn-dev-agent-core/dist"
HOST=packages/claude-plugin/rn-dev-agent-core/dist/supervisor.js

tracked="$(git -C "$ROOT" ls-files -- "$CORE_DIST")"
if [ -n "$tracked" ]; then
  echo "ERROR: $CORE_DIST must not be tracked:"
  printf '%s\n' "$tracked"
  exit 1
fi

if ! git -C "$ROOT" check-ignore -q "$CORE_DIST/supervisor.js"; then
  echo "ERROR: $CORE_DIST/supervisor.js is not gitignored"
  exit 1
fi

if [ -z "$(git -C "$ROOT" ls-files -- "$HOST")" ]; then
  echo "ERROR: marketplace host runtime is not tracked: $HOST"
  exit 1
fi

others="$(git -C "$ROOT" ls-files | grep -E '^packages/[^/]+/rn-dev-agent-core/dist/' | grep -v '^packages/claude-plugin/rn-dev-agent-core/dist/' || true)"
if [ -n "$others" ]; then
  echo "ERROR: a second host runtime is tracked; both hosts install packages/claude-plugin:"
  printf '%s\n' "$others"
  exit 1
fi

echo "core dist contract ok"
