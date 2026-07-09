#!/usr/bin/env bash
# ensure-idb.sh — background auto-install of idb for the observe live mirror.
#
# The mirror's iOS fast path is `idb video-stream` (20-30fps MJPEG); without
# idb it degrades to a ~6fps `simctl screenshot` loop. idb needs two pieces
# (idb-companion lives in the facebook/fb tap, not homebrew-core):
#   brew tap facebook/fb && brew install idb-companion   (the macOS daemon)
#   pipx install fb-idb                                   (the Python CLI client)
#
# SessionStart contract (GH#252/B196: session start must be BOUNDED): this
# script's foreground path only does `command -v` checks and (at most) spawns
# ONE detached worker — it NEVER runs brew/pipx inline. The worker is
# nohup'd + disown'd with all stdio detached so the SessionStart hook's
# timeout cannot be held open by inherited FDs.
#
# Re-entry guards:
#   - pidfile:      a live worker is never duplicated across session starts
#   - last-attempt: a failed install is not retried for 24h (brew failures
#     are usually environmental; hammering it every session start is noise)
#
# Test seams (scripts/test/ensure-idb.test.sh):
#   RN_AGENT_IDB_STATE_DIR   state dir      (default: ~/.rn-dev-agent/idb)
#   RN_AGENT_IDB_UNAME       fake `uname -s`
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

OS="${RN_AGENT_IDB_UNAME:-$(uname -s)}"
[ "$OS" = "Darwin" ] || exit 0

# Homebrew has shipped the companion under both spellings across versions;
# ensure-idb-companion.sh accepts both, so this script must too — otherwise
# hyphen-name installs are reported missing and the worker respawns forever.
has_companion() {
  command -v idb_companion >/dev/null 2>&1 || command -v idb-companion >/dev/null 2>&1
}

# --install-worker: the detached background job (never reached at SessionStart).
if [ "${1:-}" = "--install-worker" ]; then
  mkdir -p "$STATE_DIR"
  status=ok
  if ! has_companion; then
    brew tap facebook/fb && brew install idb-companion || status=failed
  fi
  if ! command -v idb >/dev/null 2>&1; then
    if ! command -v pipx >/dev/null 2>&1; then
      brew install pipx && pipx ensurepath || status=failed
    fi
    if command -v pipx >/dev/null 2>&1; then
      pipx install fb-idb || status=failed
    else
      status=failed
    fi
  fi
  echo "$status $(date +%s)" > "$MARKER"
  rm -f "$PIDFILE"
  echo "ensure-idb worker finished: $status"
  exit 0
fi

# Foreground path — bounded: checks + at most one detached spawn.
if command -v idb >/dev/null 2>&1 && has_companion; then
  echo "idb available: screen mirroring uses the fast path (idb video-stream)"
  exit 0
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "idb not installed (optional — enables 20-30fps screen mirroring instead of ~6fps)."
  echo "Install manually: brew tap facebook/fb && brew install idb-companion && pipx install fb-idb"
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
# (the command -v fast path above wins once binaries exist).
if [ -f "$MARKER" ]; then
  read -r LAST_STATUS LAST_TS < "$MARKER" 2>/dev/null || LAST_STATUS=""
  NOW="$(date +%s)"
  if [ "$LAST_STATUS" = "failed" ] && [ -n "${LAST_TS:-}" ] && [ $((NOW - LAST_TS)) -lt "$BACKOFF_SECS" ]; then
    echo "idb install failed recently — retrying after backoff (manual: brew tap facebook/fb && brew install idb-companion && pipx install fb-idb, log: $LOG)"
    exit 0
  fi
fi

if [ "${RN_AGENT_IDB_DRY_SPAWN:-}" = "1" ]; then
  echo "spawn --install-worker" >> "$STATE_DIR/spawn.log"
  echo "idb missing — installing in background (brew tap facebook/fb && brew install idb-companion && pipx install fb-idb). Log: $LOG"
  exit 0
fi

nohup bash "$0" --install-worker >> "$LOG" 2>&1 < /dev/null &
WORKER_PID=$!
disown "$WORKER_PID" 2>/dev/null || true
echo "$WORKER_PID" > "$PIDFILE"
echo "idb missing — installing in background (brew tap facebook/fb && brew install idb-companion && pipx install fb-idb). Log: $LOG"
exit 0
