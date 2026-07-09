import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilityServer } from '../../dist/observability/server.js';
import { recorder } from '../../dist/observability/recorder.js';

async function withServer(e2e, fn) {
  const s = new ObservabilityServer(recorder, e2e);
  const { url } = await s.start();
  try {
    await fn(url);
  } finally {
    await s.stop();
  }
}

const E2E = (over = {}) => ({
  token: 'tok1',
  triggerRun: async () => ({ ok: true }),
  listRuns: async () => [],
  loadRun: async () => null,
  listActions: async () => [{ id: 'login', intent: 'Log in', status: 'active' }],
  runAction: async (actionId) => ({ ok: true, output: `ran ${actionId}` }),
  ...over,
});

test('GET /api/e2e/actions returns 200 with actions list', async () => {
  await withServer(E2E(), async (url) => {
    const r = await fetch(url + '/api/e2e/actions');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].id, 'login');
  });
});

test('GET /api/e2e/actions returns 501 when no e2e deps', async () => {
  await withServer(undefined, async (url) => {
    const r = await fetch(url + '/api/e2e/actions');
    assert.equal(r.status, 501);
  });
});

test('POST /api/e2e/actions/run without CSRF returns 403 and does NOT call runAction', async () => {
  let called = false;
  await withServer(
    E2E({
      runAction: async () => {
        called = true;
        return { ok: true };
      },
    }),
    async (url) => {
      const r = await fetch(url + '/api/e2e/actions/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionId: 'login' }),
      });
      assert.equal(r.status, 403);
      assert.equal(called, false);
    },
  );
});

test('POST /api/e2e/actions/run with valid CSRF returns runAction result', async () => {
  await withServer(E2E(), async (url) => {
    const r = await fetch(url + '/api/e2e/actions/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'tok1' },
      body: JSON.stringify({ actionId: 'login' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.output, 'ran login');
  });
});

test('GET /api/e2e/actions/run returns 405', async () => {
  await withServer(E2E(), async (url) => {
    const r = await fetch(url + '/api/e2e/actions/run');
    assert.equal(r.status, 405);
  });
});

test('POST /api/e2e/actions/run with missingParams returns 400', async () => {
  await withServer(
    E2E({
      runAction: async () => ({ ok: false, missingParams: ['USER', 'PASS'] }),
    }),
    async (url) => {
      const r = await fetch(url + '/api/e2e/actions/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'tok1' },
        body: JSON.stringify({ actionId: 'login' }),
      });
      assert.equal(r.status, 400);
      const body = await r.json();
      assert.deepEqual(body.missingParams, ['USER', 'PASS']);
    },
  );
});

test('POST /api/e2e/actions/run with missing actionId returns 400', async () => {
  await withServer(E2E(), async (url) => {
    const r = await fetch(url + '/api/e2e/actions/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'tok1' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  });
});
