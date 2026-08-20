#!/usr/bin/env node
// GH #382 follow-up: decide what .github/workflows/runner-artifacts.yml must
// publish for a release, and where the in-repo trust root is delivered.
//
// The pre-existing gate keyed only on release-asset presence. Because the
// manifest asset is uploaded BEFORE the repository commit, a failed commit left
// the release "complete" and every later run reported success while
// runner-manifest.json stayed pinned to an old version (v0.75.2 while the plugin
// shipped v0.76.7 — every client then resolved provenance 'build-local').
// Publication state therefore has TWO halves, and both are checked here. The
// release half is checked against the assets' own server-reported SHA-256, never
// against the manifest asset alone, which is only a copy of the trust root.
//
// Usage (CI):
//   node scripts/runner-manifest-publication.mts \
//     --plugin-version 0.76.7 [--force-version ''] \
//     --release-assets assets.json \
//     --repo-manifest runner-manifest.json \
//     --published-manifest published-manifest.json

import { readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// force_version is operator input that reaches `gh release`, git refs and a
// branch name. Only exact SemVer releases pass, so a typo fails closed instead of
// minting a persistent nonsensical tag or branch: `1.2.3-alpha..1`, `1.2.3-alpha.`,
// `01.2.3` and `1.2.3-01` are all rejected.
const NUMERIC = '0|[1-9]\\d*';
const PRERELEASE_ID = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const VERSION_RE = new RegExp(
  `^(?:${NUMERIC})\\.(?:${NUMERIC})\\.(?:${NUMERIC})(?:-${PRERELEASE_ID}(?:\\.${PRERELEASE_ID})*)?$`,
);

export function assertVersion(version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(`not a release version: ${JSON.stringify(version)}`);
  }
  return version;
}

export function expectedRunnerAssets(version) {
  assertVersion(version);
  return {
    ios: `rn-fast-runner-${version}-sim.zip`,
    android: `rn-android-runner-${version}.zip`,
    manifest: 'runner-manifest.json',
  };
}

export function manifestBranchName(version) {
  return `chore/runner-manifest-v${assertVersion(version)}`;
}

function parseManifest(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Key order must not decide publication: two manifests that differ only in
// property order describe the same trust root, and treating them as different
// would re-open a PR on every sweep forever.
// Release assets may be given as bare names or as the {name, digest, size}
// records `gh release view --json assets` returns; a bare name simply carries no
// evidence about the bytes served.
function indexReleaseAssets(list) {
  const byName = new Map();
  for (const entry of list ?? []) {
    if (typeof entry === 'string') byName.set(entry, { name: entry });
    else if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
      byName.set(entry.name, entry);
    }
  }
  return byName;
}

const ASSET_DIGEST_RE = /^(?:sha256:)?([0-9a-f]{64})$/i;

function assetDigest(asset) {
  const match = ASSET_DIGEST_RE.exec(typeof asset.digest === 'string' ? asset.digest.trim() : '');
  return match ? match[1].toLowerCase() : null;
}

function manifestAssets(manifest) {
  const assets = manifest && typeof manifest === 'object' ? manifest.assets : null;
  return ['ios', 'android'].flatMap((platform) =>
    Array.isArray(assets?.[platform]) ? assets[platform] : [],
  );
}

