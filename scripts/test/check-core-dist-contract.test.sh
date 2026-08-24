#!/usr/bin/env bash
# Regression test for check-core-dist-contract.sh.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$SCRIPT_DIR/check-core-dist-contract.sh"

fail=0
check() {
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 — expected exit $2, got $3"
    fail=1
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git -C "$tmp" init -q
git -C "$tmp" config commit.gpgsign false
mkdir -p \
  "$tmp/packages/claude-plugin/rn-dev-agent-core/dist" \
  "$tmp/packages/codex-plugin/rn-dev-agent-core/dist"
printf '%s\n' 'packages/rn-dev-agent-core/dist/' > "$tmp/.gitignore"
printf '%s\n' 'host' > "$tmp/packages/claude-plugin/rn-dev-agent-core/dist/supervisor.js"
printf '%s\n' 'host' > "$tmp/packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js"
git -C "$tmp" add -A
git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm fresh

REPO_ROOT="$tmp" bash "$GUARD" >/dev/null
check "gitignored core dist plus tracked hosts passes" 0 $?

mkdir -p "$tmp/packages/rn-dev-agent-core/dist"
printf '%s\n' 'core' > "$tmp/packages/rn-dev-agent-core/dist/supervisor.js"
git -C "$tmp" add -f "$tmp/packages/rn-dev-agent-core/dist/supervisor.js"
git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm tracked
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "tracked core dist fails" 1 $?

git -C "$tmp" rm -q --cached -- packages/rn-dev-agent-core/dist/supervisor.js
printf '%s\n' '# no dist ignore' > "$tmp/.gitignore"
git -C "$tmp" add .gitignore
git -C "$tmp" rm -q --cached -- packages/claude-plugin/rn-dev-agent-core/dist/supervisor.js \
  packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js
git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "drop ignore and hosts"
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "missing gitignore and host tracking fails" 1 $?

exit $fail
