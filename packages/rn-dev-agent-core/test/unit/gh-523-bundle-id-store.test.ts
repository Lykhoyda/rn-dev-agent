// GH #523 sub-2: persisted last-connected bundleId store.
// A fresh bridge worker has an empty module-scope cache, so a first
// hardReset after a bridge restart degraded to a soft reset
// ("skip-simctl:no-bundleId-on-connectedTarget-or-cache"). The store keeps
// the last-connected bundleId per platform under
// <projectRoot>/.rn-agent/state/last-bundle-ids.json so hardReset can always
// relaunch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistLastBundleId, loadPersistedBundleId } from '../../dist/cdp/bundle-id-store.js';

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'gh523-store-'));
}

test('store: persist then load round-trips per platform', () => {
  const root = freshRoot();
  persistLastBundleId('ios', 'com.example.app', root);
  persistLastBundleId('android', 'com.example.android', root);

  assert.equal(loadPersistedBundleId('ios', root), 'com.example.app');
  assert.equal(loadPersistedBundleId('android', root), 'com.example.android');
});

test('store: load returns null when no state file exists', () => {
  const root = freshRoot();
  assert.equal(loadPersistedBundleId('ios', root), null);
});

test('store: persist creates .rn-agent/state/ and writes JSON', () => {
  const root = freshRoot();
  persistLastBundleId('ios', 'com.example.app', root);

  const file = join(root, '.rn-agent', 'state', 'last-bundle-ids.json');
  assert.ok(existsSync(file), 'state file created');
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(parsed.ios.bundleId, 'com.example.app');
});

test('store: invalid bundleId on disk is rejected (untrusted persisted state)', () => {
  const root = freshRoot();
  const dir = join(root, '.rn-agent', 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'last-bundle-ids.json'),
    JSON.stringify({ ios: { bundleId: 'rm -rf / ; com.evil' } }),
  );
  assert.equal(loadPersistedBundleId('ios', root), null);
});

test('store: corrupt JSON on disk returns null without throwing', () => {
  const root = freshRoot();
  const dir = join(root, '.rn-agent', 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'last-bundle-ids.json'), '{not json');
  assert.equal(loadPersistedBundleId('ios', root), null);
});

test('store: platform miss returns null even when other platform is stored', () => {
  const root = freshRoot();
  persistLastBundleId('android', 'com.example.android', root);
  assert.equal(loadPersistedBundleId('ios', root), null);
});

test('store: persist is best-effort — unwritable root does not throw', () => {
  // A path under a regular FILE cannot contain directories → mkdir fails.
  const root = freshRoot();
  const blocker = join(root, 'blocker');
  writeFileSync(blocker, 'plain file');
  assert.doesNotThrow(() => persistLastBundleId('ios', 'com.example.app', join(blocker, 'sub')));
});

test('store: persist refuses an invalid bundleId (never write garbage)', () => {
  const root = freshRoot();
  persistLastBundleId('ios', 'not a bundle id!!', root);
  assert.equal(loadPersistedBundleId('ios', root), null);
  assert.ok(
    !existsSync(join(root, '.rn-agent', 'state', 'last-bundle-ids.json')),
    'no state file written for invalid input',
  );
});

test('store: no explicit root and no project root resolves to null (no throw)', () => {
  // Default-root path: falls back to findProjectRoot(); in this repo (not an
  // RN app) that should yield null → load returns null rather than throwing.
  assert.doesNotThrow(() => loadPersistedBundleId('ios'));
});
