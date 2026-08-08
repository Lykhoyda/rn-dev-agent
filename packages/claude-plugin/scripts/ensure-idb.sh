#!/usr/bin/env bash
# ensure-idb.sh — background auto-install of idb for the observe live mirror.
#
# The mirror's iOS fast path is `idb video-stream` (20-30fps MJPEG); without
# idb it degrades to a ~6fps `simctl screenshot` loop. idb needs two pieces
# (idb-companion lives in the facebook/fb tap, not homebrew-core):
#   brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion
#   pipx install --python python3.13 fb-idb                (the Python CLI client)
#
# GH#578: the interpreter pin is load-bearing. fb-idb 1.1.7 calls
# asyncio.get_event_loop() at CLI startup, which Python 3.14 removed, so a
# bare `pipx install fb-idb` on a 3.14-default machine installs a client that
# crashes on every invocation. This script therefore treats the client as
# three distinct states — absent, ready, broken — and never prints an install
# command that would recreate the broken combination.
#
# SessionStart contract (GH#252/B196: session start must be BOUNDED): this
# script's foreground path only does `command -v` / `idb --help` checks and
# (at most) spawns ONE detached worker — it NEVER runs brew/pipx inline. The
# worker is nohup'd + disown'd with all stdio detached so the SessionStart
# hook's timeout cannot be held open by inherited FDs.
#
# Re-entry guards:
#   - pidfile:      a live worker is never duplicated across session starts
#   - last-attempt: a failed install is not retried for 24h (brew failures
#     are usually environmental; hammering it every session start is noise)
#   - incompatible verdict: once no available interpreter can produce a
#     working client, retrying cannot succeed, so it stops until the set of
#     installed Python interpreters changes (GH#578).
#
# Test seams (scripts/test/ensure-idb.test.sh):
#   RN_AGENT_IDB_STATE_DIR   state dir      (default: ~/.rn-dev-agent/idb)
#   RN_AGENT_IDB_UNAME       fake `uname -s`
#   RN_AGENT_IDB_PYTHONS     override the supported-interpreter candidate list
#   RN_AGENT_IDB_DRY_SPAWN=1 record the spawn to spawn.log instead of running
#
# Exit code: always 0 from the foreground path (mirror works without idb —
# a missing optional dependency must never fail SessionStart).

set -uo pipefail

STATE_DIR="${RN_AGENT_IDB_STATE_DIR:-$HOME/.rn-dev-agent/idb}"
PIDFILE="$STATE_DIR/install.pid"
MARKER="$STATE_DIR/last-attempt"
LOG="$STATE_DIR/install.log"
BACKOFF_SECS=86400

# Newest first. 3.14 is excluded on purpose: it is the interpreter that breaks
# fb-idb 1.1.7. Add newer versions here once a compatible fb-idb release ships.
SUPPORTED_PYTHONS="${RN_AGENT_IDB_PYTHONS:-python3.13 python3.12 python3.11}"

OS="${RN_AGENT_IDB_UNAME:-$(uname -s)}"
[ "$OS" = "Darwin" ] || exit 0

# Homebrew has shipped the companion under both spellings across versions;
# ensure-idb-companion.sh accepts both, so this script must too — otherwise
# hyphen-name installs are reported missing and the worker respawns forever.
has_companion() {
  command -v idb_companion >/dev/null 2>&1 || command -v idb-companion >/dev/null 2>&1
}

# B269: PATH presence is not health. `idb --help` initializes the CLI without
# contacting a companion, so it exits 0 for a healthy client and non-zero for
# one crashing under an incompatible interpreter.
idb_client_state() {
  if ! command -v idb >/dev/null 2>&1; then
    echo absent
  elif idb --help >/dev/null 2>&1; then
    echo ready
  else
    echo broken
  fi
}

first_supported_python() {
  for py in $SUPPORTED_PYTHONS; do
    if command -v "$py" >/dev/null 2>&1; then
      echo "$py"
      return 0
    fi
  done
  return 1
}

# The only thing that can turn an "incompatible" verdict back into a solvable
# problem is a change to the installed interpreters, so that is the fingerprint.
python_fingerprint() {
  local fp=""
  for py in $SUPPORTED_PYTHONS; do
    command -v "$py" >/dev/null 2>&1 && fp="$fp$py,"
  done
  echo "${fp:-none}"
}

install_command() {
  local py
  py="$(first_supported_python)" || py=""
  if [ -n "$py" ]; then
    echo "brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion && pipx install --python $py --force fb-idb"
  else
    echo "brew install python@3.13 && brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion && pipx install --python python3.13 --force fb-idb"
  fi
}