// The manifest asset published on a release is only a COPY of the trust root, so
// comparing the two says nothing about the zips the release actually serves. A
// zip re-uploaded with --clobber by a build job whose sibling failed (publication
// is then skipped) leaves both manifests equal while the release serves bytes the
// client verifies against a digest they no longer have — and it silently falls
// back to a local build. Missing assets are left to the build check; only an
// asset that IS there and disagrees counts as drift.
function driftedAsset(manifest, byName) {
  for (const entry of manifestAssets(manifest)) {
    if (!entry || typeof entry.name !== 'string') continue;
    const asset = byName.get(entry.name);
    if (!asset) continue;
    const digest = assetDigest(asset);
    if (digest && typeof entry.sha256 === 'string' && digest !== entry.sha256.toLowerCase()) {
      return entry.name;
    }
    if (
      typeof asset.size === 'number' &&
      typeof entry.bytes === 'number' &&
      asset.size !== entry.bytes
    ) {
      return entry.name;
    }
  }
  return null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

export function decideRunnerPublication(input) {
  const raw = typeof input.forceVersion === 'string' ? input.forceVersion.trim() : '';
  const forced = raw !== '';
  const version = assertVersion(input.pluginVersion);
  // Every job builds from current source, so a forced HISTORICAL version would
  // upload today's binaries under an old tag and rewrite the repository trust
  // root to a version the installed plugin no longer matches — which sends every
  // client back to the local build. force_version may only re-publish the
  // current version; it still skips the missing-assets check, which is its point.
  if (forced && assertVersion(raw) !== version) {
    throw new Error(
      `force_version ${raw} does not match the current plugin version ${version}: ` +
        'runner artifacts are built from current source, so a historical version ' +
        'would publish binaries that never belonged to that release',
    );
  }
  const expected = expectedRunnerAssets(version);
  const byName = indexReleaseAssets(input.releaseAssets);
  const missingZip = !(byName.has(expected.ios) && byName.has(expected.android));

  const repo = parseManifest(input.repoManifest);
  const published = parseManifest(input.publishedManifest);
  // Only the in-repo manifest is beyond reach: it lives on protected main. The
  // manifest ASSET is an ordinary release asset, writable by anything holding
  // contents: write — the same permission needed to swap a zip — so it is
  // evidence ONLY while main has nothing to say about this version. Once main
  // vouches for v<version>, it is the authority and the asset is not.
  const trustRootIsCurrent = repo !== null && repo.version === version;
  const attested = trustRootIsCurrent ? repo : published;
  const drifted = attested === null ? null : driftedAsset(attested, byName);
  // Moving the trust root takes a merged pull request, so a rebuild here cannot
  // settle the disagreement: main would still name the old bytes on the next
  // sweep, which would rebuild again and rewrite the pull request it is waiting
  // on. Stop instead, and let force_version deliver one rebuild and one PR.
  if (drifted !== null && trustRootIsCurrent && !forced) {
    throw new Error(
      `release v${version} serves a ${drifted} that runner-manifest.json on main does not vouch ` +
        'for. Re-hashing it would move the trust root onto bytes this workflow did not build, and ' +
        'rebuilding would move it onto bytes no merged pull request has approved yet. Find out why ' +
        `the release assets changed, then dispatch this workflow with force_version=${version} to ` +
        'rebuild both runners from source and deliver a single trust-root pull request.',
    );
  }
  // Before main vouches for this version there is no trust root to protect, so a
  // release serving bytes this workflow never published is repaired by rebuilding
  // both runners from source rather than by re-hashing what is served.
  const buildRunners = forced || missingZip || drifted !== null;

  let publishManifest = true;
  let reason;
  if (forced) {
    reason = `forced republication of v${version}`;
  } else if (drifted !== null) {
    reason =
      `release v${version} serves a ${drifted} this workflow did not publish — ` +
      'rebuilding both runners from source rather than trusting it';
  } else if (missingZip) {
    reason = `release v${version} is missing a runner zip`;
  } else if (repo === null) {
    reason = 'the in-repo runner-manifest.json is missing or unparseable';
  } else if (repo.version !== version) {
    reason = `the in-repo trust root is stale (v${repo.version} != v${version})`;
  } else if (published === null) {
    reason = `release v${version} carries no runner-manifest.json asset`;
  } else if (canonical(repo) !== canonical(published)) {
    reason = `the in-repo trust root differs from the manifest published for v${version}`;
  } else {
    publishManifest = false;
    reason = `the in-repo trust root already matches v${version}`;
  }

  return { version, buildRunners, publishManifest, reason, branch: manifestBranchName(version) };
}

function readIfPresent(path) {
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

// The workflow writes this file as `gh release view --json assets` JSON. A
// listing that cannot be read as an array of assets fails the run rather than
// degrading to "the release carries nothing", which would silently rebuild.
function parseReleaseAssets(text) {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) throw new Error('release asset listing is not a JSON array');
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const decision = decideRunnerPublication({
    pluginVersion: args['plugin-version'],
    forceVersion: args['force-version'],
    releaseAssets: parseReleaseAssets(readIfPresent(args['release-assets'])),
    repoManifest: readIfPresent(args['repo-manifest']),
    publishedManifest: readIfPresent(args['published-manifest']),
  });
  const lines = [
    `version=${decision.version}`,
    `build=${decision.buildRunners}`,
    `publish=${decision.publishManifest}`,
    `branch=${decision.branch}`,
  ];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  console.log(decision.reason);
  console.log(lines.join('\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
