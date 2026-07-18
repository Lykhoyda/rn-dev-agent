import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilityServer } from '../../dist/observability/server.js';
import type { StateServerDeps } from '../../dist/observability/server.js';
import { recorder } from '../../dist/observability/recorder.js';

async function withServer(
  state: StateServerDeps,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const s = new ObservabilityServer(recorder, undefined, undefined, state);
  const { url } = await s.start();
  try {
    await fn(url);
  } finally {
    await s.stop();
  }
}

const STATE = (over: Partial<StateServerDeps> = {}): StateServerDeps => ({
  read: async (kind: string) =>
    ['route', 'store', 'tree'].includes(kind) ? { ok: true, data: { kind } } : null,
  ...over,
});

test('GET /api/state/<kind> returns the reader envelope for all three kinds', async () => {
  await withServer(STATE(), async (url) => {
    for (const kind of ['route', 'store', 'tree']) {
      const r = await fetch(`${url}/api/state/${kind}`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, data: { kind } });
    }
  });
});

test('GET /api/state/<unknown> is 404', async () => {
  await withServer(STATE(), async (url) => {
    const r = await fetch(url + '/api/state/bogus');
    assert.equal(r.status, 404);
  });
});

test('POST /api/state/route is refused (405) — reads only', async () => {
  let called = false;
  await withServer(
    STATE({
      read: async () => {
        called = true;
        return { ok: true };
      },
    }),
    async (url) => {
      const r = await fetch(url + '/api/state/route', { method: 'POST' });
      assert.equal(r.status, 405);
      assert.equal(called, false);
    },
  );
});

test('without state deps the endpoint is 501', async () => {
  const s = new ObservabilityServer(recorder);
  const { url } = await s.start();
  try {
    const r = await fetch(url + '/api/state/route');
    assert.equal(r.status, 501);
  } finally {
    await s.stop();
  }
});

test('a rejecting reader is a 500 json error, not a crash', async () => {
  await withServer(
    STATE({
      read: async () => {
        throw new Error('reader blew up');
      },
    }),
    async (url) => {
      const r = await fetch(url + '/api/state/route');
      assert.equal(r.status, 500);
      assert.match(((await r.json()) as { error: string }).error, /reader blew up/);
    },
  );
});

test('cross-site requests are blocked by the same-origin guard', async () => {
  await withServer(STATE(), async (url) => {
    const r = await fetch(url + '/api/state/route', {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(r.status, 403);
  });
});
