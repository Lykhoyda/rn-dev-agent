// Task 5: action-store.ts is store-aware — every authoritative write also
// mirrors to the node:sqlite DB (Phase 1 dual-write, A2/A3/A5).
//
// These tests pin:
//   - mirrorToDb derives the right projectRoot/actionId from a
//     .rn-agent/actions/<id>.yaml path and writes to
//     <projectRoot>/.rn-agent/state/actions.db
//   - after a saveAction + a persistRun-style RunRecord append, the DB has the
//     index row (cumulative stats from stats_json) AND the appended
//     run_records row
//   - a forced mirror failure never breaks the authoritative sidecar write
//     and never throws into the authoritative path
//   - the #101 pair-write + #117 CAS semantics are not regressed by the mirror
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqlite, openActionDb } from '../../../dist/domain/action-db.js';
import {
  mirrorToDb,
  closeActionStoresForTest,
  __setSqliteCtorForTest,
} from '../../../dist/domain/action-state-store.js';
import { loadAction, saveAction, saveActionWithCAS } from '../../../dist/domain/action-store.js';
import { freshRuntimeState, appendRunRecord } from '../../../dist/domain/reusable-action.js';

function freshProject(id = 'login') {
  const root = mkdtempSync(join(tmpdir(), 'rn-store-mirror-'));
  mkdirSync(join(root, '.rn-agent', 'actions'), { recursive: true });
  const yaml = join(root, '.rn-agent', 'actions', `${id}.yaml`);
  writeFileSync(
    yaml,
    [
      'appId: com.x',
      '---',
      '# id: ' + id,
      '# intent: do the thing',
      '# status: active',
      '# appId: com.x',
      '- launchApp',
      '- tapOn:',
      '    id: "old-selector"',
      '',
    ].join('\n'),
  );
  return { root, yaml, id };
}

function dbPathOf(root) {
  return join(root, '.rn-agent', 'state', 'actions.db');
}

function makeRunRecord(overrides = {}) {
  return {
    timestamp: new Date().toISOString(),
    durationMs: 1234,
    status: 'pass',
    trigger: 'agent',
    ...overrides,
  };
}

// ─── mirrorToDb derives projectRoot/actionId from the YAML path ──────────────
test('mirrorToDb derives projectRoot + actionId from a .rn-agent/actions/<id>.yaml path', () => {
  closeActionStoresForTest();
  if (!loadSqlite()) return; // skip-guard: requires real node:sqlite
  const { root, yaml } = freshProject('derive-me');
  __setSqliteCtorForTest(loadSqlite());

  const s0 = freshRuntimeState(() => new Date(), 0);
  // No projectRoot passed — it must be derived from the YAML path.
  mirrorToDb({
    yamlFilePath: yaml,
    state: { ...s0, revision: 3 },
    meta: { appId: 'com.x', status: 'active' },
  });

  // The DB landed at <projectRoot>/.rn-agent/state/actions.db.
  assert.equal(
    existsSync(dbPathOf(root)),
    true,
    'mirror must write to <root>/.rn-agent/state/actions.db',
  );

  const probe = openActionDb(root);
  const state = probe.loadState('derive-me');
  assert.ok(state, 'expected an actions_index row keyed by the derived actionId');
  assert.equal(state.revision, 3);
  probe.close();
  closeActionStoresForTest();
});

// ─── mirrorToDb skips a synthetic/non-conventional path (fails open) ─────────
test('mirrorToDb is a no-op (never throws) for a non-.rn-agent path', () => {
  closeActionStoresForTest();
  __setSqliteCtorForTest(loadSqlite());
  const root = mkdtempSync(join(tmpdir(), 'rn-store-synth-'));
  const synthetic = join(root, 'inline-action.yaml');
  const s0 = freshRuntimeState(() => new Date(), 0);
  assert.doesNotThrow(() => mirrorToDb({ yamlFilePath: synthetic, state: { ...s0, revision: 1 } }));
  // No DB should be created — the path doesn't resolve to a project root.
  assert.equal(existsSync(join(root, '.rn-agent')), false);
  closeActionStoresForTest();
});

