import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autostartObserve } from '../../dist/observability/autostart.js';

function deps(overrides = {}) {
  const calls = { start: 0, warn: [], info: [] };
  const d = {
    findRoot: () => '/some/project',
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

test('no project root → never starts', async () => {
  const { d, calls } = deps({ findRoot: () => null });
  assert.equal(await autostartObserve(d), null);
  assert.equal(calls.start, 0);
});

test('disabled via env/config → never starts, logs the source', async () => {
  const { d, calls } = deps({ resolveEnabled: () => ({ enabled: false, source: 'config' }) });
  assert.equal(await autostartObserve(d), null);
  assert.equal(calls.start, 0);
  assert.match(calls.info.join('\n'), /disabled \(config\)/);
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
