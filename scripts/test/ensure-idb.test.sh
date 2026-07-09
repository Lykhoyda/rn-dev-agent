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
SCRIPT="$SCRIPT_DIR/ensure-idb.sh"

fail=0
ok() { echo "ok: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

TMP="$(mktemp -d)"
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
if echo "$OUT" | grep -q "brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion && pipx install fb-idb"; then
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

# 8. SessionStart safety: foreground path must not invoke brew/pipx inline.
#    The dry-spawn seam proves the install goes through the detached worker;
#    additionally the script source must route the real spawn through nohup.
if grep -q "nohup" "$SCRIPT" && grep -q "disown" "$SCRIPT"; then
  ok "safety: worker is detached via nohup+disown"
else bad "safety: expected nohup+disown detachment in $SCRIPT"; fi

exit $fail
