#!/usr/bin/env bash
# Regression test for GH#252/B196 — SessionStart must be bounded. The hook runs
# installers (npm install, curl | bash) on fresh machines; without an explicit
# hook timeout and curl time limits, a stalled CDN blocks every session start
# and the install is silently re-attempted each session.
#
# Run: bash scripts/test/session-start-bounded.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail=0
ok() { echo "ok: $1"; }
bad() { echo "FAIL: $1"; fail=1; }

# 1. Every SessionStart hook entry declares an explicit timeout.
if python3 - "$REPO_ROOT/packages/claude-plugin/hooks/hooks.json" << 'EOF'
import json, sys
h = json.load(open(sys.argv[1]))["hooks"]
entries = [hh for e in h.get("SessionStart", []) for hh in e["hooks"]]
sys.exit(0 if entries and all(isinstance(hh.get("timeout"), (int, float)) and hh["timeout"] > 0 for hh in entries) else 1)
EOF
then ok "hooks.json: SessionStart entries declare a timeout"
else bad "hooks.json: SessionStart entry missing an explicit timeout"; fi

# 2. The network installer the SessionStart path reaches must bound its curl.
CURL_LINE="$(grep -E '^\s*if curl .*open\.devicelab\.dev' "$REPO_ROOT/scripts/ensure-maestro-runner.sh" || true)"
if [ -z "$CURL_LINE" ]; then
  bad "ensure-maestro-runner.sh: expected install curl line not found (pattern drift?)"
else
  case "$CURL_LINE" in
    *--max-time*) ok "ensure-maestro-runner.sh: curl bounded with --max-time" ;;
    *) bad "ensure-maestro-runner.sh: install curl has no --max-time (can hang on a stalled CDN)" ;;
  esac
  case "$CURL_LINE" in
    *--connect-timeout*) ok "ensure-maestro-runner.sh: curl bounded with --connect-timeout" ;;
    *) bad "ensure-maestro-runner.sh: install curl has no --connect-timeout" ;;
  esac
fi

exit $fail
