#!/usr/bin/env bash
# Packaging contract (GH #622): core dist is generated and untracked; host
# plugin runtimes stay committed for marketplace installs; gitignore must not
# leak into npm pack.
set -euo pipefail

ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CORE_DIST="packages/rn-dev-agent-core/dist"
HOSTS=(
  packages/claude-plugin/rn-dev-agent-core/dist/supervisor.js
  packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js
)

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

for host in "${HOSTS[@]}"; do
  if [ -z "$(git -C "$ROOT" ls-files -- "$host")" ]; then
    echo "ERROR: marketplace host runtime is not tracked: $host"
    exit 1
  fi
done

echo "core dist contract ok"
