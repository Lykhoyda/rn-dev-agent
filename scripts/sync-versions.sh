#!/usr/bin/env bash
# Syncs agent plugin manifest versions from the synthetic package source of truth
# and guards against hardcoded version literals drifting in TypeScript source.
# Run as: pre-commit hook, CI check, or manual `./scripts/sync-versions.sh`
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_JSON="$REPO_ROOT/packages/claude-plugin/plugin.json"
CLAUDE_PLUGIN_MANIFEST_JSON="$REPO_ROOT/packages/claude-plugin/.claude-plugin/plugin.json"
CODEX_PLUGIN_JSON="$REPO_ROOT/packages/codex-plugin/.codex-plugin/plugin.json"
CODEX_MCP_JSON="$REPO_ROOT/packages/codex-plugin/.mcp.json"
MARKETPLACE_JSON="$REPO_ROOT/packages/claude-plugin/marketplace.json"
CLAUDE_MARKETPLACE_MANIFEST_JSON="$REPO_ROOT/packages/claude-plugin/.claude-plugin/marketplace.json"
ROOT_MARKETPLACE_MANIFEST_JSON="$REPO_ROOT/.claude-plugin/marketplace.json"
SYNTHETIC_PKG_JSON="$REPO_ROOT/packages/claude-plugin/package.json"
MCP_SRC_DIR="$REPO_ROOT/packages/rn-dev-agent-core/src"
# NOTE: packages/rn-dev-agent-core/package.json (rn-dev-agent-core) is NOT synced here.
# It is an INDEPENDENTLY-versioned changeset package (changeset config has
# fixed:[]/linked:[]), so its version legitimately differs from the plugin's.
# A prior MCP_PACKAGE_JSON variable here was declared but never used and implied
# a sync that must not happen — removed to avoid that false impression. The MCP
# server reads its own version from this file at runtime; keep it bumped via a
# `rn-dev-agent-core` changeset entry whenever cdp-bridge/src changes.

