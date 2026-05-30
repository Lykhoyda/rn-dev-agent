#!/usr/bin/env bash
# Regression test for require-changeset.sh — the CI guard that fails a PR which
# changes shippable MCP source (scripts/cdp-bridge/src/) without a changeset.
# Without this guard a behavior fix merges to main unversioned and is
# undeliverable to marketplace installs (GH #189 / v0.44.45 post-mortem: #188
# shipped the runFlow fix with no version bump, so users never got it).
#
# Run: bash scripts/test/require-changeset.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$SCRIPT_DIR/require-changeset.sh"

fail=0
check() { # description expected_exit actual_exit
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 — expected exit $2, got $3"
    fail=1
  fi
}

# Fake repo root with a .changeset/ dir holding only README (= "no changeset").
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.changeset"
echo "# changesets readme" > "$tmp/.changeset/README.md"

# 1. shippable src changed, NO changeset -> MUST fail (the #188/#189 case)
CHANGED_FILES=$'scripts/cdp-bridge/src/domain/maestro-validator.ts' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "src change without changeset fails" 1 $?

# 2. shippable src changed, changeset present -> passes
printf -- '---\n"rn-dev-agent-cdp": patch\n---\nfix\n' > "$tmp/.changeset/brave-lions.md"
CHANGED_FILES=$'scripts/cdp-bridge/src/domain/maestro-validator.ts' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "src change with changeset passes" 0 $?
rm -f "$tmp/.changeset/brave-lions.md"

# 3. only non-shippable changes (tests / docs / CI) -> passes without a changeset
CHANGED_FILES=$'scripts/cdp-bridge/test/unit/x.test.js\ndocs-site/foo.mdx\n.github/workflows/ci.yml' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "non-src change without changeset passes" 0 $?

# 4. empty diff -> passes
CHANGED_FILES="" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "empty diff passes" 0 $?

if [ "$fail" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
