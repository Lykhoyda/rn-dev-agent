import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  waitForAndroidRunnerHealth,
  _setFetchForTest,
} from '../../dist/runners/rn-android-runner-client.js';

afterEach(() => {
  _setFetchForTest(globalThis.fetch);
});

test('#243 waitForAndroidRunnerHealth resolves true once /health returns {ok:true}', async () => {
  _setFetchForTest(async (url) => {
    assert.match(String(url), /\/health$/);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  const healthy = await waitForAndroidRunnerHealth(22089, { timeoutMs: 1000, intervalMs: 10 });
  assert.equal(healthy, true);
});

test('#243 waitForAndroidRunnerHealth keeps polling until healthy (no premature ready off a dead port)', async () => {
  let n = 0;
  _setFetchForTest(async () => {
    n += 1;
    if (n < 3) throw new Error('fetch failed'); // server socket not bound yet
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  const healthy = await waitForAndroidRunnerHealth(22089, { timeoutMs: 1000, intervalMs: 10 });
  assert.equal(healthy, true);
  assert.ok(n >= 3, 'must keep polling until /health actually succeeds');
});

test('#243 waitForAndroidRunnerHealth returns false on timeout (never throws)', async () => {
  _setFetchForTest(async () => { throw new Error('fetch failed'); });
  const healthy = await waitForAndroidRunnerHealth(22089, { timeoutMs: 60, intervalMs: 10 });
  assert.equal(healthy, false);
});
