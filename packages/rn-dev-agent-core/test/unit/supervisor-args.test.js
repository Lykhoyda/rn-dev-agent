import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sqliteFlagForNode, workerSpawnArgs } from '../../dist/supervisor-args.js';

// ── sqliteFlagForNode ─────────────────────────────────────────────────────────
// Flag is required for 22.5 ≤ v < 23.6 (inclusive on both ends of the integers).
// v < 22.5   → module absent → degrade gracefully (no flag)
// v ≥ 23.6   → on by default → no-op flag dropped
// v ≥ 24     → definitely on by default

describe('sqliteFlagForNode', () => {
  test('22.4.0 — below threshold, no flag (module absent)', () => {
    assert.deepEqual(sqliteFlagForNode('22.4.0'), []);
  });

  test('22.5.0 — lower bound of flag range', () => {
    assert.deepEqual(sqliteFlagForNode('22.5.0'), ['--experimental-sqlite']);
  });

  test('22.20.0 — still Node 22, minor well above 5', () => {
    assert.deepEqual(sqliteFlagForNode('22.20.0'), ['--experimental-sqlite']);
  });

  test('23.0.0 — Node 23 before default-on boundary', () => {
    assert.deepEqual(sqliteFlagForNode('23.0.0'), ['--experimental-sqlite']);
  });

  test('23.5.0 — last minor before default-on', () => {
    assert.deepEqual(sqliteFlagForNode('23.5.0'), ['--experimental-sqlite']);
  });

  test('23.6.0 — default-on boundary, no flag needed', () => {
    assert.deepEqual(sqliteFlagForNode('23.6.0'), []);
  });

  test('23.10.0 — Node 23 minor 10 > 6, no flag (23.10 > 23.6)', () => {
    assert.deepEqual(sqliteFlagForNode('23.10.0'), []);
  });

  test('24.0.0 — Node 24, on by default, no flag', () => {
    assert.deepEqual(sqliteFlagForNode('24.0.0'), []);
  });

  test('uses process.versions.node when version is omitted', () => {
    // Should not throw and must return an array
    const result = sqliteFlagForNode();
    assert.ok(Array.isArray(result));
  });
});

// ── workerSpawnArgs ───────────────────────────────────────────────────────────

describe('workerSpawnArgs', () => {
  test('flag version: puts --experimental-sqlite BEFORE script, --no-lock AFTER', () => {
    assert.deepEqual(workerSpawnArgs('/abs/dist/index.js', '22.6.0'), [
      '--experimental-sqlite',
      '/abs/dist/index.js',
      '--no-lock',
    ]);
  });

  test('no-flag version: script + --no-lock, no node flag prepended', () => {
    assert.deepEqual(workerSpawnArgs('/abs/dist/index.js', '24.0.0'), [
      '/abs/dist/index.js',
      '--no-lock',
    ]);
  });

  test('22.4.0 (below threshold): no flag', () => {
    assert.deepEqual(workerSpawnArgs('/abs/dist/index.js', '22.4.0'), [
      '/abs/dist/index.js',
      '--no-lock',
    ]);
  });
});
