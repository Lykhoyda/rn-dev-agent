#!/usr/bin/env bash
# Regression test for check-dist-fresh.sh — the CI gate that fails when a
# committed host runtime is not a clean rebuild of src/. Core dist is generated
# and gitignored; marketplace users run the committed HOST copies
# (GH #432, GH #622).
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
# src/*.js into dist/supervisor.js, and the Codex runtime "bundler" copies
# that into the host package. Enough to exercise host porcelain without tsc.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
BRIDGE="$tmp/packages/rn-dev-agent-core"
CODEX_RUNTIME="$tmp/packages/codex-plugin/rn-dev-agent-core/dist"
CODEX_PACKAGE="$tmp/packages/codex-plugin/rn-dev-agent-core"
CODEX_PLUGIN="$tmp/packages/codex-plugin"
IOS_RUNNER="$tmp/packages/rn-fast-runner"
ANDROID_RUNNER="$tmp/packages/rn-android-runner"
FAKE_BIN="$tmp/fake-bin"
mkdir -p "$BRIDGE/src" "$BRIDGE/dist" "$CODEX_RUNTIME" "$IOS_RUNNER" "$ANDROID_RUNNER" "$FAKE_BIN"
git -C "$tmp" init -q
git -C "$tmp" config commit.gpgsign false
git -C "$tmp" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
printf '%s\n' 'packages/rn-dev-agent-core/dist/' > "$tmp/.gitignore"
printf '%s\n' '{"name":"fixture","version":"1.0.0"}' > "$BRIDGE/package.json"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '\''[{"files":['\''' \
  'if [ "${PACK_HAS_SUPERVISOR:-1}" = 1 ]; then' \
  '  printf '\''{"path":"dist/supervisor.js"}'\''' \
  'else' \
  '  printf '\''{"path":"dist/not-supervisor.js"}'\''' \
  'fi' \
  'for i in $(seq 1 20000); do' \
  '  printf '\'',{"path":"zzzz/generated-file-%05d.js"}'\'' "$i"' \
  'done' \
  'printf '\'']}]\n'\''' \
  > "$FAKE_BIN/npm"
chmod +x "$FAKE_BIN/npm"
BUILD='mkdir -p dist && cp src/*.js dist/ && cp src/a.js dist/supervisor.js'
CODEX_BUILD='mkdir -p packages/codex-plugin/rn-dev-agent-core/dist packages/codex-plugin/scripts && printf "%s\n" "{\"version\":\"fixture\"}" > packages/codex-plugin/rn-dev-agent-core/package.json && cp packages/rn-dev-agent-core/dist/supervisor.js packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js && cp packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js packages/codex-plugin/rn-dev-agent-core/dist/index.js && cp packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js packages/codex-plugin/rn-dev-agent-core/dist/learned-actions.js && cp runner-manifest.json packages/codex-plugin/runner-manifest.json && rm -rf packages/codex-plugin/scripts/rn-fast-runner packages/codex-plugin/scripts/rn-android-runner && cp -R packages/rn-fast-runner packages/codex-plugin/scripts/rn-fast-runner && cp -R packages/rn-android-runner packages/codex-plugin/scripts/rn-android-runner'

write_codex_outputs() {
  mkdir -p "$CODEX_PACKAGE" "$CODEX_RUNTIME" "$CODEX_PLUGIN/scripts"
  printf '%s\n' '{"version":"fixture"}' > "$CODEX_PACKAGE/package.json"
  cp "$BRIDGE/dist/supervisor.js" "$CODEX_RUNTIME/supervisor.js"
  cp "$CODEX_RUNTIME/supervisor.js" "$CODEX_RUNTIME/index.js"
  cp "$CODEX_RUNTIME/supervisor.js" "$CODEX_RUNTIME/learned-actions.js"
  cp "$tmp/runner-manifest.json" "$CODEX_PLUGIN/runner-manifest.json"
  rm -rf "$CODEX_PLUGIN/scripts/rn-fast-runner" "$CODEX_PLUGIN/scripts/rn-android-runner"
  cp -R "$IOS_RUNNER" "$CODEX_PLUGIN/scripts/rn-fast-runner"
  cp -R "$ANDROID_RUNNER" "$CODEX_PLUGIN/scripts/rn-android-runner"
}

run_guard() {
  REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" WEB_BUILD_CMD='true' \
    CODEX_RUNTIME_BUILD_CMD="$CODEX_BUILD" SKIP_PACK_CHECK=1 \
    bash "$GUARD"
}

run_pack_guard() {
  PATH="$FAKE_BIN:$PATH" PACK_HAS_SUPERVISOR="$1" \
    REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" WEB_BUILD_CMD='true' \
    CODEX_RUNTIME_BUILD_CMD="$CODEX_BUILD" bash "$GUARD"
}

# 1. gitignored core dist + host outputs == clean rebuild -> passes
echo 'console.log(1);' > "$BRIDGE/src/a.js"
mkdir -p "$BRIDGE/dist"
cp "$BRIDGE/src/a.js" "$BRIDGE/dist/a.js"
cp "$BRIDGE/src/a.js" "$BRIDGE/dist/supervisor.js"
echo '{"version":"1"}' > "$tmp/runner-manifest.json"
echo 'ios runner v1' > "$IOS_RUNNER/runner.txt"
echo 'android runner v1' > "$ANDROID_RUNNER/runner.txt"
write_codex_outputs
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm fresh
run_guard >/dev/null 2>&1
check "fresh host outputs pass without committed core dist" 0 $?

