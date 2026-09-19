#!/usr/bin/env bash
# Regression for sync-versions.sh --fix: GNU sed treats `sed -i '' expr file`
# as `can't read <expr>` and exits 2. version-packages runs --fix on Ubuntu
# before build:host-runtimes, and the generated Codex copies this PR compares
# now enter that fixer (GH #1037 Codex P1).
#
# Run: bash scripts/test/sync-versions.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$SCRIPT_DIR/sync-versions.sh"

fail=0
check() {
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 — expected exit $2, got $3"
    fail=1
  fi
}

if sed --version >/dev/null 2>&1; then
  probe="$(mktemp)"
  printf '%s\n' '{"version": "1.0.8"}' > "$probe"
  set +e
  sed -i '' 's/"version": "1.0.8"/"version": "1.2.3"/' "$probe" >/dev/null 2>&1
  bsd_exit=$?
  set -e
  rm -f "$probe"
  check "GNU sed -i '' exits 2 (the old fixer)" 2 "$bsd_exit"
else
  echo "ok: skip GNU sed -i '' probe (not GNU sed)"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p \
  "$tmp/packages/claude-plugin/.claude-plugin" \
  "$tmp/packages/claude-plugin/.codex-plugin" \
  "$tmp/packages/claude-plugin/.cursor-plugin" \
  "$tmp/packages/codex-plugin/.codex-plugin" \
  "$tmp/packages/rn-dev-agent-core" \
  "$tmp/.claude-plugin" \
  "$tmp/.cursor-plugin"

plugin_json='{"name": "rn-dev-agent", "version": "1.0.8"}'
marketplace_json='{"plugins": [{"name": "rn-dev-agent", "version": "1.0.8"}]}'
mcp_json='{"mcpServers": {"cdp": {"command": "node", "args": ["-e", "const V='"'"'1.0.8'"'"';process.stdout.write(V);"]}}}'

printf '%s\n' '{"name": "rn-dev-agent-plugin", "version": "1.2.3"}' > "$tmp/packages/claude-plugin/package.json"
printf '%s\n' "$plugin_json" > "$tmp/packages/claude-plugin/plugin.json"
printf '%s\n' "$plugin_json" > "$tmp/packages/claude-plugin/.claude-plugin/plugin.json"
printf '%s\n' "$plugin_json" > "$tmp/packages/claude-plugin/.cursor-plugin/plugin.json"
printf '%s\n' "$plugin_json" > "$tmp/packages/codex-plugin/.codex-plugin/plugin.json"
printf '%s\n' "$plugin_json" > "$tmp/packages/claude-plugin/.codex-plugin/plugin.json"
printf '%s\n' "$mcp_json" > "$tmp/packages/codex-plugin/.mcp.json"
printf '%s\n' "$mcp_json" > "$tmp/packages/claude-plugin/codex.mcp.json"
printf '%s\n' "$marketplace_json" > "$tmp/packages/claude-plugin/marketplace.json"
printf '%s\n' "$marketplace_json" > "$tmp/packages/claude-plugin/.claude-plugin/marketplace.json"
printf '%s\n' "$marketplace_json" > "$tmp/.claude-plugin/marketplace.json"
printf '%s\n' "$marketplace_json" > "$tmp/.cursor-plugin/marketplace.json"
printf '%s\n' '{"name": "rn-dev-agent-core", "version": "4.5.6"}' > "$tmp/packages/rn-dev-agent-core/package.json"
printf '%s\n' '{"name": "rn-dev-agent-core", "version": "4.5.6", "lockfileVersion": 3, "packages": {"": {"name": "rn-dev-agent-core", "version": "4.5.6"}}}' > "$tmp/packages/rn-dev-agent-core/package-lock.json"

set +e
out="$(REPO_ROOT="$tmp" bash "$GUARD" --fix 2>&1)"
fix_exit=$?
set -e
check "GNU sed --fix with stale generated Codex copies exits 0" 0 "$fix_exit"

if node --input-type=commonjs - "$tmp" <<'NODE'
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.argv[2];
const manifest = JSON.parse(readFileSync(join(root, 'packages/claude-plugin/.codex-plugin/plugin.json'), 'utf8'));
assert.equal(manifest.version, '1.2.3');
const mcp = JSON.parse(readFileSync(join(root, 'packages/claude-plugin/codex.mcp.json'), 'utf8'));
assert.equal(mcp.mcpServers.cdp.command, 'node');
const result = spawnSync(process.execPath, mcp.mcpServers.cdp.args, { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.equal(result.stdout, '1.2.3');
NODE
then
  echo "ok: --fix rewrote the generated Codex copies to the synthetic version"
else
  echo "FAIL: generated Codex manifest or executable bootstrap version is invalid"
  printf '%s\n' "$out"
  fail=1
fi

if [ -e "$tmp/packages/codex-plugin/rn-dev-agent-core" ]; then
  echo "FAIL: --fix created a second host runtime under packages/codex-plugin"
  fail=1
else
  echo "ok: --fix did not create a second host runtime"
fi

set +e
REPO_ROOT="$tmp" bash "$GUARD" >/dev/null 2>&1
sync_exit=$?
set -e
check "fixture is in sync after --fix" 0 "$sync_exit"

exit $fail
