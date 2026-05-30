#!/usr/bin/env bash
# Regression test for collect-feedback.sh redact() — must never leak secrets
# into the feedback JSON (B1: redact() previously failed OPEN on BSD/macOS sed
# because of an invalid bracket range, leaking tokens into a public GH issue).
#
# End-to-end: plant secrets in a fake CDP log, run the real script, assert the
# emitted JSON contains none of the raw secrets.
#
# Run: bash scripts/test/redact.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COLLECT="$SCRIPT_DIR/collect-feedback.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Secrets crafted to match each redaction pattern. The recognizable prefixes
# are assembled at runtime from a variable so this test file never contains a
# contiguous scannable secret (GitHub push-protection would otherwise block it);
# the runtime values are still full, valid-format strings for the redactor.
gh="ghp"; ak="AKIA"; sk="sk"
GH_TOKEN="${gh}_012345678901234567890123456789012345"
AWS_KEY="${ak}ABCDEFGHIJKLMNOP"
BEARER="Bearer abcdefghij1234567890ABCdef"
JWT="eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4"
SECRET="${sk}_live_abcdefghijklmnopqrstuvwxyz123"
EMAIL="leak@example.com"
PRIVATE_IP="192.168.1.50"

cat > "$tmp/cdp-bridge.log" <<EOF
[info] auth header Authorization: $BEARER
[info] github token $GH_TOKEN
[info] aws $AWS_KEY
[info] jwt $JWT
[info] api $SECRET
[info] contact $EMAIL from $PRIVATE_IP
EOF

out="$(CLAUDE_PLUGIN_DATA="$tmp" bash "$COLLECT" 2>/dev/null)"

fail=0
check_absent() {
  local label="$1" needle="$2"
  if printf '%s' "$out" | grep -qF -- "$needle"; then
    echo "FAIL: $label leaked into feedback output ('$needle')"
    fail=1
  else
    echo "ok: $label redacted"
  fi
}

check_absent "GitHub token" "$GH_TOKEN"
check_absent "AWS key" "$AWS_KEY"
check_absent "Bearer token body" "abcdefghij1234567890ABCdef"
check_absent "JWT" "eyJhbGciOiJIUzI1NiIs"
check_absent "API secret" "$SECRET"
check_absent "Email" "$EMAIL"
check_absent "Private IP" "$PRIVATE_IP"

# Output must still be valid JSON (fail-closed must not corrupt the envelope).
if printf '%s' "$out" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
  echo "ok: output is valid JSON"
else
  echo "FAIL: output is not valid JSON"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "PASS: redact.test.sh"
else
  echo "FAILED: redact.test.sh"
fi
exit "$fail"
