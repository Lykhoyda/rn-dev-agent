#!/usr/bin/env bash
# Regression test for GH#419 — MCP server registers zero tools after a
# mid-session plugin upgrade. The SessionStart hook must (1) recommend the
# cheap /mcp reconnect before a full Claude Code restart, (2) stop asserting
# a static "N MCP tools" count that can't reflect actual registration, and
# (3) probe the supervisor lockfile so a live bridge from a PREVIOUS plugin
# install is called out explicitly.
#
# Run: bash scripts/test/mcp-upgrade-notice.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail=0
ok() { echo "ok: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

tmp="$(mktemp -d)"
DECOY_PIDS=()
cleanup() {
  for p in "${DECOY_PIDS[@]:-}"; do kill "$p" 2>/dev/null; done
  rm -rf "$tmp"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Sandbox: copy the hook + probe into an isolated plugin root with stubbed
# ensure-* scripts so the test never runs installers or touches the network.
# ---------------------------------------------------------------------------
SANDBOX="$tmp/plugin"
mkdir -p "$SANDBOX/hooks" "$SANDBOX/scripts" "$SANDBOX/.claude-plugin"
cp "$REPO_ROOT/hooks/detect-rn-project.sh" "$SANDBOX/hooks/"
cp "$REPO_ROOT/scripts/mcp-bridge-probe.mjs" "$SANDBOX/scripts/" 2>/dev/null \
  || { echo "FAIL: scripts/mcp-bridge-probe.mjs missing"; exit 1; }
echo '{"version":"9.9.9"}' > "$SANDBOX/.claude-plugin/plugin.json"
for s in ensure-cdp-deps ensure-maestro-runner ensure-idb-companion \
         ensure-ffmpeg ensure-troubleshooting-doc ensure-android-ready; do
  printf '#!/bin/bash\nexit 0\n' > "$SANDBOX/scripts/$s.sh"
done

# Fake RN project so the hook's main branch runs.
PROJ="$tmp/proj"
mkdir -p "$PROJ"
echo '{"dependencies":{"react-native":"0.81.0"}}' > "$PROJ/package.json"
echo '' > "$PROJ/metro.config.js"

# Isolated TMPDIR: both the hook's last-version file and the probe's
# os.tmpdir()-based lock path resolve here.
FAKE_TMP="$tmp/tmpdir"
mkdir -p "$FAKE_TMP"

run_hook() {
  (cd "$PROJ" && TMPDIR="$FAKE_TMP" CLAUDE_USER_CWD="$PROJ" \
    bash "$SANDBOX/hooks/detect-rn-project.sh" 2>/dev/null)
}

# Uses the SANDBOX copy — the same file the sandboxed hook executes.
run_probe() { # $1=plugin-root $2=upgraded
  (cd "$PROJ" && TMPDIR="$FAKE_TMP" CLAUDE_USER_CWD="$PROJ" \
    node "$SANDBOX/scripts/mcp-bridge-probe.mjs" --plugin-root "$1" --upgraded "$2" 2>/dev/null)
}

# Lock path computed exactly as the bridge's lockfile.ts computes it.
LOCK_PATH="$(TMPDIR="$FAKE_TMP" node -e '
  const { createHash } = require("node:crypto");
  const os = require("node:os"); const path = require("node:path");
  const root = path.resolve(process.argv[1]);
  const hash = createHash("md5").update(root).digest("hex").slice(0, 8);
  console.log(path.join(os.tmpdir(), `rn-dev-agent-cdp-${os.userInfo().uid}-${hash}.lock`));
' "$PROJ")"

write_lock() { # $1=pid [$2=extra JSON fields, e.g. ',"ppid":1']
  printf '{"pid":%s,"projectRoot":"%s","startedAt":%s,"version":"0.53.0"%s}\n' \
    "$1" "$PROJ" "$(date +%s)000" "${2:-}" > "$LOCK_PATH"
}

# Runs in the parent shell (no command substitution) so DECOY_PIDS survives
# for cleanup and the spawned node stays a waitable child. Sets $DECOY_PID.
spawn_decoy() { # $1=fake supervisor path
  node -e 'setInterval(() => {}, 1000)' "$1" >/dev/null 2>&1 &
  DECOY_PID=$!
  DECOY_PIDS+=("$DECOY_PID")
}

# ---------------------------------------------------------------------------
# 1. Upgrade notice recommends /mcp reconnect first, restart second.
# ---------------------------------------------------------------------------
echo "0.0.1" > "$FAKE_TMP/rn-dev-agent-last-version"
out="$(run_hook)"

notice_line="$(echo "$out" | grep "NOTICE: rn-dev-agent upgraded" || true)"
echo "$notice_line" | grep -q "from v0.0.1 to v9.9.9" \
  && ok "upgrade notice fires with both versions" \
  || bad "upgrade notice missing or malformed"
echo "$notice_line" | grep -q "/mcp" \
  && ok "upgrade notice recommends /mcp reconnect" \
  || bad "upgrade notice does not mention /mcp reconnect"
echo "$out" | grep -q "If MCP tools fail, restart Claude Code to reinitialize MCP servers." \
  && bad "old restart-first advice still present" \
  || ok "restart is no longer the primary advice"

# ---------------------------------------------------------------------------
# 2. Banner: no static tool count; states the plugin version; self-check line.
# Asserted on a NON-upgrade run so the NOTICE text can't satisfy the greps.
# ---------------------------------------------------------------------------
out="$(run_hook)"
echo "$out" | grep -qE "[0-9]+ MCP tools" \
  && bad "banner still asserts a static MCP tool count" \
  || ok "banner no longer asserts a static tool count"
echo "$out" | grep -q "plugin v9.9.9 is active" \
  && ok "banner states the installed plugin version" \
  || bad "banner missing the plugin version"
echo "$out" | grep -A2 "ToolSearch finds no cdp_" | grep -q "reconnect the" \
  && ok "banner tells the agent the /mcp reconnect recovery path" \
  || bad "banner missing the missing-tools self-check advice"

# Live-holder cases identify the bridge via `ps -o args=`; skip them where ps
# is unavailable/redacted (restricted sandboxes) rather than fail spuriously.
if ! ps -p $$ -o args= >/dev/null 2>&1; then
  echo "skip: ps unusable in this environment — live-holder probe cases not run"
  exit $fail
fi

# ---------------------------------------------------------------------------
# 3. Probe: live bridge from a PREVIOUS install → explicit stale warning.
# ---------------------------------------------------------------------------
spawn_decoy "/fake-old-root/scripts/cdp-bridge/dist/supervisor.js"
stale_pid="$DECOY_PID"
write_lock "$stale_pid"
pout="$(run_probe "$SANDBOX" 0)"
echo "$pout" | grep -q "different plugin install" \
  && ok "probe flags a stale bridge (even without an upgrade this session)" \
  || bad "probe did not flag the stale bridge"
echo "$pout" | grep -q "$stale_pid" \
  && ok "stale warning names the holder PID" \
  || bad "stale warning missing the holder PID"
echo "$pout" | grep -q "/mcp" \
  && ok "stale warning advises /mcp reconnect" \
  || bad "stale warning missing /mcp advice"

# Integration: the hook itself surfaces the probe's stale warning.
hout="$(run_hook)"
echo "$hout" | grep -q "different plugin install" \
  && ok "hook surfaces the probe stale warning" \
  || bad "hook did not surface the probe stale warning"

# ---------------------------------------------------------------------------
# 4. Probe: live bridge from the CURRENT install → healthy.
# ---------------------------------------------------------------------------
mkdir -p "$SANDBOX/scripts/cdp-bridge/dist"
spawn_decoy "$SANDBOX/scripts/cdp-bridge/dist/supervisor.js"
current_pid="$DECOY_PID"
write_lock "$current_pid"
pout="$(run_probe "$SANDBOX" 1)"
echo "$pout" | grep -q "current install" \
  && ok "probe confirms a current-install bridge after an upgrade" \
  || bad "probe missing the current-install confirmation"
echo "$pout" | grep -q "different plugin install" \
  && bad "probe false-positives a current-install bridge as stale" \
  || ok "no stale false positive for a current-install bridge"
pout="$(run_probe "$SANDBOX" 0)"
[ -z "$pout" ] \
  && ok "healthy bridge with no upgrade → probe stays silent" \
  || bad "probe is noisy on a healthy no-upgrade session: $pout"

# Space-containing install path must NOT be reported stale (\S-regex can't
# span spaces; the exact-containment current-install check must catch it).
SPACE_ROOT="$tmp/plug in root"
mkdir -p "$SPACE_ROOT/scripts/cdp-bridge/dist"
spawn_decoy "$SPACE_ROOT/scripts/cdp-bridge/dist/supervisor.js"
write_lock "$DECOY_PID"
pout="$(run_probe "$SPACE_ROOT" 1)"
echo "$pout" | grep -q "different plugin install" \
  && bad "current-install bridge under a space-containing path reported stale" \
  || ok "no stale false positive for a space-containing install path"
echo "$pout" | grep -q "current install" \
  && ok "space-containing current install still confirmed after upgrade" \
  || bad "space-containing current install not recognized"
# Foreign holder with a space directly before /scripts (regex-unparsable path)
# must still be flagged stale — the verdict uses suffix containment, not the
# path parse.
spawn_decoy "$tmp/old ver/scripts/cdp-bridge/dist/supervisor.js"
write_lock "$DECOY_PID"
pout="$(run_probe "$SANDBOX" 0)"
echo "$pout" | grep -q "different plugin install" \
  && ok "space-containing FOREIGN install still flagged stale" \
  || bad "space-containing foreign install evaded the stale warning"
write_lock "$current_pid"

# Hook-level: an upgrade run must pass --upgraded=1 through to the probe,
# surfacing the current-install confirmation in the hook output.
echo "0.0.2" > "$FAKE_TMP/rn-dev-agent-last-version"
hout="$(run_hook)"
echo "$hout" | grep -q "current install" \
  && ok "hook passes the upgrade flag to the probe (confirmation surfaces)" \
  || bad "hook did not propagate --upgraded to the probe"

# ---------------------------------------------------------------------------
# 5. Probe: lock absent or holder dead → conditional advice only on upgrade.
# ---------------------------------------------------------------------------
rm -f "$LOCK_PATH"
pout="$(run_probe "$SANDBOX" 1)"
echo "$pout" | grep -q "reconnect" \
  && ok "absent lock + upgrade → conditional /mcp advice" \
  || bad "absent lock + upgrade printed no advice"
pout="$(run_probe "$SANDBOX" 0)"
[ -z "$pout" ] \
  && ok "absent lock + no upgrade → probe stays silent (startup race)" \
  || bad "probe is noisy on a normal session start: $pout"

# Dead-holder PID from a self-exiting child (never kill a just-forked child:
# on macOS bash 3.2 the signal can fire the parent's EXIT trap in a subshell,
# wiping $tmp mid-test).
node -e '' >/dev/null 2>&1 &
dead_decoy=$!
wait "$dead_decoy" 2>/dev/null
write_lock "$dead_decoy"
pout="$(run_probe "$SANDBOX" 1)"
echo "$pout" | grep -q "reconnect" \
  && ok "dead holder + upgrade → conditional /mcp advice" \
  || bad "dead holder + upgrade printed no advice"
echo "$pout" | grep -q "different plugin install" \
  && bad "dead holder wrongly reported as live stale bridge" \
  || ok "dead holder not reported as a live stale bridge"

# ---------------------------------------------------------------------------
# 6. Fail-open branches: holders lockfile.ts would reclaim must never warn.
# ---------------------------------------------------------------------------
# (a) Live PID whose argv is NOT a bridge (PID reuse) → treated as no blocker.
node -e 'setInterval(() => {}, 1000)' >/dev/null 2>&1 &
DECOY_PID=$!
DECOY_PIDS+=("$DECOY_PID")
write_lock "$DECOY_PID"
pout="$(run_probe "$SANDBOX" 0)"
[ -z "$pout" ] \
  && ok "live non-bridge holder (PID reuse) → silent without upgrade" \
  || bad "live non-bridge holder produced output: $pout"
pout="$(run_probe "$SANDBOX" 1)"
echo "$pout" | grep -q "different plugin install" \
  && bad "live non-bridge holder wrongly reported stale" \
  || ok "live non-bridge holder not reported stale"
echo "$pout" | grep -q "reconnect" \
  && ok "live non-bridge holder + upgrade → conditional /mcp advice" \
  || bad "live non-bridge holder + upgrade printed no advice"

# (b) Heartbeat-stale bridge holder (wedged — lockfile.ts would reclaim).
spawn_decoy "/fake-old-root/scripts/cdp-bridge/dist/supervisor.js"
write_lock "$DECOY_PID" ",\"lastHeartbeat\":$(( ($(date +%s) - 300) * 1000 ))"
pout="$(run_probe "$SANDBOX" 0)"
echo "$pout" | grep -q "different plugin install" \
  && bad "heartbeat-stale (reclaimable) holder wrongly reported stale" \
  || ok "heartbeat-stale holder treated as reclaimable, no warning"

# (c) Orphaned bridge holder (recorded ppid != live ppid — reclaimable).
spawn_decoy "/fake-old-root/scripts/cdp-bridge/dist/supervisor.js"
write_lock "$DECOY_PID" ",\"lastHeartbeat\":$(date +%s)000,\"ppid\":1"
pout="$(run_probe "$SANDBOX" 0)"
echo "$pout" | grep -q "different plugin install" \
  && bad "orphaned (ppid-changed) holder wrongly reported stale" \
  || ok "orphaned holder treated as reclaimable, no warning"

# (d) Lock file older than 24h (abandoned) — lockfile.ts max-age reclaim.
spawn_decoy "/fake-old-root/scripts/cdp-bridge/dist/supervisor.js"
write_lock "$DECOY_PID"
touch -t 202001010000 "$LOCK_PATH"
pout="$(run_probe "$SANDBOX" 0)"
echo "$pout" | grep -q "different plugin install" \
  && bad ">24h-old lock (reclaimable) wrongly reported stale" \
  || ok ">24h-old lock treated as reclaimable, no warning"

# (e) Legacy lock (no ppid) held by an init-orphaned process → reclaimable.
# Only asserted when the orphan actually reparented to PID 1 (platform-dependent).
orphan_pid=$( (node -e 'setInterval(() => {}, 1000)' "/fake-old-root/scripts/cdp-bridge/dist/supervisor.js" >/dev/null 2>&1 & echo $!) )
DECOY_PIDS+=("$orphan_pid")
live_ppid="$(ps -p "$orphan_pid" -o ppid= 2>/dev/null | tr -d ' ')"
if [ "$live_ppid" = "1" ]; then
  write_lock "$orphan_pid"
  pout="$(run_probe "$SANDBOX" 0)"
  echo "$pout" | grep -q "different plugin install" \
    && bad "init-orphaned legacy-lock holder wrongly reported stale" \
    || ok "init-orphaned legacy-lock holder treated as reclaimable"
else
  echo "skip: orphan reparented to $live_ppid (not 1) — legacy-orphan case not asserted"
fi

# (f) Fresh-heartbeat, same-ppid holder still warns (true positive intact).
spawn_decoy "/fake-old-root/scripts/cdp-bridge/dist/supervisor.js"
write_lock "$DECOY_PID" ",\"lastHeartbeat\":$(date +%s)000,\"ppid\":$$"
pout="$(run_probe "$SANDBOX" 0)"
echo "$pout" | grep -q "different plugin install" \
  && ok "healthy surviving old-install holder still warns (true positive)" \
  || bad "true-positive stale warning lost after reclaimability checks: $pout"

exit $fail