plugin_version=$(grep '"version"' "$PLUGIN_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
claude_plugin_manifest_version=$(grep '"version"' "$CLAUDE_PLUGIN_MANIFEST_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
codex_plugin_version=$(grep '"version"' "$CODEX_PLUGIN_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
codex_mcp_version=$(grep -o "const V='[0-9][^']*'" "$CODEX_MCP_JSON" | head -1 | sed "s/const V='\([^']*\)'/\1/")
marketplace_version=$(grep '"version"' "$MARKETPLACE_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
claude_marketplace_manifest_version=$(grep '"version"' "$CLAUDE_MARKETPLACE_MANIFEST_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
root_marketplace_manifest_version=$(grep '"version"' "$ROOT_MARKETPLACE_MANIFEST_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
synth_version=$(grep '"version"' "$SYNTHETIC_PKG_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')

# Manifest sync: packages/claude-plugin/package.json (the changesets-managed
# source of truth) -> Claude plugin.json / Codex .codex-plugin/plugin.json / marketplace.json. The post-version
# script in yarn version-packages does the bumping; this script is the
# guard that catches drift if anyone edits a version by hand.
mismatch=""
if [ "$plugin_version" != "$synth_version" ]; then
  mismatch="plugin.json=$plugin_version synthetic-pkg=$synth_version"
fi
if [ "$claude_plugin_manifest_version" != "$synth_version" ]; then
  if [ -n "$mismatch" ]; then mismatch="$mismatch "; fi
  mismatch="${mismatch}claude-plugin/.claude-plugin/plugin.json=$claude_plugin_manifest_version synthetic-pkg=$synth_version"
fi
if [ "$codex_plugin_version" != "$synth_version" ]; then
  if [ -n "$mismatch" ]; then mismatch="$mismatch "; fi
  mismatch="${mismatch}codex-plugin.json=$codex_plugin_version synthetic-pkg=$synth_version"
fi
if [ "$marketplace_version" != "$synth_version" ]; then
  if [ -n "$mismatch" ]; then mismatch="$mismatch "; fi
  mismatch="${mismatch}marketplace.json=$marketplace_version synthetic-pkg=$synth_version"
fi
if [ "$claude_marketplace_manifest_version" != "$synth_version" ]; then
  if [ -n "$mismatch" ]; then mismatch="$mismatch "; fi
  mismatch="${mismatch}claude-plugin/.claude-plugin/marketplace.json=$claude_marketplace_manifest_version synthetic-pkg=$synth_version"
fi
if [ "$root_marketplace_manifest_version" != "$synth_version" ]; then
  if [ -n "$mismatch" ]; then mismatch="$mismatch "; fi
  mismatch="${mismatch}.claude-plugin/marketplace.json=$root_marketplace_manifest_version synthetic-pkg=$synth_version"
fi
if [ "$codex_mcp_version" != "$synth_version" ]; then
  if [ -n "$mismatch" ]; then mismatch="$mismatch "; fi
  mismatch="${mismatch}.mcp.json bootstrap=$codex_mcp_version synthetic-pkg=$synth_version"
fi

if [ -n "$mismatch" ]; then
  if [ "${1:-}" = "--fix" ]; then
    # synthetic-pkg is the source of truth; rewrite the generated manifests.
    sed -i '' "s/\"version\": \"$plugin_version\"/\"version\": \"$synth_version\"/" "$PLUGIN_JSON"
    sed -i '' "s/\"version\": \"$claude_plugin_manifest_version\"/\"version\": \"$synth_version\"/" "$CLAUDE_PLUGIN_MANIFEST_JSON"
    sed -i '' "s/\"version\": \"$codex_plugin_version\"/\"version\": \"$synth_version\"/" "$CODEX_PLUGIN_JSON"
    if [ -n "$codex_mcp_version" ]; then
      sed -i '' "s/const V='$codex_mcp_version'/const V='$synth_version'/" "$CODEX_MCP_JSON"
    fi
    sed -i '' "s/\"version\": \"$marketplace_version\"/\"version\": \"$synth_version\"/" "$MARKETPLACE_JSON"
    sed -i '' "s/\"version\": \"$claude_marketplace_manifest_version\"/\"version\": \"$synth_version\"/" "$CLAUDE_MARKETPLACE_MANIFEST_JSON"
    sed -i '' "s/\"version\": \"$root_marketplace_manifest_version\"/\"version\": \"$synth_version\"/" "$ROOT_MARKETPLACE_MANIFEST_JSON"
    echo "synced Claude manifests + Codex .codex-plugin/plugin.json + Codex .mcp.json + marketplace manifests -> $synth_version"
  else
    echo "ERROR: version mismatch — $mismatch"
    echo "Run: ./scripts/sync-versions.sh --fix"
    echo "(or use \`yarn version-packages\` from repo root to bump via changesets)"
    exit 1
  fi
else
  echo "versions in sync: $synth_version"
fi

# GH#441 — the core package-lock.json ships to users (ensure-cdp-deps.sh copies
# it next to package.json for `npm install --production`), so its version fields
# must track the core package.json that changesets bumps. Only the two version
# fields are rewritten here: a version bump does not change dependency
# resolutions. Dependency-RANGE drift is deliberately not fixable by this
# script — the gh441 unit tripwire catches it and demands a real regeneration.
CORE_PKG_JSON="$REPO_ROOT/packages/rn-dev-agent-core/package.json"
CORE_LOCK_JSON="$REPO_ROOT/packages/rn-dev-agent-core/package-lock.json"
if [ -f "$CORE_LOCK_JSON" ]; then
  core_version=$(node -e "console.log(require('$CORE_PKG_JSON').version)")
  lock_version=$(node -e "const l=require('$CORE_LOCK_JSON');console.log(l.version + ' ' + (l.packages?.['']?.version ?? ''))")
  if [ "$lock_version" != "$core_version $core_version" ]; then
    if [ "${1:-}" = "--fix" ]; then
      node -e "
        const fs = require('fs');
        const lock = JSON.parse(fs.readFileSync('$CORE_LOCK_JSON', 'utf8'));
        lock.version = '$core_version';
        if (lock.packages && lock.packages['']) lock.packages[''].version = '$core_version';
        fs.writeFileSync('$CORE_LOCK_JSON', JSON.stringify(lock, null, 2) + '\n');
      "
      echo "synced rn-dev-agent-core package-lock.json version fields -> $core_version"
    else
      echo "ERROR: version mismatch — rn-dev-agent-core package-lock.json=$lock_version package.json=$core_version"
      echo "Run: ./scripts/sync-versions.sh --fix"
      exit 1
    fi
  fi
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
