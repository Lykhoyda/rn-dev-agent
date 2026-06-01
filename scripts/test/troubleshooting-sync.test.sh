#!/usr/bin/env bash
# Stop hook gate logic: emit a decision:block synthesis instruction exactly once
# per session, only when the buffer has new entries.
set -uo pipefail
HOOK="$(cd "$(dirname "$0")/../.." && pwd)/hooks/troubleshooting-sync.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.rn-agent/local"
buf="$tmp/.rn-agent/local/session-buffer.jsonl"

run() { echo "$1" | bash "$HOOK" 2>/dev/null; }

# Case A: no buffer → no block (empty output)
out="$(run "{\"cwd\":\"$tmp\",\"session_id\":\"s1\",\"stop_hook_active\":false}")"
[ -z "$out" ] || { echo "FAIL A: expected no output, got: $out"; exit 1; }

# Case B: buffer with entries, fresh session → emits decision:block
echo '{"ts":"t","tool":"cdp_status","diagnostic":"d","error":"e","cwd":"x"}' >> "$buf"
out="$(run "{\"cwd\":\"$tmp\",\"session_id\":\"s1\",\"stop_hook_active\":false}")"
echo "$out" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(j.decision==="block"&&/troubleshooting.md/.test(j.reason)?0:1)' \
  || { echo "FAIL B: expected decision:block referencing troubleshooting.md, got: $out"; exit 1; }

# Case C: sentinel now present (same session) → no second block
out="$(run "{\"cwd\":\"$tmp\",\"session_id\":\"s1\",\"stop_hook_active\":false}")"
[ -z "$out" ] || { echo "FAIL C: expected no re-fire after sentinel, got: $out"; exit 1; }

# Case D: stop_hook_active=true → never block (loop guard), even with new entries + new session
echo '{"ts":"t2","tool":"x","diagnostic":"d","error":"e","cwd":"x"}' >> "$buf"
out="$(run "{\"cwd\":\"$tmp\",\"session_id\":\"s2\",\"stop_hook_active\":true}")"
[ -z "$out" ] || { echo "FAIL D: expected no block when stop_hook_active, got: $out"; exit 1; }

echo "PASS troubleshooting-sync.test.sh"
