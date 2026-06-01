#!/usr/bin/env bash
# Capture hook must append a redacted JSONL record to .rn-agent/local/session-buffer.jsonl
# and must NOT leak raw secrets into it.
set -uo pipefail
HOOK="$(cd "$(dirname "$0")/../.." && pwd)/hooks/tool-use-failure.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo '{"name":"fixture"}' > "$tmp/package.json"   # project evidence so the capture guard fires

bear="Bearer"; tok="${bear} abcdefghij1234567890ABCdef"
keyed="Xy9Zq7Lm2Pw8Vt9abc"
payload=$(cat <<JSON
{"tool_name":"mcp__plugin_rn-dev-agent_cdp__cdp_status","cwd":"$tmp","tool_response":{"isError":true,"content":[{"text":"{\"ok\":false,\"error\":\"auth failed Authorization: $tok and client_secret=$keyed\"}"}]}}
JSON
)

echo "$payload" | bash "$HOOK" >/dev/null 2>&1

buf="$tmp/.rn-agent/local/session-buffer.jsonl"
test -f "$buf" || { echo "FAIL: buffer not created"; exit 1; }
grep -q '"tool":"cdp_status"' "$buf" || { echo "FAIL: tool name not recorded"; cat "$buf"; exit 1; }
if grep -q "abcdefghij1234567890ABCdef" "$buf"; then echo "FAIL: raw secret leaked into buffer"; exit 1; fi
if grep -q "$keyed" "$buf"; then echo "FAIL: keyed secret value leaked into buffer"; cat "$buf"; exit 1; fi
grep -q "client_secret=\[REDACTED_SECRET\]" "$buf" || { echo "FAIL: keyed rule did not redact-in-place (marker missing — regression of the \$1 misparse bug)"; cat "$buf"; exit 1; }
node -e "JSON.parse(require('fs').readFileSync('$buf','utf8').trim().split('\n').pop())" || { echo "FAIL: not valid JSON"; exit 1; }
echo "PASS troubleshooting-capture.test.sh"
