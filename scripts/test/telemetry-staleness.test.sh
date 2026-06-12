#!/usr/bin/env bash
# Regression test for collect-feedback.sh telemetry staleness (GH #266).
#
# The per-tool-call telemetry writer was removed with the Experience Engine
# (GH #200, commit 3beb8e52, 2026-06-01), but collect-feedback.sh kept reading
# the orphaned ~/.claude/rn-agent/telemetry/*.jsonl files and presented
# weeks-old events as "recent" in filed feedback issues. The collector must
# cross-check the newest event's age against now and report honestly:
#   - fresh (<24h, legacy writer still active) → telemetry_status "ok" + events
#   - stale (>=24h)                            → "stale (...)" + NO events
#   - absent (no dir / no files)               → "none" + NO events
#
# End-to-end: fake $HOME with planted telemetry files, run the real script,
# assert on the emitted JSON.
#
# Run: bash scripts/test/telemetry-staleness.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COLLECT="$SCRIPT_DIR/collect-feedback.sh"

fail=0

# jq-free JSON assertions via python3 (already a hard dependency of the script).
get_field() { # $1=json $2=python expr over `d`
  printf '%s' "$1" | python3 -c "import json,sys; d=json.load(sys.stdin); print($2)" 2>/dev/null
}

run_collect() { # $1=fake home
  HOME="$1" CLAUDE_PLUGIN_DATA="$1/plugin-data" bash "$COLLECT" 2>/dev/null
}

# make_home runs inside $(...) subshells, so cleanup state can't be
# accumulated there — the trap references the parent-scope home vars instead
# (":-" keeps `set -u` happy for homes not yet created at failure time).
trap 'rm -rf "${home1:-}" "${home2:-}" "${home3:-}" "${home4:-}" "${home5:-}"' EXIT

make_home() {
  local h
  h="$(mktemp -d)"
  mkdir -p "$h/plugin-data"
  printf '%s' "$h"
}

check() { # $1=label $2=actual $3=expected-prefix
  case "$2" in
    "$3"*) echo "ok: $1 ($2)";;
    *) echo "FAIL: $1 — expected prefix '$3', got '$2'"; fail=1;;
  esac
}

# ── Case 1: stale telemetry (the GH #266 repro) ─────────────────────
home1="$(make_home)"
tdir1="$home1/.claude/rn-agent/telemetry"
mkdir -p "$tdir1"
cat > "$tdir1/2026-05-31-session-1234.jsonl" <<'EOF'
{"ts":"2026-05-31T18:44:32.560Z","event":"tool_call","tool":"cdp_status","result":"PASS","latency_ms":1,"phase":"tool"}
EOF
# Backdate mtime far past the 24h threshold (portable across BSD/GNU touch).
touch -t 202605311844 "$tdir1/2026-05-31-session-1234.jsonl"

out1="$(run_collect "$home1")"
status1="$(get_field "$out1" "d.get('telemetry_status','<missing>')")"
count1="$(get_field "$out1" "len(d.get('recent_telemetry_lines',['sentinel']))")"
check "stale: telemetry_status flags staleness" "$status1" "stale"
check "stale: status names the age in days" "$status1" "stale (last event"
check "stale: old events are NOT shipped as recent" "$count1" "0"

# ── Case 2: no telemetry at all (fresh install post-#200) ───────────
home2="$(make_home)"
out2="$(run_collect "$home2")"
status2="$(get_field "$out2" "d.get('telemetry_status','<missing>')")"
count2="$(get_field "$out2" "len(d.get('recent_telemetry_lines',['sentinel']))")"
check "none: telemetry_status reports none" "$status2" "none"
check "none: no events shipped" "$count2" "0"

# ── Case 3: fresh telemetry (legacy writer still active) ────────────
home3="$(make_home)"
tdir3="$home3/.claude/rn-agent/telemetry"
mkdir -p "$tdir3"
cat > "$tdir3/current-session.jsonl" <<'EOF'
{"ts":"2026-06-12T12:00:00.000Z","event":"tool_call","tool":"cdp_status","result":"PASS","latency_ms":2,"phase":"tool"}
EOF
# mtime = now (just written) → fresh.

out3="$(run_collect "$home3")"
status3="$(get_field "$out3" "d.get('telemetry_status','<missing>')")"
count3="$(get_field "$out3" "len(d.get('recent_telemetry_lines',[]))")"
check "fresh: telemetry_status ok" "$status3" "ok"
check "fresh: events ARE shipped" "$count3" "1"

# ── Case 4: telemetry dir exists but is EMPTY (manual cleanup) ──────
# Pre-existing hazard surfaced in the #266 review: the unmatched glob made
# `ls` fail and, under `set -euo pipefail`, killed the WHOLE collector —
# /send-feedback got zero JSON. Must degrade to status "none" instead.
home4="$(make_home)"
mkdir -p "$home4/.claude/rn-agent/telemetry"
out4="$(run_collect "$home4")"
status4="$(get_field "$out4" "d.get('telemetry_status','<missing>')")"
check "empty dir: collector survives and reports none" "$status4" "none"

# ── Case 5: future mtime (clock skew / filesystem restore) ──────────
# A negative age must never count as fresh (it would ship stale events).
home5="$(make_home)"
tdir5="$home5/.claude/rn-agent/telemetry"
mkdir -p "$tdir5"
cat > "$tdir5/skewed-session.jsonl" <<'EOF'
{"ts":"2031-01-01T00:00:00.000Z","event":"tool_call","tool":"cdp_status","result":"PASS","latency_ms":3,"phase":"tool"}
EOF
touch -t 203101010000 "$tdir5/skewed-session.jsonl"
out5="$(run_collect "$home5")"
status5="$(get_field "$out5" "d.get('telemetry_status','<missing>')")"
count5="$(get_field "$out5" "len(d.get('recent_telemetry_lines',['sentinel']))")"
check "future mtime: not treated as fresh" "$status5" "stale"
check "future mtime: no events shipped" "$count5" "0"

if [ "$fail" -ne 0 ]; then
  echo "telemetry-staleness.test.sh: FAILURES"
  exit 1
fi
echo "telemetry-staleness.test.sh: all assertions passed"