// ─── saveAction + a RunRecord append: index row + run row in the DB ──────────
test('saveAction + persistRun-style append: DB has the index row (cumulative stats) AND the run row', () => {
  closeActionStoresForTest();
  if (!loadSqlite()) return;
  const { root } = freshProject('run-mirror');
  __setSqliteCtorForTest(loadSqlite());

  // 1. saveAction mirrors the index row (no run row yet).
  const action = loadAction(root, 'run-mirror');
  assert.ok(action, 'expected to load the freshly-written action');
  saveAction(action);

  let probe = openActionDb(root);
  let state = probe.loadState('run-mirror');
  assert.ok(state, 'saveAction must seed the index row');
  assert.equal(state.runHistory.length, 0, 'saveAction appends NO run row');
  probe.close();

  // 2. persistRun-style: append a RunRecord then CAS-save, then mirror the row.
  const fresh = loadAction(root, 'run-mirror');
  const record = makeRunRecord({ durationMs: 500, status: 'pass' });
  const next = { ...fresh, state: appendRunRecord(fresh.state, record) };
  const result = saveActionWithCAS(next);
  assert.equal(result.ok, true, 'CAS save must succeed (no concurrent writer)');
  mirrorToDb({
    yamlFilePath: next.filePath,
    state: next.state,
    newRunRecord: record,
    meta: { appId: next.metadata.appId, status: next.metadata.status, path: next.filePath },
  });

  probe = openActionDb(root);
  state = probe.loadState('run-mirror');
  assert.equal(state.runHistory.length, 1, 'exactly one run row appended');
  assert.equal(state.runHistory[0].durationMs, 500);
  // Cumulative stats come from the stored stats_json (not recomputed from rows).
  assert.equal(state.stats.totalRuns, 1, 'cumulative totalRuns reflects the append');
  assert.equal(state.stats.successCount, 1);
  probe.close();
  closeActionStoresForTest();
});

// ─── forced mirror failure: authoritative sidecar write survives + no throw ──
test('a forced mirror failure does not break the authoritative sidecar write or throw', () => {
  closeActionStoresForTest();
  const { root } = freshProject('throwing');

  // A ctor whose write methods throw → the mirror swallows it (best-effort).
  class ThrowingDb {
    exec() {}
    prepare() {
      return {
        run() {
          throw new Error('simulated DB write failure');
        },
        get() {
          return undefined;
        },
        all() {
          return [];
        },
      };
    }
    close() {}
  }
  __setSqliteCtorForTest(ThrowingDb);

  const action = loadAction(root, 'throwing');
  assert.ok(action);
  // saveAction internally calls mirrorToDb; the throwing mirror must not
  // propagate out of the authoritative write.
  assert.doesNotThrow(() => saveAction(action));

  // The authoritative sidecar was written despite the mirror failure.
  const sidecar = join(root, '.rn-agent', 'state', 'throwing.state.json');
  assert.equal(existsSync(sidecar), true, 'sidecar must be written even when the mirror throws');
  const parsed = JSON.parse(readFileSync(sidecar, 'utf8'));
  assert.equal(parsed.schemaVersion, 1);
  closeActionStoresForTest();
});

// ─── #117 CAS conflict is preserved: the mirror never masks a conflict ───────
test('#117: a CAS conflict is still returned (mirror does not convert it to a success)', () => {
  closeActionStoresForTest();
  __setSqliteCtorForTest(loadSqlite());
  const { root } = freshProject('cas');

  // Load twice — two in-memory snapshots at the same mtime baseline.
  const a = loadAction(root, 'cas');
  const b = loadAction(root, 'cas');
  assert.ok(a && b);

  // First writer wins (advances the on-disk lastSeenMtimeMs).
  const aNext = { ...a, state: appendRunRecord(a.state, makeRunRecord()) };
  const r1 = saveActionWithCAS(aNext);
  assert.equal(r1.ok, true);

  // Second writer raced — its snapshot is stale; CAS must refuse.
  // (Only meaningful when the on-disk mtime actually advanced; first save may
  // have had a 0 baseline, so re-load b to a real baseline then stale it.)
  const bReloaded = loadAction(root, 'cas');
  // Re-save again so the on-disk mtime is strictly greater than bReloaded's
  // captured baseline.
  const bWriter = { ...bReloaded, state: appendRunRecord(bReloaded.state, makeRunRecord()) };
  const aThird = loadAction(root, 'cas');
  saveActionWithCAS({ ...aThird, state: appendRunRecord(aThird.state, makeRunRecord()) });
  const r2 = saveActionWithCAS(bWriter);
  assert.equal(r2.ok, false, 'stale snapshot must hit a CAS conflict');
  assert.equal(r2.conflict, 'EXTERNAL_WRITE');
  closeActionStoresForTest();
});
