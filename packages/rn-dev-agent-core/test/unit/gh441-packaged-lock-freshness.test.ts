// GH #441: package-lock.json is what users actually install against —
// ensure-cdp-deps.sh copies it next to package.json and runs
// `npm install --production`, so a stale lock silently pins user installs to
// an old resolution (the shipped lock said 0.38.23 while the package was
// 0.61.5). Day-to-day development goes through yarn.lock and never touches
// this file, so nothing else notices the drift. Tripwire: the lock must be
// regenerated whenever the package version or its dependency ranges change.
// Release version bumps keep the lock's version fields fresh via
// scripts/sync-versions.sh --fix (part of `yarn version-packages`); a
// dependency-range change requires a real regeneration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f: string): Record<string, any> => JSON.parse(readFileSync(join(BRIDGE, f), 'utf8'));

test('GH#441 package-lock.json tracks package.json (users install against the lock)', () => {
  const pkg = read('package.json');
  let lock: Record<string, any>;
  try {
    lock = read('package-lock.json');
  } catch {
    assert.fail(
      'package-lock.json is missing. ensure-cdp-deps.sh and the packaged-artifact ' +
        'smoke rely on it to pin user installs; if removing it is intentional, ' +
        'remove this test in the same change.',
    );
  }

  const regen =
    'Regenerate it in isolation (npm resolves the whole yarn workspace otherwise): ' +
    'copy package.json to an empty dir, run `npm install --package-lock-only`, ' +
    'copy package-lock.json back.';

  assert.equal(
    lock.version,
    pkg.version,
    `stale package-lock.json: lock version ${lock.version} vs package.json ${pkg.version}. ` +
      `A plain version bump is auto-synced by scripts/sync-versions.sh --fix. ${regen}`,
  );
  assert.equal(
    lock.packages?.['']?.version,
    pkg.version,
    `stale package-lock.json root entry: ${lock.packages?.['']?.version} vs ${pkg.version}. ` +
      `A plain version bump is auto-synced by scripts/sync-versions.sh --fix. ${regen}`,
  );
  assert.deepEqual(
    lock.packages?.['']?.dependencies,
    pkg.dependencies,
    `package-lock.json dependency ranges drifted from package.json. ${regen}`,
  );
});
