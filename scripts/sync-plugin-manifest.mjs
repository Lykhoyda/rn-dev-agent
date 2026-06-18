#!/usr/bin/env node
// Post-`changeset version` hook: mirror the synthetic
// `.claude-plugin/package.json` version into the Claude Code plugin
// manifest (`.claude-plugin/plugin.json`) and the marketplace listing
// (`.claude-plugin/marketplace.json`).
//
// Why a synthetic package: changesets manages versions of npm packages,
// but the Claude Code plugin's version lives in plugin.json + marketplace.json,
// not in an npm package. The cheapest way to let changesets manage that
// version is to give it a fake-but-private npm package whose only job is
// to carry the version string. After `changeset version` bumps that
// package, this script reads the new version and writes it where the
// Claude Code marketplace actually looks.
//
// Run via `npm run version-packages` (which chains `changeset version` →
// this script → `sync-versions.sh --fix`).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);

const synthPkgPath = join(REPO_ROOT, ".claude-plugin", "package.json");
const pluginJsonPath = join(REPO_ROOT, ".claude-plugin", "plugin.json");
const marketplaceJsonPath = join(REPO_ROOT, ".claude-plugin", "marketplace.json");

const synth = JSON.parse(readFileSync(synthPkgPath, "utf-8"));
const newVersion = synth.version;
if (typeof newVersion !== "string" || !/^\d+\.\d+\.\d+/.test(newVersion)) {
  console.error(
    `sync-plugin-manifest: synthetic package .claude-plugin/package.json ` +
      `has invalid version ${JSON.stringify(newVersion)} — expected semver.`,
  );
  process.exit(1);
}

const plugin = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
const marketplace = JSON.parse(readFileSync(marketplaceJsonPath, "utf-8"));

const oldPluginVersion = plugin.version;
plugin.version = newVersion;
writeFileSync(pluginJsonPath, JSON.stringify(plugin, null, 2) + "\n", "utf-8");

// marketplace.json carries the version on `plugins[0].version` (per the
// marketplace schema — every entry is a plugin spec keyed by name).
const pluginEntry = (marketplace.plugins ?? []).find((p) => p.name === "rn-dev-agent");
if (!pluginEntry) {
  console.error(
    `sync-plugin-manifest: marketplace.json has no plugins[].name === 'rn-dev-agent' entry`,
  );
  process.exit(1);
}
const _oldMarketplaceVersion = pluginEntry.version;
pluginEntry.version = newVersion;
writeFileSync(marketplaceJsonPath, JSON.stringify(marketplace, null, 2) + "\n", "utf-8");

console.log(
  `sync-plugin-manifest: ${oldPluginVersion} → ${newVersion} ` + `(plugin.json + marketplace.json)`,
);
