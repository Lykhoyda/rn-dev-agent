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
#   - transient install failure    -> retryable `failed`, never the verdict
#   - stale verdict vs live probe  -> the probe wins, repair still spawns
#   - "repairing" notice           -> printed only when a worker really spawns
#   - ready client, no companion   -> companion notice only, never an fb-idb one
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
if echo "$OUT" | grep -qi "is installed but"; then
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
if echo "$OUT" | grep -qi "is installed but"; then
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
if echo "$OUT" | grep -qi "is installed but"; then
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

# 7h. A transient install failure (network/PyPI/pipx) is NOT evidence of the
#     interpreter incompatibility: every pinned install failing must keep the
#     retryable `failed` verdict, or a blip pins a permanent false diagnosis.
STATE="$TMP/state7h"
mkdir -p "$STATE"
STUBS="$(mkstubs "idb_companion brew python3.13")"
printf '#!/bin/sh\nexit 1\n' > "$STUBS/pipx"; chmod +x "$STUBS/pipx"
run_worker "$STUBS" "$TMP/worker7h.out"
if grep -q "^failed " "$STATE/last-attempt" 2>/dev/null; then
  ok "worker: failing pipx stays retryable (no terminal verdict)"
else bad "worker: expected failed marker, got: $(cat "$STATE/last-attempt" 2>/dev/null)"; fi
if grep -qi "is installed but" "$TMP/worker7h.out"; then
  bad "worker: absent client described as installed-but-broken"
else ok "worker: never calls a never-installed client unusable"; fi

# 7i. A stale verdict must never outrank the live probe: a client that now
#     works (with the companion still missing) falls through to the repair
#     spawn instead of being reported as crashing.
STATE="$TMP/state7i"
mkdir -p "$STATE"
STUBS="$(mkstubs "idb brew python3.13")"
echo "incompatible $(date +%s) python3.13," > "$STATE/last-attempt"
OUT="$(run_script "$STUBS")"
if echo "$OUT" | grep -qi "is installed but"; then
  bad "stale-verdict: claimed a working client crashes, got: $OUT"
else ok "stale-verdict: live probe outranks the marker"; fi
[ -f "$STATE/spawn.log" ] && ok "stale-verdict: still spawns the companion install" || bad "stale-verdict: blocked the companion repair, got: $OUT"

# 7j. The "repairing in the background" claim may only be printed when a worker
#     is actually spawned — the backoff guard must not be preceded by a promise.
STATE="$TMP/state7j"
mkdir -p "$STATE"
echo "failed $(date +%s)" > "$STATE/last-attempt"
STUBS="$(mkstubs "idb_companion brew python3.13")"
printf '#!/bin/sh\nexit 1\n' > "$STUBS/idb"; chmod +x "$STUBS/idb"
OUT="$(run_script "$STUBS")"
[ ! -f "$STATE/spawn.log" ] && ok "repair-notice: backoff still blocks the spawn" || bad "repair-notice: spawned inside backoff window"
if echo "$OUT" | grep -qi "Repairing in the background"; then
  bad "repair-notice: announced a repair that never started, got: $OUT"
else ok "repair-notice: silent when no worker is spawned"; fi
if echo "$OUT" | grep -qi "is installed but"; then
  ok "repair-notice: still explains the incompatibility truthfully"
else bad "repair-notice: dropped the broken-client explanation, got: $OUT"; fi

# 7l. GH#578 round 4: a pinned install that SUCCEEDS but leaves no client on
#     PATH is a shim-visibility problem, not an incompatibility. It must stay
#     retryable (`failed`), must record the cause, and must never tell the
#     developer to re-run the install command that already succeeded.
STATE="$TMP/state7l"
mkdir -p "$STATE"
STUBS="$(mkstubs "idb_companion brew python3.13")"
printf '#!/bin/sh\nexit 0\n' > "$STUBS/pipx"; chmod +x "$STUBS/pipx"
run_worker "$STUBS" "$TMP/worker7l.out"
if grep -q "^failed " "$STATE/last-attempt" 2>/dev/null; then
  ok "path-shim: retryable failed verdict, not terminal"
else bad "path-shim: expected failed marker, got: $(cat "$STATE/last-attempt" 2>/dev/null)"; fi
if grep -q "path-shim" "$STATE/last-attempt" 2>/dev/null; then
  ok "path-shim: cause persisted to the marker"
else bad "path-shim: expected cause in marker, got: $(cat "$STATE/last-attempt" 2>/dev/null)"; fi
if grep -qi "asyncio.get_event_loop" "$TMP/worker7l.out"; then
  bad "path-shim: falsely blamed the interpreter incompatibility"
else ok "path-shim: does not blame the interpreter"; fi

# 7m. The foreground line the developer reads for the next 24h must carry that
#     cause instead of defaulting to the already-successful install command.
#     Self-contained: its own state dir and stubs, with the path-shim marker
#     produced by a worker run of its own rather than inherited from 7l.
STATE="$TMP/state7m"
mkdir -p "$STATE"
STUBS="$(mkstubs "idb_companion brew python3.13")"
printf '#!/bin/sh\nexit 0\n' > "$STUBS/pipx"; chmod +x "$STUBS/pipx"
run_worker "$STUBS" "$TMP/worker7m.out"
OUT="$(run_script "$STUBS")"
if echo "$OUT" | grep -qi "not exported\|ensurepath"; then
  ok "path-shim: backoff line names the PATH cause"
