#!/usr/bin/env bash
# Syncs marketplace.json version from plugin.json (source of truth).
# Run as: pre-commit hook, CI check, or manual `./scripts/sync-versions.sh`
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_JSON="$REPO_ROOT/.claude-plugin/plugin.json"
MARKETPLACE_JSON="$REPO_ROOT/.claude-plugin/marketplace.json"

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
