#!/usr/bin/env bash
# Regression test for check-dist-fresh.sh — the CI gate that fails when the
# committed core dist or Codex bundled runtime is not a clean rebuild of src/.
# Users run the COMMITTED artifacts; CI rebuilding before tests silently repairs
# a stale artifact in CI only (GH #432, audit 2026-07-03).
#
# Run: bash scripts/test/check-dist-fresh.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$SCRIPT_DIR/check-dist-fresh.sh"

fail=0
check() { # description expected_exit actual_exit
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 — expected exit $2, got $3"
    fail=1
  fi
}

# Fake repo: packages/rn-dev-agent-core/{src,dist}; the "compiler" copies
# src/*.js into dist/, and the Codex runtime "bundler" concatenates dist/*.js.
# That is enough to exercise stale/orphan/uncommitted porcelain states without
# a real tsc/esbuild.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
BRIDGE="$tmp/packages/rn-dev-agent-core"
CODEX_RUNTIME="$tmp/packages/codex-plugin/rn-dev-agent-core/dist"
mkdir -p "$BRIDGE/src" "$BRIDGE/dist" "$CODEX_RUNTIME"
git -C "$tmp" init -q
git -C "$tmp" config commit.gpgsign false
git -C "$tmp" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
BUILD='cp src/*.js dist/'
CODEX_BUILD='cat packages/rn-dev-agent-core/dist/*.js > packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js && cp packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js packages/codex-plugin/rn-dev-agent-core/dist/index.js && cp packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js packages/codex-plugin/rn-dev-agent-core/dist/learned-actions.js'

# 1. committed dist == clean rebuild -> passes
echo 'console.log(1);' > "$BRIDGE/src/a.js"
cp "$BRIDGE/src/a.js" "$BRIDGE/dist/a.js"
cat "$BRIDGE/dist/"*.js > "$CODEX_RUNTIME/supervisor.js"
cp "$CODEX_RUNTIME/supervisor.js" "$CODEX_RUNTIME/index.js"
cp "$CODEX_RUNTIME/supervisor.js" "$CODEX_RUNTIME/learned-actions.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm fresh
REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" CODEX_RUNTIME_BUILD_CMD="$CODEX_BUILD" bash "$GUARD" >/dev/null 2>&1
check "fresh dist passes" 0 $?

# 2. src changed, committed dist stale (' M') -> fails
echo 'console.log(2);' > "$BRIDGE/src/a.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "src change, no rebuild"
REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" CODEX_RUNTIME_BUILD_CMD="$CODEX_BUILD" bash "$GUARD" >/dev/null 2>&1
check "stale committed dist fails" 1 $?
git -C "$tmp" checkout -q -- . && cp "$BRIDGE/src/a.js" "$BRIDGE/dist/a.js" && cat "$BRIDGE/dist/"*.js > "$CODEX_RUNTIME/supervisor.js" && cp "$CODEX_RUNTIME/supervisor.js" "$CODEX_RUNTIME/index.js" && cp "$CODEX_RUNTIME/supervisor.js" "$CODEX_RUNTIME/learned-actions.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm rebuilt

# 3. committed orphan the build no longer emits (' D') -> fails
echo 'orphan' > "$BRIDGE/dist/gone.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm orphan
REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" CODEX_RUNTIME_BUILD_CMD="$CODEX_BUILD" bash "$GUARD" >/dev/null 2>&1
check "committed orphan fails" 1 $?
git -C "$tmp" rm -q "packages/rn-dev-agent-core/dist/gone.js"
git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "drop orphan"

# 4. build emits a file never committed ('??') -> fails
echo 'console.log(3);' > "$BRIDGE/src/b.js"
git -C "$tmp" add "$BRIDGE/src/b.js"
git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "new src, dist not committed"
REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" CODEX_RUNTIME_BUILD_CMD="$CODEX_BUILD" bash "$GUARD" >/dev/null 2>&1
check "emitted-but-uncommitted file fails" 1 $?

# 5. web-dist is preserved, not rebuilt, not flagged
mkdir -p "$BRIDGE/dist/observability/web-dist"
echo '<html>spa</html>' > "$BRIDGE/dist/observability/web-dist/index.html"
cp "$BRIDGE/src/b.js" "$BRIDGE/dist/b.js"
cat "$BRIDGE/dist/"*.js > "$CODEX_RUNTIME/supervisor.js"
cp "$CODEX_RUNTIME/supervisor.js" "$CODEX_RUNTIME/index.js"
cp "$CODEX_RUNTIME/supervisor.js" "$CODEX_RUNTIME/learned-actions.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "web-dist + fresh dist"
REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" CODEX_RUNTIME_BUILD_CMD="$CODEX_BUILD" bash "$GUARD" >/dev/null 2>&1
check "web-dist preserved and ignored" 0 $?
[ -f "$BRIDGE/dist/observability/web-dist/index.html" ]
check "web-dist file survives the clean-slate delete" 0 $?

# 6. core dist is fresh, but packaged Codex runtime is stale (' M') -> fails
echo 'stale runtime' > "$CODEX_RUNTIME/supervisor.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "stale codex runtime"
REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" CODEX_RUNTIME_BUILD_CMD="$CODEX_BUILD" bash "$GUARD" >/dev/null 2>&1
check "stale Codex runtime fails" 1 $?

exit $fail
