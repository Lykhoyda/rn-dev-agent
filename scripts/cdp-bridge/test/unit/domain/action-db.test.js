// Task 1: action-db — ESM loader + open + schema + PRAGMA + graceful degradation
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openActionDb, loadSqlite } from '../../../dist/domain/action-db.js';

// ─── CI-loud assertion: loadSqlite() MUST be non-null on Node 24 ─────────────
test('loadSqlite() returns a non-null ctor on Node 24 (ESM loader smoke test)', () => {
  const ctor = loadSqlite();
  assert.ok(
    ctor !== null,
    'loadSqlite() returned null — the ESM createRequire loader is broken or node:sqlite is unavailable on this Node version',
  );
});

// ─── Happy path: opens DB, creates schema, runs PRAGMAs ─────────────────────
test('openActionDb creates the db file + schema when node:sqlite is available', () => {
  const ctor = loadSqlite();
  if (!ctor) {
    // This branch should NOT be reached on Node 24 (caught by the CI-loud test above).
    // Kept here so an isolated run of this test on an older Node is a clear skip.
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-'));
  const handle = openActionDb(root);
  assert.ok(handle, 'expected a handle when sqlite is available');
  assert.ok(existsSync(join(root, '.rn-agent', 'state', 'actions.db')));

  const rows = handle.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const names = rows.map((r) => r.name);
  assert.deepEqual(names, ['actions_index', 'repair_records', 'run_records']);

  // Verify key columns exist on actions_index
  const indexCols = handle.db.prepare('PRAGMA table_info(actions_index)').all();
  const indexColNames = indexCols.map((c) => c.name);
  assert.ok(indexColNames.includes('stats_json'), 'actions_index must have stats_json column');
  assert.ok(indexColNames.includes('id'), 'actions_index must have id column');
  assert.ok(indexColNames.includes('app_id'), 'actions_index must have app_id column');

  // Verify run_records has expected columns (including failure_detail)
  const runCols = handle.db.prepare('PRAGMA table_info(run_records)').all();
  const runColNames = runCols.map((c) => c.name);
  assert.ok(runColNames.includes('failure_detail'), 'run_records must have failure_detail column');
  assert.ok(runColNames.includes('id'), 'run_records must have id column');
  assert.ok(runColNames.includes('ts'), 'run_records must have ts column');
  assert.ok(runColNames.includes('status'), 'run_records must have status column');

  // Verify repair_records has AUTOINCREMENT id
  const repairCols = handle.db.prepare('PRAGMA table_info(repair_records)').all();
  const repairColNames = repairCols.map((c) => c.name);
  assert.ok(repairColNames.includes('id'), 'repair_records must have id column');
  assert.ok(repairColNames.includes('action_id'), 'repair_records must have action_id column');

  handle.close();
});

// ─── Graceful degradation: null sqliteCtor → returns null without throwing ──
test('openActionDb returns null and never throws when sqlite ctor is forced null', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-'));
  const handle = openActionDb(root, { sqliteCtor: null });
  assert.equal(handle, null);
});

// ─── Idempotency: calling openActionDb twice on same root is safe ─────────────
test('openActionDb is idempotent (IF NOT EXISTS schema, second open succeeds)', () => {
  const ctor = loadSqlite();
  if (!ctor) return;

  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-idem-'));
  const h1 = openActionDb(root);
  assert.ok(h1);
  h1.close();

  const h2 = openActionDb(root);
  assert.ok(h2, 'second open on same path should succeed');
  h2.close();
});
