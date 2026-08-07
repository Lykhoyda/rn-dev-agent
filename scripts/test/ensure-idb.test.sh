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
#   - present-but-broken client    -> incompatibility named, never "missing"
#   - incompatible verdict         -> no respawn until interpreters change
#   - no message ever prints the unpinned `pipx install fb-idb` (GH#578)
#   - SessionStart safety: the foreground path never runs brew/pipx inline
#
# Test seams (env):
#   RN_AGENT_IDB_STATE_DIR   state dir (pidfile, marker, log)
#   RN_AGENT_IDB_UNAME       fake uname -s output
#   RN_AGENT_IDB_PYTHONS     supported-interpreter candidate list
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
    RN_AGENT_IDB_PYTHONS="${FAKE_PYTHONS:-python3.13}" \
    RN_AGENT_IDB_DRY_SPAWN=1 \
    "$@" bash "$SCRIPT" 2>&1
}

# GH#578: `pipx install fb-idb` without a pinned interpreter resolves the
# newest Python, which is exactly the combination that crashes. No user-facing
# message may ever print it.
assert_no_unpinned_install() { # $1 = label, $2 = output
  if echo "$2" | grep -q "pipx install fb-idb"; then
    bad "$1: printed the known-broken unpinned install command"
  else ok "$1: no unpinned install command"; fi
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

# 1c. B269/GH#578: client on PATH but BROKEN (crashes on invocation) -> not
#     treated as present, and NOT reported as absent either: the message names
#     the interpreter incompatibility and a repair worker is spawned.
STATE="$TMP/state1c"
STUBS="$(mkstubs "idb_companion brew")"
printf '#!/bin/sh\nexit 1\n' > "$STUBS/idb"; chmod +x "$STUBS/idb"
OUT="$(run_script "$STUBS")"
if echo "$OUT" | grep -qi "installed but unusable"; then
  ok "broken-client: reports present-but-unusable"
else bad "broken-client: expected present-but-unusable notice, got: $OUT"; fi
if echo "$OUT" | grep -q "asyncio.get_event_loop" && echo "$OUT" | grep -q "Python 3.14"; then
  ok "broken-client: names the actual incompatibility"
else bad "broken-client: expected the Python 3.14 explanation, got: $OUT"; fi
if echo "$OUT" | grep -qiE "idb (not installed|missing)"; then
  bad "broken-client: still described as missing (states 1 and 3 collapsed)"
else ok "broken-client: not described as missing"; fi
assert_no_unpinned_install "broken-client" "$OUT"
if [ -f "$STATE/spawn.log" ] && [ "$(wc -l < "$STATE/spawn.log")" -eq 1 ]; then
  ok "broken-client: spawns repair worker"
else bad "broken-client: expected one spawn record"; fi

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
if echo "$OUT" | grep -q "brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion && pipx install --python python3\.13 --force fb-idb"; then
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

run_worker() { # $1 = stubs dir, $2 = output file
  env PATH="$1:/usr/bin:/bin" RN_AGENT_IDB_STATE_DIR="$STATE" RN_AGENT_IDB_UNAME=Darwin \
    RN_AGENT_IDB_PYTHONS="${FAKE_PYTHONS:-python3.13}" \
    bash "$SCRIPT" --install-worker > "$2" 2>&1
}

# 7b. GH#578 worker: the install is pinned to a supported interpreter, never
#     resolved by pipx (which would pick the breaking 3.14). A client that is
#     still broken afterwards yields the terminal `incompatible` verdict.
STATE="$TMP/state7b"
mkdir -p "$STATE"
STUBS="$(mkstubs "idb_companion brew python3.13")"
printf '#!/bin/sh\nexit 1\n' > "$STUBS/idb"; chmod +x "$STUBS/idb"
printf '#!/bin/sh\necho "$@" >> "%s/pipx.log"\nexit 0\n' "$STATE" > "$STUBS/pipx"; chmod +x "$STUBS/pipx"
run_worker "$STUBS" "$TMP/worker7b.out"
if grep -q -- "--python python3.13 --force fb-idb" "$STATE/pipx.log" 2>/dev/null; then
  ok "worker: installs fb-idb under a pinned supported interpreter"
else bad "worker: expected pinned install, got: $(cat "$STATE/pipx.log" 2>/dev/null)"; fi
if grep -qE "^install fb-idb$" "$STATE/pipx.log" 2>/dev/null; then
  bad "worker: ran the unpinned install that reproduces the break"
else ok "worker: never runs the unpinned install"; fi
if grep -q "^incompatible " "$STATE/last-attempt" 2>/dev/null; then
  ok "worker: records the terminal incompatible verdict"
else bad "worker: expected incompatible marker, got: $(cat "$STATE/last-attempt" 2>/dev/null)"; fi
if grep -q "python3.13," "$STATE/last-attempt" 2>/dev/null; then
  ok "worker: verdict carries the interpreter fingerprint"
else bad "worker: expected fingerprint in marker, got: $(cat "$STATE/last-attempt" 2>/dev/null)"; fi
if grep -qi "asyncio.get_event_loop" "$TMP/worker7b.out"; then
  ok "worker: explains the incompatibility in the log"
else bad "worker: expected crash explanation, got: $(cat "$TMP/worker7b.out")"; fi

# 7c. Worker success path: when the pinned interpreter yields a healthy client
#     the verdict is plain `ok` — the repair path still converges.
STATE="$TMP/state7c"
mkdir -p "$STATE"
STUBS="$(mkstubs "idb_companion brew python3.13")"
printf '#!/bin/sh\nexit 1\n' > "$STUBS/idb"; chmod +x "$STUBS/idb"
printf '#!/bin/sh\nprintf "#!/bin/sh\\nexit 0\\n" > "%s/idb"\nchmod +x "%s/idb"\nexit 0\n' "$STUBS" "$STUBS" > "$STUBS/pipx"
chmod +x "$STUBS/pipx"
run_worker "$STUBS" "$TMP/worker7c.out"
if grep -q "^ok " "$STATE/last-attempt" 2>/dev/null; then
  ok "worker: pinned reinstall that works records ok"
else bad "worker: expected ok marker, got: $(cat "$STATE/last-attempt" 2>/dev/null)"; fi

# 7d. GH#578 core regression: with the incompatible verdict recorded and the
#     interpreter set unchanged, session start explains the incompatibility,
#     does NOT re-show an install hint, and does NOT respawn. This is the loop.
STATE="$TMP/state7d"
mkdir -p "$STATE"
STUBS="$(mkstubs "idb_companion brew python3.13")"
printf '#!/bin/sh\nexit 1\n' > "$STUBS/idb"; chmod +x "$STUBS/idb"
echo "incompatible $(date +%s) python3.13," > "$STATE/last-attempt"
OUT="$(run_script "$STUBS")"
if echo "$OUT" | grep -qi "installed but unusable"; then
  ok "verdict: explains the incompatibility"
else bad "verdict: expected incompatibility explanation, got: $OUT"; fi
if echo "$OUT" | grep -qi "Not retrying until the installed Python interpreters change"; then
  ok "verdict: states the loop has stopped and what would restart it"
else bad "verdict: expected non-retry statement, got: $OUT"; fi
[ ! -f "$STATE/spawn.log" ] && ok "verdict: no respawn (loop terminated)" || bad "verdict: respawned despite terminal verdict"
assert_no_unpinned_install "verdict" "$OUT"
if echo "$OUT" | grep -qiE "idb (not installed|missing)"; then
  bad "verdict: reported as missing despite being installed"
else ok "verdict: never claims idb is missing"; fi

# 7e. The verdict is not permanent: installing a supported interpreter changes
#     the fingerprint, which re-arms the repair worker.
STATE="$TMP/state7e"
mkdir -p "$STATE"
STUBS="$(mkstubs "idb_companion brew python3.13")"
printf '#!/bin/sh\nexit 1\n' > "$STUBS/idb"; chmod +x "$STUBS/idb"
echo "incompatible $(date +%s) none" > "$STATE/last-attempt"
OUT="$(run_script "$STUBS")"
[ -f "$STATE/spawn.log" ] && ok "verdict: changed interpreter set re-arms repair" || bad "verdict: env change did not re-arm, got: $OUT"

# 7f. A genuinely absent client stays state 1 — it is still reported missing
#     and still gets an install hint (the fix must not blur the states).
STATE="$TMP/state7f"
STUBS="$(mkstubs "idb_companion brew python3.13")"
OUT="$(run_script "$STUBS")"
if echo "$OUT" | grep -qi "idb missing"; then
  ok "absent: still reported as missing"
else bad "absent: expected missing notice, got: $OUT"; fi
if echo "$OUT" | grep -qi "installed but unusable"; then
  bad "absent: wrongly reported as installed-but-broken"
else ok "absent: not confused with the broken state"; fi
assert_no_unpinned_install "absent" "$OUT"

# 7g. A brew failure must stay `failed` (retryable) rather than being masked by
#     the terminal incompatible verdict — only the client verdict is terminal.
STATE="$TMP/state7g"
mkdir -p "$STATE"
STUBS="$(mkstubs "python3.13")"
printf '#!/bin/sh\nexit 1\n' > "$STUBS/idb"; chmod +x "$STUBS/idb"
printf '#!/bin/sh\nexit 1\n' > "$STUBS/brew"; chmod +x "$STUBS/brew"
printf '#!/bin/sh\nexit 0\n' > "$STUBS/pipx"; chmod +x "$STUBS/pipx"
run_worker "$STUBS" "$TMP/worker7g.out"
if grep -q "^failed " "$STATE/last-attempt" 2>/dev/null; then
  ok "worker: brew failure keeps the retryable failed verdict"
else bad "worker: expected failed marker, got: $(cat "$STATE/last-attempt" 2>/dev/null)"; fi

# 8. SessionStart safety: foreground path must not invoke brew/pipx inline.
#    The dry-spawn seam proves the install goes through the detached worker;
#    additionally the script source must route the real spawn through nohup.
if grep -q "nohup" "$SCRIPT" && grep -q "disown" "$SCRIPT"; then
  ok "safety: worker is detached via nohup+disown"
else bad "safety: expected nohup+disown detachment in $SCRIPT"; fi

exit $fail
