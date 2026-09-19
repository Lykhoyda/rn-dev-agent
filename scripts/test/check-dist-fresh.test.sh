#!/usr/bin/env bash
# Regression test for check-dist-fresh.sh — the CI gate that fails when the
# committed distributed plugin package is not a clean rebuild of src/. Core dist
# is generated and gitignored; both marketplaces run the ONE committed copy
# under packages/claude-plugin (GH #432, GH #622, GH #892).
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
# src/*.js into dist/supervisor.js, and the host "bundler" copies that into the
# distributed package plus the generated Codex adapters. Enough to exercise
# porcelain without tsc.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
BRIDGE="$tmp/packages/rn-dev-agent-core"
PLUGIN="$tmp/packages/claude-plugin"
HOST_RUNTIME="$PLUGIN/rn-dev-agent-core/dist"
HOST_PACKAGE="$PLUGIN/rn-dev-agent-core"
CODEX_AUTHORING="$tmp/packages/codex-plugin"
IOS_RUNNER="$tmp/packages/rn-fast-runner"
ANDROID_RUNNER="$tmp/packages/rn-android-runner"
FAKE_BIN="$tmp/fake-bin"
mkdir -p "$BRIDGE/src" "$BRIDGE/dist" "$HOST_RUNTIME" "$CODEX_AUTHORING/commands" "$IOS_RUNNER" "$ANDROID_RUNNER" "$FAKE_BIN"
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
HOST_BUILD='P=packages/claude-plugin && mkdir -p $P/rn-dev-agent-core/dist $P/scripts $P/codex-commands $P/bin && printf "%s\n" "{\"name\":\"rn-dev-agent-core\",\"version\":\"fixture\"}" > $P/rn-dev-agent-core/package.json && cp packages/rn-dev-agent-core/dist/supervisor.js $P/rn-dev-agent-core/dist/supervisor.js && cp $P/rn-dev-agent-core/dist/supervisor.js $P/rn-dev-agent-core/dist/index.js && cp $P/rn-dev-agent-core/dist/supervisor.js $P/rn-dev-agent-core/dist/learned-actions.js && cp runner-manifest.json $P/runner-manifest.json && rm -rf $P/scripts/rn-fast-runner $P/scripts/rn-android-runner $P/codex-commands && cp -R packages/rn-fast-runner $P/scripts/rn-fast-runner && cp -R packages/rn-android-runner $P/scripts/rn-android-runner && cp -R packages/codex-plugin/commands $P/codex-commands && printf "%s\n" "{\"type\":\"module\"}" > $P/bin/package.json'

write_host_outputs() {
  mkdir -p "$HOST_PACKAGE" "$HOST_RUNTIME" "$PLUGIN/scripts" "$PLUGIN/bin"
  printf '%s\n' '{"name":"rn-dev-agent-core","version":"fixture"}' > "$HOST_PACKAGE/package.json"
  cp "$BRIDGE/dist/supervisor.js" "$HOST_RUNTIME/supervisor.js"
  cp "$HOST_RUNTIME/supervisor.js" "$HOST_RUNTIME/index.js"
  cp "$HOST_RUNTIME/supervisor.js" "$HOST_RUNTIME/learned-actions.js"
  cp "$tmp/runner-manifest.json" "$PLUGIN/runner-manifest.json"
  rm -rf "$PLUGIN/scripts/rn-fast-runner" "$PLUGIN/scripts/rn-android-runner" "$PLUGIN/codex-commands"
  cp -R "$IOS_RUNNER" "$PLUGIN/scripts/rn-fast-runner"
  cp -R "$ANDROID_RUNNER" "$PLUGIN/scripts/rn-android-runner"
  cp -R "$CODEX_AUTHORING/commands" "$PLUGIN/codex-commands"
  printf '%s\n' '{"type":"module"}' > "$PLUGIN/bin/package.json"
}

run_guard() {
  REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" WEB_BUILD_CMD='true' \
    HOST_RUNTIME_BUILD_CMD="$HOST_BUILD" SKIP_PACK_CHECK=1 \
    bash "$GUARD"
}

run_pack_guard() {
  PATH="$FAKE_BIN:$PATH" PACK_HAS_SUPERVISOR="$1" \
    REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" WEB_BUILD_CMD='true' \
    HOST_RUNTIME_BUILD_CMD="$HOST_BUILD" bash "$GUARD"
}

commit_fresh() {
  git -C "$tmp" checkout -q -- .
  cp "$BRIDGE/src/a.js" "$BRIDGE/dist/supervisor.js"
  write_host_outputs
  git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "$1"
}

# 1. gitignored core dist + host outputs == clean rebuild -> passes
echo 'console.log(1);' > "$BRIDGE/src/a.js"
mkdir -p "$BRIDGE/dist"
cp "$BRIDGE/src/a.js" "$BRIDGE/dist/a.js"
cp "$BRIDGE/src/a.js" "$BRIDGE/dist/supervisor.js"
echo '{"version":"1"}' > "$tmp/runner-manifest.json"
echo 'ios runner v1' > "$IOS_RUNNER/runner.txt"
echo 'android runner v1' > "$ANDROID_RUNNER/runner.txt"
echo '# setup playbook v1' > "$CODEX_AUTHORING/commands/setup.md"
write_host_outputs
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm fresh
run_guard >/dev/null 2>&1
check "fresh distributed outputs pass without committed core dist" 0 $?

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

