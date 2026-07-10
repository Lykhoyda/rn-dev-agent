// GH #441: package-lock.json is a SHIPPED artifact — ensure-cdp-deps.sh copies
// it to user machines and `npm install --production` resolves against it. A
// stale lock silently pins users to a months-old dependency graph (the shipped
// lock said 0.38.23 while package.json was 0.61.x). The lock's version fields
// are the cheap staleness signal: npm rewrites them on every install, so
// equality with package.json proves the lock was regenerated since the last
// version bump. sync-versions.sh --fix (run by `yarn version-packages`) keeps
// them aligned across release bumps without touching the resolution graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface PackageLock {
  name: string;
  version: string;
  packages: Record<
    string,
    { name?: string; version?: string; dependencies?: Record<string, string> }
  >;
}

const pkg = JSON.parse(readFileSync(join(BRIDGE_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
};
const lock = JSON.parse(
  readFileSync(join(BRIDGE_ROOT, 'package-lock.json'), 'utf8'),
) as PackageLock;

test('gh-441: lock top-level version matches package.json', () => {
  assert.equal(
    lock.version,
    pkg.version,
    `package-lock.json version (${lock.version}) is stale vs package.json (${pkg.version}) — ` +
      'run `npm install --package-lock-only` in packages/rn-dev-agent-core or `./scripts/sync-versions.sh --fix`',
  );
});

test('gh-441: lock root-package entry version matches package.json', () => {
  assert.equal(lock.packages['']?.version, pkg.version);
});

test('gh-441: lock name matches package.json', () => {
  assert.equal(lock.name, pkg.name);
});

// Version-field equality proves the lock was regenerated since the last
// version bump, but NOT since the last dependency edit: hand-changing a range
// in package.json leaves both version fields matching while the resolution
// graph users install is still the old one. Compare the ranges themselves.
// (overrides are not recorded in the lock's root entry, so override drift
// still requires a deliberate regeneration — see sync-versions.sh.)
test('gh-441: lock root-package dependency ranges match package.json', () => {
  assert.deepEqual(
    lock.packages['']?.dependencies,
    pkg.dependencies,
    'package-lock.json dependency ranges drifted from package.json — the lock was not ' +
      'regenerated after a dependency edit. Regenerate in an isolated dir (npm cannot ' +
      'resolve inside the yarn workspace): copy package.json to an empty dir, run ' +
      '`npm install --package-lock-only`, copy package-lock.json back.',
  );
});
