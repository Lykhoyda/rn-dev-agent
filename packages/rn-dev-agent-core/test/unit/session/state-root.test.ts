import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  createAuthorityStateLayout,
  writeSessionSecret,
} from '../../../dist/session/state-root.js';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test('authority state layout is user-private and session-scoped', () => {
  const base = mkdtempSync(join(tmpdir(), 'rn-authority-layout-'));
  roots.push(base);
  const layout = createAuthorityStateLayout(base);
  const secretPath = writeSessionSecret(layout, 'session-a', { capability: 'secret' });

  assert.equal(statSync(layout.root).mode & 0o777, 0o700);
  assert.equal(statSync(layout.sessions).mode & 0o777, 0o700);
  assert.equal(statSync(secretPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(secretPath, 'utf8')), { capability: 'secret' });
  assert.equal(layout.registry, join(base, 'v2', 'registry.sqlite3'));
});

test('authority state layout rejects a symlinked v2 root', () => {
  const base = mkdtempSync(join(tmpdir(), 'rn-authority-layout-'));
  const foreign = mkdtempSync(join(tmpdir(), 'rn-authority-foreign-'));
  roots.push(base, foreign);
  symlinkSync(foreign, join(base, 'v2'));

  assert.throws(() => createAuthorityStateLayout(base), /AUTHORITY_STATE_ROOT_UNSAFE/);
});

test('session identifiers cannot escape their private state directory', () => {
  const base = mkdtempSync(join(tmpdir(), 'rn-authority-layout-'));
  roots.push(base);
  const layout = createAuthorityStateLayout(base);

  assert.throws(
    () => writeSessionSecret(layout, '../foreign', { capability: 'secret' }),
    /INVALID_SESSION_ID/,
  );
});
