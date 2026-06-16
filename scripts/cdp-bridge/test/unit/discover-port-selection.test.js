import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectMetroPort, AppDetachedError } from '../../dist/cdp/discovery.js';

const T = (description) => ({ id: 'page-1', title: 'RN', vm: 'Hermes', description });

test('selectMetroPort: single attached port wins, no warning', () => {
  const res = selectMetroPort(
    [{ port: 8081, targets: [T('com.app')] }],
    [8081, 8082],
    { currentPort: 8082, cwdForPort: () => null },
  );
  assert.equal(res.port, 8081);
  assert.equal(res.warning, undefined);
});

test('selectMetroPort: zero attached → AppDetachedError listing running ports', () => {
  assert.throws(
    () => selectMetroPort([], [8081, 8082], { currentPort: 8081, cwdForPort: () => null }),
    (err) => err instanceof AppDetachedError && err.runningPorts.includes(8082),
  );
});

test('selectMetroPort: projectRoot cwd-match beats sticky currentPort', () => {
  const res = selectMetroPort(
    [{ port: 8081, targets: [T('com.app')] }, { port: 8082, targets: [T('com.app')] }],
    [8081, 8082],
    {
      currentPort: 8082, // sticky would pick 8082
      projectRoot: '/repo/worktreeA',
      cwdForPort: (p) => (p === 8081 ? '/repo/worktreeA' : '/repo/worktreeB'),
    },
  );
  assert.equal(res.port, 8081, 'cwd match wins over stickiness');
});

test('selectMetroPort: preferredBundleId port-level tie-break when one port matches', () => {
  const res = selectMetroPort(
    [{ port: 8081, targets: [T('com.other')] }, { port: 8082, targets: [T('com.app')] }],
    [8081, 8082],
    { currentPort: 8081, preferredBundleId: 'com.app', cwdForPort: () => null },
  );
  assert.equal(res.port, 8082);
});

test('selectMetroPort: no cwd match, no pref → sticky currentPort + warning lists candidates', () => {
  const res = selectMetroPort(
    [{ port: 8081, targets: [T('com.app')] }, { port: 8082, targets: [T('com.app')] }],
    [8081, 8082],
    { currentPort: 8082, projectRoot: '/repo/none', cwdForPort: () => null },
  );
  assert.equal(res.port, 8082, 'sticky currentPort chosen');
  assert.match(res.warning, /8081/);
  assert.match(res.warning, /metroPort/);
});

test('selectMetroPort: sticky falls back to lowest attached when currentPort detached', () => {
  const res = selectMetroPort(
    [{ port: 8082, targets: [T('com.app')] }, { port: 19000, targets: [T('com.app')] }],
    [8081, 8082, 19000],
    { currentPort: 8081, cwdForPort: () => null },
  );
  assert.equal(res.port, 8082);
});
