import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// Redirect the state dir BEFORE importing the module under test —
// getStateDir() reads XDG_STATE_HOME at call time, but keeping the env set
// for the whole file is the simplest correct setup.
const stateHome = mkdtempSync(join(tmpdir(), 'rn-observe-state-'));
process.env.XDG_STATE_HOME = stateHome;

const { observeStatePath, writeObserveState, removeObserveState } = await import(
  '../../dist/observability/observe-state.js'
);

const fakeRoot = '/Users/someone/projects/my app';

test('writeObserveState writes an atomic per-project state file', () => {
  writeObserveState('http://127.0.0.1:7333', 7333, fakeRoot, () => new Date('2026-07-02T10:00:00Z'));
  const p = observeStatePath(fakeRoot);
  assert.ok(p.startsWith(join(stateHome, 'rn-dev-agent', 'observe')), p);
  assert.ok(existsSync(p));
  const state = JSON.parse(readFileSync(p, 'utf8'));
  assert.deepEqual(state, {
    url: 'http://127.0.0.1:7333',
    port: 7333,
    pid: process.pid,
    projectRoot: fakeRoot,
    startedAt: '2026-07-02T10:00:00.000Z',
  });
});

test('project roots with unsafe characters are sanitized in the filename', () => {
  const p = observeStatePath('/a/b?c:d e');
  const base = p.split('/').pop();
  assert.match(base, /^[A-Za-z0-9._-]+\.json$/);
});

test('removeObserveState deletes only a file owned by this pid', () => {
  const p = observeStatePath(fakeRoot);
  // Owned by us (written in the first test) → deleted.
  removeObserveState(fakeRoot);
  assert.ok(!existsSync(p));

  // Owned by another live session → left alone.
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({ url: 'x', port: 1, pid: process.pid + 1, projectRoot: fakeRoot, startedAt: 'x' }),
  );
  removeObserveState(fakeRoot);
  assert.ok(existsSync(p), 'foreign-pid state file must not be deleted');
});

test('null project root is a silent no-op', () => {
  writeObserveState('http://127.0.0.1:7333', 7333, null);
  removeObserveState(null);
});

test('cleanup', () => {
  rmSync(stateHome, { recursive: true, force: true });
});
