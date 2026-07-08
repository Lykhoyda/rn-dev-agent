#!/usr/bin/env node
// Post-`changeset version` hook: mirror the synthetic
// `packages/claude-plugin/package.json` version into the Claude Code plugin
// manifest (`packages/claude-plugin/plugin.json`), the Codex plugin manifest
// (`packages/codex-plugin/.codex-plugin/plugin.json`), the Codex MCP bootstrap
// version pin (`packages/codex-plugin/.mcp.json`), and the Claude marketplace
// listing (`packages/claude-plugin/marketplace.json`).
//
// Why a synthetic package: changesets manages versions of npm packages,
// but the agent plugin versions live in plugin manifests + marketplace.json,
// not in an npm package. The cheapest way to let changesets manage that
// version is to give it a fake-but-private npm package whose only job is
// to carry the version string. After `changeset version` bumps that
// package, this script reads the new version and writes it where Claude
// and Codex actually look.
//
// Run via `yarn version-packages` (which chains `changeset version` →
// this script → `sync-versions.sh --fix`).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);

const synthPkgPath = join(REPO_ROOT, 'packages', 'claude-plugin', 'package.json');
const claudePluginJsonPath = join(REPO_ROOT, 'packages', 'claude-plugin', 'plugin.json');
const claudePluginManifestPath = join(
  REPO_ROOT,
  'packages',
  'claude-plugin',
  '.claude-plugin',
  'plugin.json',
);
const codexPluginJsonPath = join(
  REPO_ROOT,
  'packages',
  'codex-plugin',
  '.codex-plugin',
  'plugin.json',
);
const codexMcpJsonPath = join(REPO_ROOT, 'packages', 'codex-plugin', '.mcp.json');
const marketplaceJsonPath = join(REPO_ROOT, 'packages', 'claude-plugin', 'marketplace.json');
const claudeMarketplaceManifestPath = join(
  REPO_ROOT,
  'packages',
  'claude-plugin',
  '.claude-plugin',
  'marketplace.json',
);
const rootMarketplaceManifestPath = join(REPO_ROOT, '.claude-plugin', 'marketplace.json');

const synth = JSON.parse(readFileSync(synthPkgPath, 'utf-8'));
const newVersion = synth.version;
if (typeof newVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(newVersion)) {
  console.error(
    `sync-plugin-manifest: package packages/claude-plugin/package.json ` +
      `has invalid version ${JSON.stringify(newVersion)} — expected semver.`,
  );
  process.exit(1);
}

const claudePlugin = JSON.parse(readFileSync(claudePluginJsonPath, 'utf-8'));
const claudePluginManifest = JSON.parse(readFileSync(claudePluginManifestPath, 'utf-8'));
const codexPlugin = JSON.parse(readFileSync(codexPluginJsonPath, 'utf-8'));
const codexMcp = JSON.parse(readFileSync(codexMcpJsonPath, 'utf-8'));
const marketplace = JSON.parse(readFileSync(marketplaceJsonPath, 'utf-8'));
const claudeMarketplaceManifest = JSON.parse(readFileSync(claudeMarketplaceManifestPath, 'utf-8'));
const rootMarketplaceManifest = JSON.parse(readFileSync(rootMarketplaceManifestPath, 'utf-8'));

const oldPluginVersion = claudePlugin.version;
claudePlugin.version = newVersion;
claudePluginManifest.version = newVersion;
codexPlugin.version = newVersion;
writeFileSync(claudePluginJsonPath, JSON.stringify(claudePlugin, null, 2) + '\n', 'utf-8');
writeFileSync(
  claudePluginManifestPath,
  JSON.stringify(claudePluginManifest, null, 2) + '\n',
  'utf-8',
);
writeFileSync(codexPluginJsonPath, JSON.stringify(codexPlugin, null, 2) + '\n', 'utf-8');

const codexBootstrap = codexMcp.mcpServers?.cdp?.args?.[1];
if (typeof codexBootstrap !== 'string') {
  console.error(`sync-plugin-manifest: Codex .mcp.json has no mcpServers.cdp.args[1] bootstrap`);
  process.exit(1);
}
const nextCodexBootstrap = codexBootstrap.replace(/const V='[^']+';/, `const V='${newVersion}';`);
if (nextCodexBootstrap === codexBootstrap && !codexBootstrap.includes(`const V='${newVersion}';`)) {
  console.error(`sync-plugin-manifest: Codex .mcp.json bootstrap has no const V='...' version pin`);
  process.exit(1);
}
codexMcp.mcpServers.cdp.args[1] = nextCodexBootstrap;
writeFileSync(codexMcpJsonPath, JSON.stringify(codexMcp, null, 2) + '\n', 'utf-8');

// marketplace.json carries the version on `plugins[0].version` (per the
// marketplace schema — every entry is a plugin spec keyed by name).
const pluginEntry = (marketplace.plugins ?? []).find((p) => p.name === 'rn-dev-agent');
const claudeManifestEntry = (claudeMarketplaceManifest.plugins ?? []).find(
  (p) => p.name === 'rn-dev-agent',
);
const rootManifestEntry = (rootMarketplaceManifest.plugins ?? []).find(
  (p) => p.name === 'rn-dev-agent',
);
for (const [label, entry] of [
  ['marketplace.json', pluginEntry],
  ['packages/claude-plugin/.claude-plugin/marketplace.json', claudeManifestEntry],
  ['.claude-plugin/marketplace.json', rootManifestEntry],
]) {
  if (!entry) {
    console.error(`sync-plugin-manifest: ${label} has no plugins[].name === 'rn-dev-agent' entry`);
    process.exit(1);
  }
}
const _oldMarketplaceVersion = pluginEntry.version;
pluginEntry.version = newVersion;
claudeManifestEntry.version = newVersion;
rootManifestEntry.version = newVersion;
writeFileSync(marketplaceJsonPath, JSON.stringify(marketplace, null, 2) + '\n', 'utf-8');
writeFileSync(
  claudeMarketplaceManifestPath,
  JSON.stringify(claudeMarketplaceManifest, null, 2) + '\n',
  'utf-8',
);
writeFileSync(
  rootMarketplaceManifestPath,
  JSON.stringify(rootMarketplaceManifest, null, 2) + '\n',
  'utf-8',
);

console.log(
  `sync-plugin-manifest: ${oldPluginVersion} → ${newVersion} ` +
    `(Claude manifests + Codex .codex-plugin/plugin.json + Codex .mcp.json + marketplace manifests)`,
);
