import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLsofPid,
  parseLsofCwd,
  cwdForPort,
  pathMatchesRoot,
  _resetMetroCwdCacheForTest,
} from '../../dist/cdp/metro-cwd.js';

test('parseLsofPid: first numeric line from `lsof -ti` output', () => {
  assert.equal(parseLsofPid('12345\n'), 12345);
  assert.equal(parseLsofPid('12345\n12346\n'), 12345);
});

test('parseLsofPid: null on empty / non-numeric', () => {
  assert.equal(parseLsofPid(''), null);
  assert.equal(parseLsofPid('\n  \n'), null);
});

test('parseLsofCwd: extracts the n-field from `lsof -Fn` machine output', () => {
  const out = 'p12345\nfcwd\nn/Users/anton/GitHub/ix3030/test-app\n';
  assert.equal(parseLsofCwd(out), '/Users/anton/GitHub/ix3030/test-app');
});

test('parseLsofCwd: null when no n-field present', () => {
  assert.equal(parseLsofCwd('p12345\nfcwd\n'), null);
});

test('cwdForPort: composes pid→cwd via injected exec', () => {
  _resetMetroCwdCacheForTest();
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args.join(' '));
    if (args.includes('-ti')) return '777\n';
    return 'p777\nfcwd\nn/repo/worktreeA\n';
  };
  assert.equal(cwdForPort(8081, exec), '/repo/worktreeA');
});

test('cwdForPort: memoizes pid→cwd but re-resolves port→pid each call', () => {
  _resetMetroCwdCacheForTest();
  let pidCalls = 0;
  let cwdCalls = 0;
  const exec = (cmd, args) => {
    if (args.includes('-ti')) { pidCalls++; return '777\n'; }
    cwdCalls++; return 'p777\nfcwd\nn/repo/worktreeA\n';
  };
  cwdForPort(8081, exec);
  cwdForPort(8081, exec);
  assert.equal(pidCalls, 2, 'port→pid re-resolved each call (guards port reuse)');
  assert.equal(cwdCalls, 1, 'pid→cwd memoized');
});

test('cwdForPort: fail-open — null when exec throws or returns junk', () => {
  _resetMetroCwdCacheForTest();
  const throwing = () => { throw new Error('lsof not found'); };
  assert.equal(cwdForPort(8081, throwing), null);
  _resetMetroCwdCacheForTest();
  const noPid = (cmd, args) => (args.includes('-ti') ? '' : '');
  assert.equal(cwdForPort(8081, noPid), null);
});

test('pathMatchesRoot: equal paths match', () => {
  assert.equal(pathMatchesRoot('/repo/worktreeA', '/repo/worktreeA'), true);
});

test('pathMatchesRoot: serving cwd nested under root matches (monorepo app subdir, both directions)', () => {
  assert.equal(pathMatchesRoot('/repo/worktreeA/app', '/repo/worktreeA'), true);
  assert.equal(pathMatchesRoot('/repo/worktreeA', '/repo/worktreeA/app'), true);
});

test('pathMatchesRoot: sibling worktrees do NOT match (the #303 case)', () => {
  assert.equal(pathMatchesRoot('/repo/worktreeB', '/repo/worktreeA'), false);
});

test('pathMatchesRoot: shared prefix without a separator boundary does NOT match', () => {
  assert.equal(pathMatchesRoot('/repo/worktreeA-2', '/repo/worktreeA'), false);
});

test('pathMatchesRoot: null/undefined operands → false (fail-open)', () => {
  assert.equal(pathMatchesRoot(null, '/repo/worktreeA'), false);
  assert.equal(pathMatchesRoot('/repo/worktreeA', undefined), false);
});