else bad "path-shim: expected PATH remedy, got: $OUT"; fi
if echo "$OUT" | grep -q "idb install failed recently"; then
  bad "path-shim: fell back to the generic install-failed line"
else ok "path-shim: no generic install-failed fallback"; fi
assert_no_unpinned_install "path-shim" "$OUT"

# 7n. The no-interpreter terminal verdict must not narrate the crashing-client
#     story: in that state the client is absent, so that explanation is false.
STATE="$TMP/state7n"
mkdir -p "$STATE"
STUBS="$(mkstubs "idb_companion brew")"
echo "incompatible $(date +%s) none no-interpreter" > "$STATE/last-attempt"
OUT="$(FAKE_PYTHONS=python3.13 run_script "$STUBS")"
if echo "$OUT" | grep -qi "no supported Python"; then
  ok "no-interpreter: names the missing interpreter"
else bad "no-interpreter: expected interpreter message, got: $OUT"; fi
if echo "$OUT" | grep -qi "did not respond successfully"; then
  bad "no-interpreter: narrated the crashing-client story for an absent client"
else ok "no-interpreter: does not claim a crashing client"; fi
if echo "$OUT" | grep -q "$STATE/last-attempt"; then
  ok "no-interpreter: names the marker path as the escape hatch"
else bad "no-interpreter: expected the marker path in the terminal line, got: $OUT"; fi

# 7k. The cause claim is hedged, never asserted as fact — the probe cannot
#     separate a crash from a timeout or EACCES.
STATE="$TMP/state7k"
STUBS="$(mkstubs "idb_companion brew python3.13")"
printf '#!/bin/sh\nexit 1\n' > "$STUBS/idb"; chmod +x "$STUBS/idb"
OUT="$(run_script "$STUBS")"
if echo "$OUT" | grep -qi "most likely"; then
  ok "hedging: cause stated as probable"
else bad "hedging: expected hedged cause, got: $OUT"; fi

# 7o. A healthy client whose only missing piece is the companion must not be
#     told an interpreter repair is underway: the worker's own guard skips pipx
#     entirely in that state, so the fb-idb command describes work never run.
STATE="$TMP/state7o"
STUBS="$(mkstubs "idb brew python3.13")"
OUT="$(run_script "$STUBS")"
if echo "$OUT" | grep -qi "idb-companion missing"; then
  ok "ready-no-companion: names the companion as the missing piece"
else bad "ready-no-companion: expected a companion notice, got: $OUT"; fi
if echo "$OUT" | grep -qiE "Repairing in the background|pipx|fb-idb"; then
  bad "ready-no-companion: offered an fb-idb repair for a working client, got: $OUT"
else ok "ready-no-companion: no fb-idb reinstall suggested"; fi
[ -f "$STATE/spawn.log" ] && ok "ready-no-companion: still spawns the companion install" || bad "ready-no-companion: no spawn recorded"

# 7p. Same state without brew: the manual hint is the companion half only.
STATE="$TMP/state7p"
STUBS="$(mkstubs "idb")"
OUT="$(run_script "$STUBS")"
if echo "$OUT" | grep -qiE "pipx|fb-idb"; then
  bad "ready-no-brew: printed an fb-idb command for a working client, got: $OUT"
else ok "ready-no-brew: companion-only manual hint"; fi
if echo "$OUT" | grep -q "brew install idb-companion"; then
  ok "ready-no-brew: names the companion install"
else bad "ready-no-brew: expected the companion command, got: $OUT"; fi

# 7q. A stale path-shim cause must never outrank the live probe: once the shim
#     is exported the client reads ready, so the "no idb client is visible on
#     PATH" story is false and the companion is the only missing half.
STATE="$TMP/state7q"
mkdir -p "$STATE"
echo "failed $(date +%s) python3.13, path-shim" > "$STATE/last-attempt"
STUBS="$(mkstubs "idb brew python3.13")"
OUT="$(run_script "$STUBS")"
if echo "$OUT" | grep -qi "not exported\|ensurepath"; then
  bad "stale-path-shim: claimed an invisible shim for a working client, got: $OUT"
else ok "stale-path-shim: live probe outranks the persisted cause"; fi
if echo "$OUT" | grep -qiE "pipx install|fb-idb"; then
  bad "stale-path-shim: offered an fb-idb command for a working client, got: $OUT"
else ok "stale-path-shim: companion-only remedy"; fi

# 8. SessionStart safety: foreground path must not invoke brew/pipx inline.
#    The dry-spawn seam proves the install goes through the detached worker;
#    additionally the script source must route the real spawn through nohup.
if grep -q "nohup" "$SCRIPT" && grep -q "disown" "$SCRIPT"; then
  ok "safety: worker is detached via nohup+disown"
else bad "safety: expected nohup+disown detachment in $SCRIPT"; fi

exit $fail