# The companion half alone: a client that already works must never be told to
# reinstall fb-idb.
companion_command() {
  echo "brew tap facebook/fb && brew trust facebook/fb && brew install idb-companion"
}

# The probe only observes a non-zero exit (a timeout or EACCES lands here too),
# so the cause is stated as probable rather than asserted as fact.
incompatible_explanation() {
  echo "idb is installed but did not respond successfully: the most likely cause is fb-idb calling asyncio.get_event_loop(), which Python 3.14 removed. Installing it again under the same interpreter would reproduce this."
}

# GH#578: a pinned install that SUCCEEDS but leaves no client on PATH is a shim
# visibility problem, not an interpreter incompatibility — retryable, and the
# remedy is the PATH, never the install command that already succeeded.
path_shim_explanation() {
  echo "fb-idb installed successfully, but no idb client is visible on PATH — the pipx shim directory (usually ~/.local/bin) is not exported. Run 'pipx ensurepath' and start a new shell, or add that directory to PATH."
}

# --install-worker: the detached background job (never reached at SessionStart).
if [ "${1:-}" = "--install-worker" ]; then
  mkdir -p "$STATE_DIR"
  status=ok
  # The cause is persisted alongside the status: messages rendered FROM the
  # marker (notably the 24h backoff line) would otherwise fall back to the
  # generic install command and lose what the worker actually determined.
  cause=none
  if ! has_companion; then
    brew tap facebook/fb && { brew trust facebook/fb >/dev/null 2>&1 || true; } && brew install idb-companion || status=failed
  fi
  if [ "$(idb_client_state)" != ready ]; then
    if ! command -v pipx >/dev/null 2>&1; then
      brew install pipx && pipx ensurepath || status=failed
    fi
    if command -v pipx >/dev/null 2>&1; then
      # GH#578: never let pipx resolve the interpreter itself — it picks the
      # newest, which is exactly the one that produces a crashing client.
      # Walk the supported interpreters until one yields a healthy client.
      tried=""
      installed=""
      for py in $SUPPORTED_PYTHONS; do
        command -v "$py" >/dev/null 2>&1 || continue
        echo "installing fb-idb under $py"
        tried="$tried $py"
        pipx install --python "$py" --force fb-idb || continue
        installed=yes
        [ "$(idb_client_state)" = ready ] && break
      done
      # Four outcomes, derived from what the worker already knows: whether any
      # install ran (`installed`) and what the probe now reads. Only a client
      # that ran an install and still fails is genuinely terminal.
      final_state="$(idb_client_state)"
      if [ "$final_state" != ready ]; then
        if [ -n "$tried" ] && [ -z "$installed" ]; then
          # Every pinned install command itself failed (network, PyPI, pipx).
          # Transient, so it stays retryable.
          status=failed
          cause=install-failed
          echo "tried:$tried — every pinned install failed; retrying after backoff"
        elif [ -n "$installed" ] && [ "$final_state" = absent ]; then
          # The install worked; the shim just is not visible. Orthogonal to the
          # interpreter fingerprint, so it must never be terminal.
          status=failed
          cause=path-shim
          path_shim_explanation
        elif [ -n "$installed" ]; then
          # A pinned install succeeded and the client still fails to run.
          # Retrying cannot change that. A brew failure earlier in this run
          # stays `failed`: that one IS worth retrying.
          [ "$status" = failed ] || status=incompatible
          [ "$status" = failed ] || cause=client-unusable
          incompatible_explanation
          echo "tried:$tried — none produced a working client; the mirror stays on the simctl tier"
        else
          # No supported interpreter exists at all. The fingerprint re-arms this
          # as soon as one is installed.
          [ "$status" = failed ] || status=incompatible
          [ "$status" = failed ] || cause=no-interpreter
          echo "no supported Python found (need one of: $SUPPORTED_PYTHONS). Install one, then re-run: $(install_command)"
        fi
      fi
    else
      status=failed
    fi
  fi
  [ "$status" = failed ] && [ "$cause" = none ] && cause=install-error
  echo "$status $(date +%s) $(python_fingerprint) $cause" > "$MARKER"
  rm -f "$PIDFILE"
  echo "ensure-idb worker finished: $status"
  exit 0
fi

# Foreground path — bounded: checks + at most one detached spawn.
CLIENT_STATE="$(idb_client_state)"

if [ "$CLIENT_STATE" = ready ] && has_companion; then
  # A previous verdict no longer describes reality — clear it so a future
  # break re-arms the full repair path.
  rm -f "$MARKER"
  echo "idb available: screen mirroring uses the fast path (idb video-stream)"
  exit 0
