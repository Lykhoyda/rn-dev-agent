#!/usr/bin/env bash
# Regression test for SessionStart safety.
# GH#252/B196 — SessionStart must be bounded: without an explicit hook timeout
# and curl time limits, a stalled CDN blocks every session start.
# GH#773 — SessionStart must not fetch the runner over the network at all; the
# explicit install is a user-run command.
#
# Run: bash scripts/test/session-start-bounded.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail=0
ok() { echo "ok: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

# 1. Every SessionStart hook entry declares an explicit timeout.
if python3 - "$REPO_ROOT/packages/claude-plugin/hooks/hooks.json" << 'EOF'
import json, sys
h = json.load(open(sys.argv[1]))["hooks"]
entries = [hh for e in h.get("SessionStart", []) for hh in e["hooks"]]
sys.exit(0 if entries and all(isinstance(hh.get("timeout"), (int, float)) and hh["timeout"] > 0 for hh in entries) else 1)
EOF
then ok "hooks.json: SessionStart entries declare a timeout"
else bad "hooks.json: SessionStart entry missing an explicit timeout"; fi

# 2. Execute the network installer with a curl test double and inspect the
# arguments passed across that executable boundary.
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM
mkdir -p "$TEST_DIR/bin"
cat > "$TEST_DIR/bin/curl" << 'EOF'
#!/usr/bin/env bash
printf '%s\0' "$@" > "$CURL_ARGS_FILE"
exit 28
EOF
chmod +x "$TEST_DIR/bin/curl"

if PATH="$TEST_DIR/bin:$PATH" \
  CURL_ARGS_FILE="$TEST_DIR/curl-args" \
  RN_DEV_AGENT_RUNNER_CACHE="$TEST_DIR/cache" \
  RN_DEV_AGENT_UNAME_S=Darwin \
  RN_DEV_AGENT_UNAME_M=arm64 \
  RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL=https://example.invalid/maestro-runner.tar.gz \
  bash "$REPO_ROOT/scripts/ensure-maestro-runner.sh" > "$TEST_DIR/output" 2>&1
then
  bad "ensure-maestro-runner.sh: expected the simulated download to fail"
fi

if python3 - "$TEST_DIR/curl-args" << 'EOF'
from pathlib import Path
import sys

args = [arg.decode() for arg in Path(sys.argv[1]).read_bytes().split(b"\0") if arg]

def positive_timeout(name):
    if name in args:
        index = args.index(name)
        value = args[index + 1] if index + 1 < len(args) else ""
    else:
        prefix = f"{name}="
        value = next((arg[len(prefix):] for arg in args if arg.startswith(prefix)), "")
    try:
        return float(value) > 0
    except ValueError:
        return False

download_url = "https://example.invalid/maestro-runner.tar.gz"
sys.exit(
    0
    if download_url in args
    and positive_timeout("--connect-timeout")
    and positive_timeout("--max-time")
    else 1
)
EOF
then
  ok "ensure-maestro-runner.sh: download uses positive connect and total timeouts"
else
  bad "ensure-maestro-runner.sh: download is not bounded by positive connect and total timeouts"
fi

# 3. GH#773 — SessionStart must not fetch the runner over the network. The hook
# verifies the pin-cache; downloading is an explicit user-run command.
PROJECT="$TEST_DIR/rn-project"
mkdir -p "$PROJECT"
echo '{"name":"fixture","dependencies":{"expo":"51.0.0","react-native":"0.74.0"}}' > "$PROJECT/package.json"
echo '{"expo":{"name":"fixture"}}' > "$PROJECT/app.json"

# curl/wget are the fetchers the runner installer uses; any call fails the test.
for tool in curl wget; do
  cat > "$TEST_DIR/bin/$tool" << 'EOF'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >> "$NET_LOG"
exit 28
EOF
  chmod +x "$TEST_DIR/bin/$tool"
done
# npm/brew get their own log rather than a silent stub: SessionStart already
# runs them for CDP deps and ffmpeg, so they must stay visible here without
# failing this runner-scoped assertion.
for tool in npm brew; do
  cat > "$TEST_DIR/bin/$tool" << 'EOF'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >> "$PKG_LOG"
exit 1
EOF
  chmod +x "$TEST_DIR/bin/$tool"
done

NET_LOG="$TEST_DIR/session-start-net.log"
PKG_LOG="$TEST_DIR/session-start-pkg.log"
IDB_STATE="$TEST_DIR/idb-state"
PIN_VERSION="$(node -e 'process.stdout.write(require(process.argv[1]).version)' \
  "$REPO_ROOT/packages/rn-dev-agent-core/src/domain/maestro-runner-pin.json")"
EXPECTED_CMD="bash $REPO_ROOT/packages/claude-plugin/scripts/ensure-maestro-runner.sh"

# RN_AGENT_IDB_* keep ensure-idb.sh off the real $HOME and stop it detaching a
# worker just because this test put a `brew` on PATH.
run_session_start() {
  rm -f "$NET_LOG"
  (
    cd "$PROJECT" &&
      PATH="$TEST_DIR/bin:$PATH" \
      NET_LOG="$NET_LOG" \
      PKG_LOG="$PKG_LOG" \
      RN_DEV_AGENT_RUNNER_CACHE="$1" \
      RN_AGENT_IDB_STATE_DIR="$IDB_STATE" \
      RN_AGENT_IDB_DRY_SPAWN=1 \
      bash "$REPO_ROOT/packages/claude-plugin/hooks/detect-rn-project.sh"
  ) > "$2" 2>&1
  HOOK_STATUS=$?
}

assert_session_start_offline() {
  local label="$1" out="$2"
  if [ -s "$NET_LOG" ]; then
    bad "SessionStart fetched over the network ($label): $(tr '\n' '; ' < "$NET_LOG")"
  else
    ok "SessionStart makes no network calls ($label)"
  fi
  # Exit 0 matters: the hook's own contract makes a non-zero exit "logged,
  # non-blocking", which would hide the install command from the agent.
  if [ "$HOOK_STATUS" -eq 0 ]; then
    ok "SessionStart hook exits 0 so its guidance is shown ($label)"
  else
    bad "SessionStart hook exited $HOOK_STATUS ($label)"
  fi
  if grep -qF "$EXPECTED_CMD" "$out"; then
    ok "SessionStart prints the explicit pinned install command ($label)"
  else
    bad "SessionStart does not print '$EXPECTED_CMD' ($label)"
  fi
}

# The hook's guidance is only correct if the verify mode itself refuses offline,
# so pin that contract directly rather than inferring it from hook output.
assert_verify_mode_refuses_offline() {
  local label="$1" cache="$2" status=0
  rm -f "$NET_LOG"
  PATH="$TEST_DIR/bin:$PATH" NET_LOG="$NET_LOG" RN_DEV_AGENT_RUNNER_CACHE="$cache" \
    bash "$REPO_ROOT/scripts/ensure-maestro-runner.sh" --print-bin > /dev/null 2>&1 || status=$?
  if [ "$status" -ne 0 ] && [ ! -s "$NET_LOG" ]; then
    ok "--print-bin refuses without downloading ($label)"
  else
    bad "--print-bin returned $status and logged '$(tr '\n' '; ' < "$NET_LOG")' ($label)"
  fi
}

MISSING_OUT="$TEST_DIR/session-start-missing.out"
run_session_start "$TEST_DIR/cache-missing" "$MISSING_OUT"
assert_session_start_offline "runner absent" "$MISSING_OUT"
assert_verify_mode_refuses_offline "runner absent" "$TEST_DIR/cache-missing"

# A mismatched cached runner must not be "converged" over the network either.
MISMATCH_CACHE="$TEST_DIR/cache-mismatch"
MISMATCH_BIN="$MISMATCH_CACHE/maestro-runner/$PIN_VERSION/bin/maestro-runner"
mkdir -p "$(dirname "$MISMATCH_BIN")"
printf '#!/bin/sh\necho not-the-pinned-runner\n' > "$MISMATCH_BIN"
chmod +x "$MISMATCH_BIN"
MISMATCH_OUT="$TEST_DIR/session-start-mismatch.out"
run_session_start "$MISMATCH_CACHE" "$MISMATCH_OUT"
assert_session_start_offline "runner checksum mismatch" "$MISMATCH_OUT"
assert_verify_mode_refuses_offline "runner checksum mismatch" "$MISMATCH_CACHE"
if [ "$(cat "$MISMATCH_BIN")" = "$(printf '#!/bin/sh\necho not-the-pinned-runner\n')" ]; then
  ok "SessionStart leaves a mismatched pin-cache byte-identical"
else
  bad "SessionStart rewrote the mismatched pin-cache binary"
fi

if [ -s "$IDB_STATE/spawn.log" ]; then
  bad "SessionStart spawned a background installer: $(tr '\n' '; ' < "$IDB_STATE/spawn.log")"
else
  ok "SessionStart spawns no background installer"
fi
if [ -s "$PKG_LOG" ]; then
  echo "note: SessionStart package-manager calls (pre-existing, outside GH#773): $(tr '\n' '; ' < "$PKG_LOG")"
fi

exit $fail
