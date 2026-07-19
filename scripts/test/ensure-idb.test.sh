#!/usr/bin/env bash
# Tests for scripts/ensure-idb.sh — background idb auto-install for the observe
# live mirror's fast path (idb video-stream, 20-30fps vs the ~6fps simctl loop).
#
# Contract under test:
#   - both binaries present        -> "idb available", exit 0, no spawn
#   - non-macOS                    -> silent exit 0, no spawn
#   - brew missing                 -> manual-install hint, exit 0, no spawn
#   - missing binaries + brew      -> spawns ONE detached worker, prints notice
#   - worker already running       -> no second spawn (pidfile guard)
#   - recent failed attempt (<24h) -> no respawn (backoff marker)
#   - SessionStart safety: the foreground path never runs brew/pipx inline
#
# Test seams (env):
#   RN_AGENT_IDB_STATE_DIR   state dir (pidfile, marker, log)
#   RN_AGENT_IDB_UNAME       fake uname -s output
#   RN_AGENT_IDB_PATH_STUBS  dir prepended to PATH (fake idb/idb_companion/brew)
#   RN_AGENT_IDB_DRY_SPAWN=1 record the would-be spawn instead of nohup'ing it
#
# Run: bash scripts/test/ensure-idb.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="${SCRIPT_UNDER_TEST:-$SCRIPT_DIR/ensure-idb.sh}"
RECOVERY_COMMAND='brew install python@3.13 && pipx install --python "$(brew --prefix python@3.13)/bin/python3.13" --force fb-idb'

