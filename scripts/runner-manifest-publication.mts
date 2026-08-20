#!/usr/bin/env node
// GH #382 follow-up: decide what .github/workflows/runner-artifacts.yml must
// publish for a release, and where the in-repo trust root is delivered.
//
// The pre-existing gate keyed only on release-asset presence. Because the
// manifest asset is uploaded BEFORE the repository commit, a failed commit left
// the release "complete" and every later run reported success while
// runner-manifest.json stayed pinned to an old version (v0.75.2 while the plugin
// shipped v0.76.7 — every client then resolved provenance 'build-local').
// Publication state therefore has TWO halves, and both are checked here.
//
// Whether the release's zips still match what vouches for them is deliberately
// NOT checked: every record available here (the zips, and the manifest asset
// beside them) is writable by anything holding contents: write, so comparing
// them proves nothing. A substituted zip is caught where it can be caught — the
// client's SHA-256 check in packages/rn-dev-agent-core/src/runners/
// runner-artifacts.ts, which falls back to a local build. Slower, never
// compromised. Real attestation is separate, authorized work.
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
  const names = new Set(input.releaseAssets ?? []);
  const buildRunners = forced || !(names.has(expected.ios) && names.has(expected.android));

  const repo = parseManifest(input.repoManifest);
  const published = parseManifest(input.publishedManifest);

  let publishManifest = true;
  let reason;
  if (forced) {
    reason = `forced republication of v${version}`;
  } else if (buildRunners) {
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
