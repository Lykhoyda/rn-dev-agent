#!/usr/bin/env node
// GH #382 (Story 01): generate runner-manifest.json — the SHA-256 + byte count of
// each prebuilt runner zip for the release being cut. The client (runner-artifacts.ts)
// reads this committed manifest offline as its trust root before downloading and
// verifying the release assets.
//
// Usage (CI, after building the zips):
//   node scripts/build-runner-manifest.mts \
//     --version 0.62.3 \
//     --ios path/to/rn-fast-runner-0.62.3-sim.zip \
//     --android path/to/rn-android-runner-0.62.3.zip \
//     --xcode-build-version 15.4 \
//     --out runner-manifest.json

import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export function hashAsset(filePath) {
  const buf = readFileSync(filePath);
  return {
    name: basename(filePath),
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: statSync(filePath).size,
  };
}

export function assembleManifest({ version, xcodeBuildVersion, iosZip, androidZip }) {
  const manifest = { version, assets: { ios: [], android: [] } };
  if (xcodeBuildVersion) manifest.xcodeBuildVersion = xcodeBuildVersion;
  if (iosZip) manifest.assets.ios.push(hashAsset(iosZip));
  if (androidZip) manifest.assets.android.push(hashAsset(androidZip));
  return manifest;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) {
    console.error(
      'usage: build-runner-manifest.mts --version <v> [--ios <zip>] [--android <zip>] ' +
        '[--xcode-build-version <v>] [--out <path>]',
    );
    process.exit(1);
  }
  const manifest = assembleManifest({
    version: args.version,
    xcodeBuildVersion: args['xcode-build-version'],
    iosZip: args.ios,
    androidZip: args.android,
  });
  const out = args.out ?? 'runner-manifest.json';
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(
    `wrote ${out} (ios: ${manifest.assets.ios.length}, android: ${manifest.assets.android.length})`,
  );
}

// Run main only when executed directly, so tests can import the pure helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
