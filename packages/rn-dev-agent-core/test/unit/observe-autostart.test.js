import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autostartObserve } from '../../dist/observability/autostart.js';

function deps(overrides = {}) {
  const calls = { start: 0, warn: [], info: [] };
  const d = {
    findRoot: () => ({ ok: true, root: '/some/project', origin: 'heuristic' }),
    resolveEnabled: () => ({ enabled: true, source: 'default' }),
    start: async () => {
      calls.start++;
      return { url: 'http://127.0.0.1:7333', port: 7333 };
    },
    warn: (m) => calls.warn.push(m),
    info: (m) => calls.info.push(m),
    ...overrides,
  };
  return { d, calls };
}

test('starts and reports the url when a project root exists and autostart is enabled', async () => {
  const { d, calls } = deps();
  const res = await autostartObserve(d);
  assert.deepEqual(res, { url: 'http://127.0.0.1:7333' });
  assert.equal(calls.start, 1);
  assert.equal(calls.warn.length, 0);
  assert.match(calls.info.join('\n'), /http:\/\/127\.0\.0\.1:7333/);
});

test('no project root → never starts, and the refusal reason is reported', async () => {
  const { d, calls } = deps({
    findRoot: () => ({
      ok: false,
      reason:
        'no React Native project root: no bound session app root and heuristic discovery found none',
    }),
  });
  assert.equal(await autostartObserve(d), null);
  assert.equal(calls.start, 0);
  assert.match(calls.warn.join('\n'), /heuristic discovery found none/);
});

test('GH#637: an unprovable project root reports why observe never came up', async () => {
  const { d, calls } = deps({
    findRoot: () => ({
      ok: false,
      reason: 'RN_PROJECT_ROOT is not a React Native project (/gone/app)',
    }),
  });
  assert.equal(await autostartObserve(d), null);
  assert.equal(calls.start, 0);
  assert.match(
    calls.warn.join('\n'),
    /RN_PROJECT_ROOT is not a React Native project \(\/gone\/app\)/,
  );
});

test('disabled via env/config → never starts, logs the source', async () => {
  const { d, calls } = deps({ resolveEnabled: () => ({ enabled: false, source: 'config' }) });
  assert.equal(await autostartObserve(d), null);
  assert.equal(calls.start, 0);
  assert.match(calls.info.join('\n'), /disabled \(config\)/);
});

test('GH#672: a blocked recovery contender never autostarts an operational child', async () => {
  const { d, calls } = deps({
    recoveryOnlyReason: () => 'session is a blocked recovery contender',
  });
  assert.equal(await autostartObserve(d), null);
  assert.equal(calls.start, 0, 'a blocked contender must not open the owner allocated port');
  assert.match(calls.info.join('\n'), /skipped \(session is a blocked recovery contender\)/);
});

test('GH#672: an operational session still autostarts when the recovery gate is clear', async () => {
  const { d, calls } = deps({ recoveryOnlyReason: () => null });
  assert.deepEqual(await autostartObserve(d), { url: 'http://127.0.0.1:7333' });
  assert.equal(calls.start, 1);
});

test('start failure warns and returns null — never throws', async () => {
  const { d, calls } = deps({
    start: async () => {
      throw new Error('EACCES: boom');
    },
  });
  assert.equal(await autostartObserve(d), null);
  assert.equal(calls.warn.length, 1);
  assert.match(calls.warn[0], /EACCES: boom/);
});
