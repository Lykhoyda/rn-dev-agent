#!/usr/bin/env bash
# SessionStart hook must echo the troubleshooting doc when present in an RN project,
# and emit nothing extra when absent.
set -uo pipefail
HOOK="$(cd "$(dirname "$0")/../.." && pwd)/hooks/detect-rn-project.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# Minimal RN project so the hook's main branch runs.
echo '{"dependencies":{"react-native":"0.81.0"}}' > "$tmp/package.json"
echo '' > "$tmp/metro.config.js"
mkdir -p "$tmp/.rn-agent/local"
printf '## Troubleshooting\n### cdp_status flaky after reload\n- Fix: cdp_reload(full=true)\nUNIQUE_MARKER_42\n' > "$tmp/.rn-agent/local/troubleshooting.md"

out="$(cd "$tmp" && bash "$HOOK" 2>/dev/null)"
echo "$out" | grep -q "UNIQUE_MARKER_42" || { echo "FAIL: doc content not injected"; exit 1; }
echo "$out" | grep -q "Repo-local troubleshooting notes" || { echo "FAIL: injection header missing"; exit 1; }

# Absent doc → no injection header.
rm -rf "$tmp/.rn-agent"
out2="$(cd "$tmp" && bash "$HOOK" 2>/dev/null)"
echo "$out2" | grep -q "Repo-local troubleshooting notes" && { echo "FAIL: header present with no doc"; exit 1; }
echo "PASS troubleshooting-inject.test.sh"
