#!/usr/bin/env bash
# Syncs marketplace.json version from plugin.json (source of truth) and
# guards against hardcoded version literals drifting in TypeScript source.
# Run as: pre-commit hook, CI check, or manual `./scripts/sync-versions.sh`
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_JSON="$REPO_ROOT/.claude-plugin/plugin.json"
MARKETPLACE_JSON="$REPO_ROOT/.claude-plugin/marketplace.json"
SYNTHETIC_PKG_JSON="$REPO_ROOT/.claude-plugin/package.json"
MCP_SRC_DIR="$REPO_ROOT/scripts/cdp-bridge/src"
# NOTE: scripts/cdp-bridge/package.json (rn-dev-agent-cdp) is NOT synced here.
# It is an INDEPENDENTLY-versioned changeset package (changeset config has
# fixed:[]/linked:[]), so its version legitimately differs from the plugin's.
# A prior MCP_PACKAGE_JSON variable here was declared but never used and implied
# a sync that must not happen — removed to avoid that false impression. The MCP
# server reads its own version from this file at runtime; keep it bumped via a
# `rn-dev-agent-cdp` changeset entry whenever cdp-bridge/src changes.

plugin_version=$(grep '"version"' "$PLUGIN_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
marketplace_version=$(grep '"version"' "$MARKETPLACE_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
synth_version=$(grep '"version"' "$SYNTHETIC_PKG_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')

# Three-way sync: .claude-plugin/package.json (the changesets-managed
# source of truth) → plugin.json → marketplace.json. The post-version
# script in npm run version-packages does the bumping; this script is the
# guard that catches drift if anyone edits a version by hand.
mismatch=""
if [ "$plugin_version" != "$synth_version" ]; then
  mismatch="plugin.json=$plugin_version synthetic-pkg=$synth_version"
fi
if [ "$marketplace_version" != "$synth_version" ]; then
  if [ -n "$mismatch" ]; then mismatch="$mismatch "; fi
  mismatch="${mismatch}marketplace.json=$marketplace_version synthetic-pkg=$synth_version"
fi

if [ -n "$mismatch" ]; then
  if [ "${1:-}" = "--fix" ]; then
    # synthetic-pkg is the source of truth; rewrite the other two.
    sed -i '' "s/\"version\": \"$plugin_version\"/\"version\": \"$synth_version\"/" "$PLUGIN_JSON"
    sed -i '' "s/\"version\": \"$marketplace_version\"/\"version\": \"$synth_version\"/" "$MARKETPLACE_JSON"
    echo "synced plugin.json + marketplace.json → $synth_version"
  else
    echo "ERROR: version mismatch — $mismatch"
    echo "Run: ./scripts/sync-versions.sh --fix"
    echo "(or use \`npm run version-packages\` from repo root to bump via changesets)"
    exit 1
  fi
else
  echo "versions in sync: $synth_version"
fi

# B110 guard — detect hardcoded `version: '...'` literals in TypeScript source.
# The MCP server version must come from package.json at runtime, never a literal.
# Exemption: domain/engine-pin.ts holds the maestro-runner PIN (GH #397) — a
# deliberate third-party version literal, kept honest by its own shell<->TS
# sync test (gh-397-pin-sync.test.ts), not a plugin-version bake.
if [ -d "$MCP_SRC_DIR" ]; then
  # Match `version: '...'` or `version: "..."` where the value is a semver-ish literal.
  # --exclude-dir=node_modules: observability/web vendors its node_modules under
  # src/ — a long-standing local-only false positive (CI never checks them out).
  hardcoded=$(grep -rn -E "version:\s*['\"][0-9]+\.[0-9]+\.[0-9]+" "$MCP_SRC_DIR" --exclude=engine-pin.ts --exclude-dir=node_modules 2>/dev/null || true)
  if [ -n "$hardcoded" ]; then
    echo "ERROR: hardcoded version literal found in src/ (B110 regression)"
    echo "$hardcoded"
    echo "Fix: read version from package.json at module load instead."
    exit 1
  fi
fi
