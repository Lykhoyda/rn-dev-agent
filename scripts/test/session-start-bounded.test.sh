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

# 2. Execute the network installer with a curl test double and inspect the
# arguments passed across that executable boundary.
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM
mkdir -p "$TEST_DIR/bin"
cat > "$TEST_DIR/bin/curl" << 'EOF'
#!/usr/bin/env bash
printf '%s\0' "$@" > "$CURL_ARGS_FILE"
exit 28
EOF
chmod +x "$TEST_DIR/bin/curl"

if PATH="$TEST_DIR/bin:$PATH" \
  CURL_ARGS_FILE="$TEST_DIR/curl-args" \
  RN_DEV_AGENT_RUNNER_CACHE="$TEST_DIR/cache" \
  RN_DEV_AGENT_UNAME_S=Darwin \
  RN_DEV_AGENT_UNAME_M=arm64 \
  RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL=https://example.invalid/maestro-runner.tar.gz \
  bash "$REPO_ROOT/scripts/ensure-maestro-runner.sh" > "$TEST_DIR/output" 2>&1
then
  bad "ensure-maestro-runner.sh: expected the simulated download to fail"
fi

if python3 - "$TEST_DIR/curl-args" << 'EOF'
from pathlib import Path
import sys

args = [arg.decode() for arg in Path(sys.argv[1]).read_bytes().split(b"\0") if arg]

def positive_timeout(name):
    if name in args:
        index = args.index(name)
        value = args[index + 1] if index + 1 < len(args) else ""
    else:
        prefix = f"{name}="
        value = next((arg[len(prefix):] for arg in args if arg.startswith(prefix)), "")
    try:
        return float(value) > 0
    except ValueError:
        return False

download_url = "https://example.invalid/maestro-runner.tar.gz"
sys.exit(
    0
    if download_url in args
    and positive_timeout("--connect-timeout")
    and positive_timeout("--max-time")
    else 1
)
EOF
then
  ok "ensure-maestro-runner.sh: download uses positive connect and total timeouts"
else
  bad "ensure-maestro-runner.sh: download is not bounded by positive connect and total timeouts"
fi

exit $fail
