import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetroMismatch } from '../../dist/tools/status.js';

test('computeMetroMismatch: warns when servingCwd !== projectRoot', () => {
  const r = computeMetroMismatch({
    servingCwd: '/repo/worktreeB',
    projectRoot: '/repo/worktreeA',
    port: 8082,
  });
  assert.equal(r.mismatch, true);
  assert.match(r.warning, /different worktree/i);
  assert.match(r.warning, /8082/);
});

test('computeMetroMismatch: silent when equal', () => {
  const r = computeMetroMismatch({
    servingCwd: '/repo/worktreeA',
    projectRoot: '/repo/worktreeA',
    port: 8081,
  });
  assert.equal(r.mismatch, false);
  assert.equal(r.warning, undefined);
});

test('computeMetroMismatch: silent when serving cwd is an app subdir of the project root (monorepo)', () => {
  const r = computeMetroMismatch({
    servingCwd: '/repo/worktreeA/app',
    projectRoot: '/repo/worktreeA',
    port: 8081,
  });
  assert.equal(r.mismatch, false);
});

test('computeMetroMismatch: silent when servingCwd unresolved (fail-open)', () => {
  const r = computeMetroMismatch({ servingCwd: null, projectRoot: '/repo/worktreeA', port: 8081 });
  assert.equal(r.mismatch, false);
});

test('computeMetroMismatch: silent when projectRoot unknown', () => {
  const r = computeMetroMismatch({
    servingCwd: '/repo/worktreeA',
    projectRoot: undefined,
    port: 8081,
  });
  assert.equal(r.mismatch, false);
});
