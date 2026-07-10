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
  packages: Record<string, { name?: string; version?: string }>;
}

const pkg = JSON.parse(readFileSync(join(BRIDGE_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
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