# 2. A large npm manifest containing supervisor.js passes without a pipefail false negative.
run_pack_guard 1 >/dev/null 2>&1
check "large package manifest containing supervisor passes" 0 $?

# 3. A large npm manifest missing supervisor.js still fails.
run_pack_guard 0 >/dev/null 2>&1
check "large package manifest missing supervisor fails" 1 $?

# 4. tracked core dist fails even when rebuild matches
mkdir -p "$BRIDGE/dist"
cp "$BRIDGE/src/a.js" "$BRIDGE/dist/supervisor.js"
git -C "$tmp" add -f "$BRIDGE/dist/supervisor.js"
git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "tracked core dist"
run_guard >/dev/null 2>&1
check "tracked core dist fails" 1 $?
git -C "$tmp" rm -q --cached -- "packages/rn-dev-agent-core/dist/supervisor.js"
git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "untrack core dist"

# 5. src changed, host runtime stale (' M') -> fails
echo 'console.log(2);' > "$BRIDGE/src/a.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "src change, no host rebuild"
run_guard >/dev/null 2>&1
check "stale host runtime fails" 1 $?
git -C "$tmp" checkout -q -- .
cp "$BRIDGE/src/a.js" "$BRIDGE/dist/a.js"
cp "$BRIDGE/src/a.js" "$BRIDGE/dist/supervisor.js"
write_codex_outputs
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm rebuilt

# 6. committed host orphan the build no longer emits (' D') -> fails
echo 'orphan' > "$CODEX_RUNTIME/gone.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm orphan
run_guard >/dev/null 2>&1
check "committed host orphan fails" 1 $?
git -C "$tmp" rm -q "packages/codex-plugin/rn-dev-agent-core/dist/gone.js"
git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "drop orphan"

# 7. host build emits a file never committed ('??') -> fails
echo 'console.log(3);' > "$BRIDGE/src/b.js"
git -C "$tmp" add "$BRIDGE/src/b.js"
git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "new src, host extra not committed"
# Force the fake bundler to also emit an uncommitted extra file.
CODEX_BUILD_EXTRA="$CODEX_BUILD && echo extra > packages/codex-plugin/rn-dev-agent-core/dist/extra.js"
REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" WEB_BUILD_CMD='true' \
  CODEX_RUNTIME_BUILD_CMD="$CODEX_BUILD_EXTRA" SKIP_PACK_CHECK=1 \
  bash "$GUARD" >/dev/null 2>&1
check "emitted-but-uncommitted host file fails" 1 $?

# 8. gitignored extra file in core dist does not fail
rm -f "$CODEX_RUNTIME/extra.js"
echo 'console.log(3);' > "$BRIDGE/src/b.js"
cp "$BRIDGE/src/a.js" "$BRIDGE/dist/supervisor.js"
write_codex_outputs
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "host rebuilt with extra src"
run_guard >/dev/null 2>&1
check "gitignored extra core dist file does not fail" 0 $?

# 9. WEB_BUILD_CMD failure fails the gate
REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" WEB_BUILD_CMD='exit 7' \
  CODEX_RUNTIME_BUILD_CMD="$CODEX_BUILD" SKIP_PACK_CHECK=1 \
  bash "$GUARD" >/dev/null 2>&1
check "web build failure fails the gate" 7 $?

# 10. missing supervisor.js after build fails
REPO_ROOT="$tmp" DIST_BUILD_CMD='mkdir -p dist && echo hi > dist/only.js' WEB_BUILD_CMD='true' \
  CODEX_RUNTIME_BUILD_CMD="$CODEX_BUILD" SKIP_PACK_CHECK=1 \
  bash "$GUARD" >/dev/null 2>&1
check "missing supervisor.js fails" 1 $?

# 11. core dist is fresh/gitignored, but packaged Codex runtime is stale (' M') -> fails
echo 'stale runtime' > "$CODEX_RUNTIME/supervisor.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "stale codex runtime"
run_guard >/dev/null 2>&1
check "stale Codex runtime fails" 1 $?

# 12. root runner manifest changed, packaged Codex copy stale (' M') -> fails
git -C "$tmp" checkout -q -- .
cp "$BRIDGE/src/a.js" "$BRIDGE/dist/supervisor.js"
write_codex_outputs
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "fresh codex outputs before manifest drift"
echo '{"version":"2"}' > "$tmp/runner-manifest.json"
git -C "$tmp" add "$tmp/runner-manifest.json" && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "manifest changed only"
run_guard >/dev/null 2>&1
check "stale Codex runner manifest fails" 1 $?

# 13. native runner source changed, packaged Codex copy stale (' M') -> fails
git -C "$tmp" checkout -q -- .
cp "$BRIDGE/src/a.js" "$BRIDGE/dist/supervisor.js"
write_codex_outputs
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "fresh codex outputs before runner drift"
echo 'ios runner v2' > "$IOS_RUNNER/runner.txt"
git -C "$tmp" add "$IOS_RUNNER/runner.txt" && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "ios runner changed only"
run_guard >/dev/null 2>&1
check "stale Codex native runner copy fails" 1 $?

exit $fail