fail=0
ok() { echo "ok: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

if [ -n "${RN_AGENT_TEST_TMP_ROOT:-}" ]; then
  mkdir -p "$RN_AGENT_TEST_TMP_ROOT"
  TMP="$(mktemp -d "$RN_AGENT_TEST_TMP_ROOT/ensure-idb.XXXXXX")"
elif [ -n "${TMPDIR:-}" ]; then
  mkdir -p "$TMPDIR"
  TMP="$(mktemp -d "${TMPDIR%/}/ensure-idb.XXXXXX")"
else
  TMP="$(mktemp -d)"
fi
trap 'rm -rf "$TMP"' EXIT

mkstubs() { # $1 = space-separated binary names to stub as present
  local dir="$TMP/stubs-$RANDOM"
  mkdir -p "$dir"
  for b in $1; do
    printf '#!/bin/sh\nexit 0\n' > "$dir/$b"
    chmod +x "$dir/$b"
  done
  echo "$dir"
}

run_script() { # $1 = stubs dir, rest = extra env
  local stubs="$1"; shift
  env PATH="$stubs:/usr/bin:/bin" \
    RN_AGENT_IDB_STATE_DIR="$STATE" \
    RN_AGENT_IDB_UNAME="${FAKE_UNAME:-Darwin}" \
    RN_AGENT_IDB_DRY_SPAWN=1 \
    "$@" bash "$SCRIPT" 2>&1
}

# 1. Both binaries present -> reports available, no spawn.
STATE="$TMP/state1"
STUBS="$(mkstubs "idb idb_companion brew")"
OUT="$(run_script "$STUBS")"
if echo "$OUT" | grep -qi "idb available"; then ok "present: reports available"; else bad "present: expected 'idb available', got: $OUT"; fi
[ ! -f "$STATE/spawn.log" ] && ok "present: no spawn" || bad "present: unexpected spawn"

# 1b. Hyphenated companion name (older brew formula) also counts as present.
STATE="$TMP/state1b"
STUBS="$(mkstubs "idb idb-companion brew")"
OUT="$(run_script "$STUBS")"
if echo "$OUT" | grep -qi "idb available"; then ok "hyphen: idb-companion accepted"; else bad "hyphen: expected available, got: $OUT"; fi
[ ! -f "$STATE/spawn.log" ] && ok "hyphen: no spawn" || bad "hyphen: unexpected spawn"

# 1bb. A healthy client with a missing companion needs companion installation,
#      but must not be misreported as a broken client.
STATE="$TMP/state1bb"
STUBS="$(mkstubs "idb brew")"
OUT="$(run_script "$STUBS")"
if ! echo "$OUT" | grep -qi "broken"; then ok "healthy-client: missing companion is not a client failure"; else bad "healthy-client: incorrectly reported broken, got: $OUT"; fi
[ -f "$STATE/spawn.log" ] && ok "healthy-client: missing companion starts repair" || bad "healthy-client: missing companion did not start repair"

# 1c. A Python 3.14 client on PATH that crashes is classified as incompatible,
#     receives an actionable recovery command, and never spawns a worker.
STATE="$TMP/state1c"
STUBS="$(mkstubs "idb_companion brew")"
printf '#!/bin/sh\necho "  File /pipx/venvs/fb-idb/lib/python3.14/site-packages/idb/cli/main.py" >&2\necho "RuntimeError: There is no current event loop" >&2\nexit 1\n' > "$STUBS/idb"; chmod +x "$STUBS/idb"
OUT="$(run_script "$STUBS")"
if echo "$OUT" | grep -q "installed but incompatible with Python 3.14"; then ok "incompatible-client: reports interpreter incompatibility"; else bad "incompatible-client: expected incompatibility notice, got: $OUT"; fi
if ! echo "$OUT" | grep -qi "idb not installed"; then ok "incompatible-client: does not report idb as missing"; else bad "incompatible-client: incorrectly reported idb as missing, got: $OUT"; fi
if echo "$OUT" | grep -Fq "$RECOVERY_COMMAND"; then ok "incompatible-client: prints pinned Python 3.13 recovery"; else bad "incompatible-client: missing recovery command, got: $OUT"; fi
[ ! -f "$STATE/spawn.log" ] && ok "incompatible-client: no repair spawn" || bad "incompatible-client: unexpectedly spawned repair"
FINGERPRINT_BEFORE="$(cat "$STATE/incompatible-environment" 2>/dev/null)"
OUT_REPEAT="$(run_script "$STUBS")"
[ ! -f "$STATE/spawn.log" ] && ok "incompatible-client: unchanged environment remains suppressed" || bad "incompatible-client: unchanged environment spawned repair"
[ "$(cat "$STATE/incompatible-environment" 2>/dev/null)" = "$FINGERPRINT_BEFORE" ] && ok "incompatible-client: stable environment fingerprint" || bad "incompatible-client: fingerprint changed unexpectedly"
printf '#!/bin/sh\necho "  File /changed/fb-idb/lib/python3.14/site-packages/idb/cli/main.py" >&2\necho "RuntimeError: There is no current event loop" >&2\nexit 1\n' > "$STUBS/idb"; chmod +x "$STUBS/idb"
OUT_CHANGED="$(run_script "$STUBS")"
[ "$(cat "$STATE/incompatible-environment" 2>/dev/null)" != "$FINGERPRINT_BEFORE" ] && ok "incompatible-client: environment change is re-evaluated" || bad "incompatible-client: environment change was not recorded"
[ ! -f "$STATE/spawn.log" ] && ok "incompatible-client: changed but still-incompatible environment stays suppressed" || bad "incompatible-client: still-incompatible environment spawned repair"
printf '#!/bin/sh\necho "new non-interpreter client failure" >&2\nexit 1\n' > "$STUBS/idb"; chmod +x "$STUBS/idb"
echo "failed $(date +%s)" > "$STATE/last-attempt"
OUT_RECOVERABLE="$(run_script "$STUBS")"
[ -f "$STATE/spawn.log" ] && ok "incompatible-client: changed verdict re-enables repair" || bad "incompatible-client: environment change did not re-enable repair"
[ ! -f "$STATE/incompatible-environment" ] && ok "incompatible-client: changed verdict clears fingerprint" || bad "incompatible-client: stale fingerprint survived environment change"
[ ! -f "$STATE/last-attempt" ] && ok "incompatible-client: changed verdict clears stale backoff" || bad "incompatible-client: stale backoff survived environment change"

# 1d. A non-Python-3.14 crash retains the generic background repair path.
STATE="$TMP/state1d"
STUBS="$(mkstubs "idb_companion brew")"
printf '#!/bin/sh\necho "  File /pipx/venvs/fb-idb/lib/python3.14/site-packages/idb/cli/main.py" >&2\necho "unexpected client failure" >&2\nexit 1\n' > "$STUBS/idb"; chmod +x "$STUBS/idb"
OUT="$(run_script "$STUBS")"
if echo "$OUT" | grep -qi "broken"; then ok "broken-client: prints generic broken notice"; else bad "broken-client: expected broken notice, got: $OUT"; fi
[ -f "$STATE/spawn.log" ] && ok "broken-client: spawns generic repair worker" || bad "broken-client: expected repair spawn"

# 2. Non-macOS -> silent success, no spawn.
STATE="$TMP/state2"
STUBS="$(mkstubs "brew")"
OUT="$(FAKE_UNAME=Linux run_script "$STUBS")"
[ -z "$OUT" ] && ok "linux: silent" || bad "linux: expected no output, got: $OUT"
[ ! -f "$STATE/spawn.log" ] && ok "linux: no spawn" || bad "linux: unexpected spawn"

# 3. brew missing -> manual hint, exit 0, no spawn.
STATE="$TMP/state3"
STUBS="$(mkstubs "")"
OUT="$(run_script "$STUBS")"
if echo "$OUT" | grep -Fq "$RECOVERY_COMMAND"; then
  ok "no-brew: prints manual command"
else bad "no-brew: missing manual command, got: $OUT"; fi
[ ! -f "$STATE/spawn.log" ] && ok "no-brew: no spawn" || bad "no-brew: unexpected spawn"

# 4. Missing binaries + brew present -> exactly one recorded spawn + notice.
STATE="$TMP/state4"
STUBS="$(mkstubs "brew")"
OUT="$(run_script "$STUBS")"
if echo "$OUT" | grep -qi "background"; then ok "install: prints background notice"; else bad "install: no notice, got: $OUT"; fi
if [ -f "$STATE/spawn.log" ] && [ "$(wc -l < "$STATE/spawn.log")" -eq 1 ]; then
  ok "install: exactly one spawn recorded"
else bad "install: expected one spawn record"; fi

# 5. Worker already running (live pidfile) -> no second spawn.
STATE="$TMP/state5"
mkdir -p "$STATE"
sleep 300 & SLEEPER=$!
echo "$SLEEPER" > "$STATE/install.pid"
STUBS="$(mkstubs "brew")"
OUT="$(run_script "$STUBS")"
kill "$SLEEPER" 2>/dev/null
wait "$SLEEPER" 2>/dev/null
[ ! -f "$STATE/spawn.log" ] && ok "pidfile: no respawn while running" || bad "pidfile: respawned despite live worker"
if echo "$OUT" | grep -qi "in progress"; then ok "pidfile: reports in-progress"; else bad "pidfile: expected in-progress notice, got: $OUT"; fi

# 6. Recent failure marker (<24h) -> no respawn.
STATE="$TMP/state6"
mkdir -p "$STATE"
echo "failed $(date +%s)" > "$STATE/last-attempt"
STUBS="$(mkstubs "brew")"
OUT="$(run_script "$STUBS")"
[ ! -f "$STATE/spawn.log" ] && ok "backoff: no respawn within 24h of failure" || bad "backoff: respawned inside backoff window"

# 7. Stale failure marker (>24h) -> respawns.
STATE="$TMP/state7"
mkdir -p "$STATE"
echo "failed $(( $(date +%s) - 90000 ))" > "$STATE/last-attempt"
STUBS="$(mkstubs "brew")"
OUT="$(run_script "$STUBS")"
[ -f "$STATE/spawn.log" ] && ok "backoff: stale marker allows retry" || bad "backoff: stale marker still blocked retry"

# 7b. B269 worker invariant: a client that is still broken after reinstall is
#     UNINSTALLED (never left on PATH) and the attempt is marked failed.
STATE="$TMP/state7b"
mkdir -p "$STATE"
STUBS="$(mkstubs "idb_companion brew")"
printf '#!/bin/sh\nexit 1\n' > "$STUBS/idb"; chmod +x "$STUBS/idb"
printf '#!/bin/sh\necho "$@" >> "%s/pipx.log"\nexit 0\n' "$STATE" > "$STUBS/pipx"; chmod +x "$STUBS/pipx"
PYTHON_PREFIX="$TMP/python-3.13"
mkdir -p "$PYTHON_PREFIX/bin"
printf '#!/bin/sh\nexit 0\n' > "$PYTHON_PREFIX/bin/python3.13"; chmod +x "$PYTHON_PREFIX/bin/python3.13"
printf '#!/bin/sh\nif [ "$1" = "--prefix" ]; then echo "%s"; fi\nexit 0\n' "$PYTHON_PREFIX" > "$STUBS/brew"; chmod +x "$STUBS/brew"
env PATH="$STUBS:/usr/bin:/bin" RN_AGENT_IDB_STATE_DIR="$STATE" RN_AGENT_IDB_UNAME=Darwin \
  bash "$SCRIPT" --install-worker > "$TMP/worker7b.out" 2>&1
if grep -q "uninstall fb-idb" "$STATE/pipx.log" 2>/dev/null; then
  ok "worker: broken client uninstalled (never left on PATH)"
else bad "worker: expected pipx uninstall fb-idb, got: $(cat "$STATE/pipx.log" 2>/dev/null)"; fi
if grep -Fq "install --python $PYTHON_PREFIX/bin/python3.13 --force fb-idb" "$STATE/pipx.log" 2>/dev/null; then
  ok "worker: install is pinned to Python 3.13"
else bad "worker: expected pinned pipx install, got: $(cat "$STATE/pipx.log" 2>/dev/null)"; fi
if grep -q "^failed " "$STATE/last-attempt" 2>/dev/null; then
  ok "worker: broken client marks attempt failed (backoff engages)"
else bad "worker: expected failed marker, got: $(cat "$STATE/last-attempt" 2>/dev/null)"; fi
if grep -qi "crashes on invocation" "$TMP/worker7b.out"; then
  ok "worker: explains the uninstall in the log"
else bad "worker: expected crash explanation, got: $(cat "$TMP/worker7b.out")"; fi

# 8. SessionStart safety: foreground path must not invoke brew/pipx inline.
#    The dry-spawn seam proves the install goes through the detached worker;
#    additionally the script source must route the real spawn through nohup.
if grep -q "nohup" "$SCRIPT" && grep -q "disown" "$SCRIPT"; then
  ok "safety: worker is detached via nohup+disown"
else bad "safety: expected nohup+disown detachment in $SCRIPT"; fi

exit $fail
