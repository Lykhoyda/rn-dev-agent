#!/usr/bin/env bash
# Regression test for check-web-bundle.sh — host SPA copies must match a rebuild.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$SCRIPT_DIR/check-web-bundle.sh"

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
mkdir -p \
  "$tmp/packages/rn-dev-agent-core/dist/observability/web-dist" \
  "$tmp/packages/claude-plugin/rn-dev-agent-core/dist/observability/web-dist" \
  "$tmp/packages/claude-plugin/rn-dev-agent-core/dist/web-dist" \
  "$tmp/packages/codex-plugin/rn-dev-agent-core/dist/observability/web-dist" \
  "$tmp/packages/codex-plugin/rn-dev-agent-core/dist/web-dist"

generated="$tmp/packages/rn-dev-agent-core/dist/observability/web-dist/index.html"
hosts=(
  packages/claude-plugin/rn-dev-agent-core/dist/observability/web-dist/index.html
  packages/claude-plugin/rn-dev-agent-core/dist/web-dist/index.html
  packages/codex-plugin/rn-dev-agent-core/dist/observability/web-dist/index.html
  packages/codex-plugin/rn-dev-agent-core/dist/web-dist/index.html
)

printf '%s\n' '<html>fresh</html>' > "$generated"
for rel in "${hosts[@]}"; do
  printf '%s\n' '<html>fresh</html>' > "$tmp/$rel"
done

REPO_ROOT="$tmp" WEB_BUILD_CMD='true' HOST_BUNDLES="${hosts[*]}" bash "$GUARD" >/dev/null
check "matching host SPA copies pass" 0 $?

printf '%s\n' '<html>stale</html>' > "$tmp/${hosts[0]}"
REPO_ROOT="$tmp" WEB_BUILD_CMD='true' HOST_BUNDLES="${hosts[*]}" bash "$GUARD" >/dev/null 2>&1
check "stale host SPA copy fails" 1 $?

printf '%s\n' '<html>fresh</html>' > "$tmp/${hosts[0]}"
rm -f "$tmp/${hosts[1]}"
REPO_ROOT="$tmp" WEB_BUILD_CMD='true' HOST_BUNDLES="${hosts[*]}" bash "$GUARD" >/dev/null 2>&1
check "missing host SPA copy fails" 1 $?

REPO_ROOT="$tmp" WEB_BUILD_CMD='true' GENERATED_BUNDLE="$tmp/missing.html" \
  HOST_BUNDLES="${hosts[*]}" bash "$GUARD" >/dev/null 2>&1
check "missing generated SPA fails" 1 $?

REPO_ROOT="$tmp" WEB_BUILD_CMD='exit 9' HOST_BUNDLES="${hosts[*]}" bash "$GUARD" >/dev/null 2>&1
check "web build failure fails the gate" 9 $?

exit $fail