# 5. a second tracked host dist fails even when the canonical one is fresh
mkdir -p "$CODEX_AUTHORING/rn-dev-agent-core/dist"
cp "$BRIDGE/src/a.js" "$CODEX_AUTHORING/rn-dev-agent-core/dist/supervisor.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "second host dist"
run_guard >/dev/null 2>&1
check "second tracked host dist fails" 1 $?
git -C "$tmp" rm -r -q "packages/codex-plugin/rn-dev-agent-core"
git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "drop second host dist"

# 6. src changed, host runtime stale (' M') -> fails
echo 'console.log(2);' > "$BRIDGE/src/a.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "src change, no host rebuild"
run_guard >/dev/null 2>&1
check "stale host runtime fails" 1 $?
commit_fresh rebuilt

# 7. committed host orphan the build no longer emits (' D') -> fails
echo 'orphan' > "$HOST_RUNTIME/gone.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm orphan
run_guard >/dev/null 2>&1
check "committed host orphan fails" 1 $?
git -C "$tmp" rm -q "packages/claude-plugin/rn-dev-agent-core/dist/gone.js"
git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "drop orphan"

# 8. host build emits a file never committed ('??') -> fails
echo 'console.log(3);' > "$BRIDGE/src/b.js"
git -C "$tmp" add "$BRIDGE/src/b.js"
git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "new src, host extra not committed"
HOST_BUILD_EXTRA="$HOST_BUILD && echo extra > packages/claude-plugin/rn-dev-agent-core/dist/extra.js"
REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" WEB_BUILD_CMD='true' \
  HOST_RUNTIME_BUILD_CMD="$HOST_BUILD_EXTRA" SKIP_PACK_CHECK=1 \
  bash "$GUARD" >/dev/null 2>&1
check "emitted-but-uncommitted host file fails" 1 $?

# 9. gitignored extra file in core dist does not fail
rm -f "$HOST_RUNTIME/extra.js"
echo 'console.log(3);' > "$BRIDGE/src/b.js"
commit_fresh "host rebuilt with extra src"
run_guard >/dev/null 2>&1
check "gitignored extra core dist file does not fail" 0 $?

# 10. WEB_BUILD_CMD failure fails the gate
REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" WEB_BUILD_CMD='exit 7' \
  HOST_RUNTIME_BUILD_CMD="$HOST_BUILD" SKIP_PACK_CHECK=1 \
  bash "$GUARD" >/dev/null 2>&1
check "web build failure fails the gate" 7 $?

# 11. missing supervisor.js after build fails
REPO_ROOT="$tmp" DIST_BUILD_CMD='mkdir -p dist && echo hi > dist/only.js' WEB_BUILD_CMD='true' \
  HOST_RUNTIME_BUILD_CMD="$HOST_BUILD" SKIP_PACK_CHECK=1 \
  bash "$GUARD" >/dev/null 2>&1
check "missing supervisor.js fails" 1 $?

# 12. core dist is fresh/gitignored, but the packaged runtime is stale (' M') -> fails
echo 'stale runtime' > "$HOST_RUNTIME/supervisor.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "stale packaged runtime"
run_guard >/dev/null 2>&1
check "stale packaged runtime fails" 1 $?

# 13. root runner manifest changed, packaged copy stale (' M') -> fails
commit_fresh "fresh outputs before manifest drift"
echo '{"version":"2"}' > "$tmp/runner-manifest.json"
git -C "$tmp" add "$tmp/runner-manifest.json" && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "manifest changed only"
run_guard >/dev/null 2>&1
check "stale packaged runner manifest fails" 1 $?

# 14. native runner source changed, packaged copy stale (' M') -> fails
commit_fresh "fresh outputs before runner drift"
echo 'ios runner v2' > "$IOS_RUNNER/runner.txt"
git -C "$tmp" add "$IOS_RUNNER/runner.txt" && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "ios runner changed only"
run_guard >/dev/null 2>&1
check "stale packaged native runner copy fails" 1 $?

# 15. Codex authoring playbook changed, generated codex-commands copy stale (' M') -> fails
commit_fresh "fresh outputs before codex authoring drift"
echo '# setup playbook v2' > "$CODEX_AUTHORING/commands/setup.md"
git -C "$tmp" add "$CODEX_AUTHORING/commands/setup.md" && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "codex playbook changed only"
run_guard >/dev/null 2>&1
check "stale generated Codex adapter fails" 1 $?

# 16. generated Codex adapter deleted from the package (' D') -> fails
commit_fresh "fresh outputs before adapter removal"
git -C "$tmp" rm -q "packages/claude-plugin/codex-commands/setup.md"
git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "adapter removed"
run_guard >/dev/null 2>&1
check "missing generated Codex adapter fails" 1 $?

# 17. symlinked packaged runtime dist is refused before any wipe
commit_fresh "fresh outputs before symlink"
rm -rf "$HOST_RUNTIME"
mkdir -p "$tmp/elsewhere"
ln -s "$tmp/elsewhere" "$HOST_RUNTIME"
run_guard >/dev/null 2>&1
check "symlinked packaged runtime dist fails" 1 $?
rm -f "$HOST_RUNTIME"
commit_fresh "restore real dist"

exit $fail
