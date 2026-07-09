#!/usr/bin/env bash
# Regression test for require-changeset.sh — the CI guard that fails a PR which
# changes shippable MCP source (packages/rn-dev-agent-core/src/) without a changeset.
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
CHANGED_FILES=$'packages/rn-dev-agent-core/src/domain/maestro-validator.ts' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "src change without changeset fails" 1 $?

# 2. shippable src changed, but changeset bumps ONLY rn-dev-agent-core -> MUST fail.
# rn-dev-agent-core is the internal package; it ships to users only via the plugin
# manifest, which is bumped by a rn-dev-agent-plugin changeset. A core-only bump
# leaves plugin.json/marketplace.json pinned, so the change never reaches installs
# (the #361/#363 delivery-gap that this guard now closes).
printf -- '---\n"rn-dev-agent-core": patch\n---\nfix\n' > "$tmp/.changeset/brave-lions.md"
CHANGED_FILES=$'packages/rn-dev-agent-core/src/domain/maestro-validator.ts' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "src change with core-only changeset fails (no plugin bump)" 1 $?
rm -f "$tmp/.changeset/brave-lions.md"

# 2b. shippable src changed, changeset bumps rn-dev-agent-plugin -> passes
printf -- '---\n"rn-dev-agent-plugin": minor\n---\nship it\n' > "$tmp/.changeset/keen-otters.md"
CHANGED_FILES=$'packages/rn-dev-agent-core/src/domain/maestro-validator.ts' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "src change with rn-dev-agent-plugin changeset passes" 0 $?
rm -f "$tmp/.changeset/keen-otters.md"

# 2c. shippable src changed, changeset bumps BOTH cdp + plugin (the ideal) -> passes
printf -- '---\n"rn-dev-agent-core": patch\n"rn-dev-agent-plugin": patch\n---\nfix + ship\n' > "$tmp/.changeset/wise-pandas.md"
CHANGED_FILES=$'packages/rn-dev-agent-core/src/domain/maestro-validator.ts' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "src change with core+plugin changeset passes" 0 $?
rm -f "$tmp/.changeset/wise-pandas.md"

# 2d. core-only FRONTMATTER, but the BODY merely mentions rn-dev-agent-plugin -> MUST fail.
# The guard must parse frontmatter package keys, not scan the whole file — else a
# release note that name-drops the plugin would falsely satisfy the manifest-bump
# requirement (Codex PR #364 P1).
printf -- '---\n"rn-dev-agent-core": patch\n---\nNote: a future change should also add "rn-dev-agent-plugin": patch to ship it.\n' > "$tmp/.changeset/sly-foxes.md"
CHANGED_FILES=$'packages/rn-dev-agent-core/src/domain/maestro-validator.ts' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "src change with core-only changeset mentioning plugin in BODY fails" 1 $?
rm -f "$tmp/.changeset/sly-foxes.md"

# 2e. shippable src changed, plugin key uses valid YAML SINGLE quotes -> passes
# (Codex PR #364 P2: must accept 'rn-dev-agent-plugin' as well as "rn-dev-agent-plugin").
printf -- "---\n'rn-dev-agent-plugin': patch\n---\nship\n" > "$tmp/.changeset/glad-bats.md"
CHANGED_FILES=$'packages/rn-dev-agent-core/src/domain/maestro-validator.ts' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "src change with single-quoted plugin changeset passes" 0 $?
rm -f "$tmp/.changeset/glad-bats.md"

# 3. only non-shippable changes (tests / docs / CI) -> passes without a changeset
CHANGED_FILES=$'packages/rn-dev-agent-core/test/unit/x.test.js\napps/docs-site/foo.mdx\n.github/workflows/ci.yml' \
  REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "non-src change without changeset passes" 0 $?

# 4. empty diff -> passes
CHANGED_FILES="" REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
check "empty diff passes" 0 $?

if [ "$fail" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
