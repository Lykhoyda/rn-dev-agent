import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  AuthorityStoreUnavailableError,
  openAuthorityStore,
  probeAuthorityStore,
} from '../../../dist/session/authority-store.js';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test('authority store reports an explicit unavailable diagnostic without fallback', () => {
  const diagnostic = probeAuthorityStore({ sqliteCtor: null });

  assert.deepEqual(diagnostic, {
    available: false,
    code: 'AUTHORITY_STORE_UNAVAILABLE',
    reason: 'node:sqlite could not be loaded by this Node runtime',
  });
});

test('authority store refuses to open when SQLite is unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-authority-store-'));
  roots.push(root);

  assert.throws(
    () => openAuthorityStore(join(root, 'registry.sqlite3'), { sqliteCtor: null }),
    (error) =>
      error instanceof AuthorityStoreUnavailableError &&
      error.code === 'AUTHORITY_STORE_UNAVAILABLE',
  );
});

test('authority store opens a transactional registry with private permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-authority-store-'));
  roots.push(root);
  const path = join(root, 'registry.sqlite3');
  const store = openAuthorityStore(path);

  try {
    assert.deepEqual(probeAuthorityStore(), { available: true });
    assert.equal(
      store.database.prepare('SELECT value FROM authority_meta WHERE key = ?').get('schema_version')
        .value,
      '1',
    );
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    store.close();
  }
});
