#!/usr/bin/env bash
# Syncs marketplace.json version from plugin.json (source of truth) and
# guards against hardcoded version literals drifting in TypeScript source.
# Run as: pre-commit hook, CI check, or manual `./scripts/sync-versions.sh`
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_JSON="$REPO_ROOT/.claude-plugin/plugin.json"
MARKETPLACE_JSON="$REPO_ROOT/.claude-plugin/marketplace.json"
MCP_PACKAGE_JSON="$REPO_ROOT/scripts/cdp-bridge/package.json"
MCP_SRC_DIR="$REPO_ROOT/scripts/cdp-bridge/src"

plugin_version=$(grep '"version"' "$PLUGIN_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
marketplace_version=$(grep '"version"' "$MARKETPLACE_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')

if [ "$plugin_version" != "$marketplace_version" ]; then
  if [ "${1:-}" = "--fix" ]; then
    sed -i '' "s/\"version\": \"$marketplace_version\"/\"version\": \"$plugin_version\"/" "$MARKETPLACE_JSON"
    echo "synced marketplace.json version: $marketplace_version → $plugin_version"
  else
    echo "ERROR: version mismatch — plugin.json=$plugin_version marketplace.json=$marketplace_version"
    echo "Run: ./scripts/sync-versions.sh --fix"
    exit 1
  fi
else
  echo "versions in sync: $plugin_version"
fi

# B110 guard — detect hardcoded `version: '...'` literals in TypeScript source.
# The MCP server version must come from package.json at runtime, never a literal.
if [ -d "$MCP_SRC_DIR" ]; then
  # Match `version: '...'` or `version: "..."` where the value is a semver-ish literal.
  hardcoded=$(grep -rn -E "version:\s*['\"][0-9]+\.[0-9]+\.[0-9]+" "$MCP_SRC_DIR" 2>/dev/null || true)
  if [ -n "$hardcoded" ]; then
    echo "ERROR: hardcoded version literal found in src/ (B110 regression)"
    echo "$hardcoded"
    echo "Fix: read version from package.json at module load instead."
    exit 1
  fi
fi