fi

if [ -f "$MARKER" ]; then
  read -r LAST_STATUS LAST_TS LAST_FP LAST_CAUSE < "$MARKER" 2>/dev/null || LAST_STATUS=""
fi

# The incompatible verdict outranks every other branch while the client is
# actually broken: that is the one state where an install hint is actively
# wrong (GH#578). It holds until the set of installed interpreters changes;
# delete "$MARKER" to force a retry. A verdict may never contradict the live
# probe — a client that now reads ready or absent falls through to the normal
# path so the missing piece (companion, or the client itself) still gets fixed.
if [ "$CLIENT_STATE" != ready ] && [ "${LAST_STATUS:-}" = "incompatible" ] && [ "${LAST_FP:-}" = "$(python_fingerprint)" ]; then
  # Terminal only for the two causes that retrying cannot change. The message
  # follows the live state, never the other state's story.
  if [ "$CLIENT_STATE" = broken ]; then
    incompatible_explanation
    echo "Recover with: $(install_command)"
  else
    echo "idb is not installed, and no supported Python is available to install it (need one of: $SUPPORTED_PYTHONS)."
    echo "Recover with: $(install_command)"
  fi
  echo "Not retrying until the installed Python interpreters change — delete $MARKER to force a retry (e.g. after a newer fb-idb ships). Log: $LOG. Mirroring stays on the ~6fps simctl tier."
  exit 0
fi

if [ "$CLIENT_STATE" = broken ]; then
  incompatible_explanation
  if ! command -v brew >/dev/null 2>&1; then
    echo "Recover with: $(install_command)"
    exit 0
  fi
elif ! command -v brew >/dev/null 2>&1; then
  if [ "$CLIENT_STATE" = ready ]; then
    echo "idb-companion not installed (the idb client works; the companion is the missing half)."
    echo "Install manually: $(companion_command)"
  else
    echo "idb not installed (optional — enables 20-30fps screen mirroring instead of ~6fps)."
    echo "Install manually: $(install_command)"
  fi
  exit 0
fi

mkdir -p "$STATE_DIR"

# A worker is already running — don't stack a second brew behind it.
if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "idb install in progress (background, log: $LOG)"
    exit 0
  fi
  rm -f "$PIDFILE"
fi

# A recent failed attempt backs off for 24h; success never re-enters here
# (the ready fast path above wins once a healthy client exists).
if [ "${LAST_STATUS:-}" = "failed" ] && [ -n "${LAST_TS:-}" ]; then
  NOW="$(date +%s)"
  if [ $((NOW - LAST_TS)) -lt "$BACKOFF_SECS" ]; then
    # This line is what the developer reads for the next 24h, so it must carry
    # the cause the worker determined rather than defaulting to an install
    # command that, for the shim case, already succeeded.
    if [ "${LAST_CAUSE:-}" = "path-shim" ]; then
      path_shim_explanation
      echo "Retrying the install after backoff anyway (log: $LOG)."
    elif [ "$CLIENT_STATE" = ready ]; then
      echo "idb-companion install failed recently — retrying after backoff (manual: $(companion_command), log: $LOG)"
    else
      echo "idb install failed recently — retrying after backoff (manual: $(install_command), log: $LOG)"
    fi
    exit 0
  fi
fi

# Only this path actually spawns, so the "repairing" claim belongs here — the
# pidfile and backoff guards above must not be preceded by a promise of work
# they then prevent.
if [ "$CLIENT_STATE" = absent ]; then
  NOTICE="idb missing — installing in background ($(install_command)). Log: $LOG"
elif [ "$CLIENT_STATE" = ready ]; then
  # The client already works; the worker's own guard skips pipx entirely here,
  # so promising an interpreter repair would describe work that never runs.
  NOTICE="idb-companion missing — installing it in background ($(companion_command)). Log: $LOG"
else
  NOTICE="Repairing in the background under a supported interpreter ($SUPPORTED_PYTHONS). Manual: $(install_command). Log: $LOG"
fi

if [ "${RN_AGENT_IDB_DRY_SPAWN:-}" = "1" ]; then
  echo "spawn --install-worker" >> "$STATE_DIR/spawn.log"
  echo "$NOTICE"
  exit 0
fi

nohup bash "$0" --install-worker >> "$LOG" 2>&1 < /dev/null &
WORKER_PID=$!
disown "$WORKER_PID" 2>/dev/null || true
echo "$WORKER_PID" > "$PIDFILE"
echo "$NOTICE"
exit 0
