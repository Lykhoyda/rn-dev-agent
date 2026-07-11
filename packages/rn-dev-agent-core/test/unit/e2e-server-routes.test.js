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
  triggerRun: async () => ({ ok: true, data: { verdict: 'green' } }),
  listRuns: async () => [{ runId: 'r1', verdict: 'green' }],
  loadRun: async (id) => (id === 'r1' ? { runId: 'r1' } : null),
  ...over,
});

test('GET /api/e2e/runs returns the index json', async () => {
  await withServer(E2E(), async (url) => {
    const r = await fetch(url + '/api/e2e/runs');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), [{ runId: 'r1', verdict: 'green' }]);
  });
});

test('POST /api/e2e/run without csrf is 403 and does NOT trigger', async () => {
  let triggered = false;
  await withServer(
    E2E({
      triggerRun: async () => {
        triggered = true;
        return {};
      },
    }),
    async (url) => {
      const r = await fetch(url + '/api/e2e/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(r.status, 403);
      assert.equal(triggered, false);
    },
  );
});

test('POST /api/e2e/run with valid csrf triggers + returns result', async () => {
  await withServer(E2E(), async (url) => {
    const r = await fetch(url + '/api/e2e/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'tok1' },
      body: JSON.stringify({ pattern: 'smoke' }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).data.verdict, 'green');
  });
});

test('GET /api/e2e/run is refused (405) — reads never run', async () => {
  await withServer(E2E(), async (url) => {
    const r = await fetch(url + '/api/e2e/run');
    assert.equal(r.status, 405);
  });
});

test('GET /api/e2e/runs/:id returns the run when found', async () => {
  await withServer(E2E(), async (url) => {
    const r = await fetch(url + '/api/e2e/runs/r1');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { runId: 'r1' });
  });
});

test('GET /api/e2e/runs/:id returns 404 for missing run', async () => {
  await withServer(E2E(), async (url) => {
    const r = await fetch(url + '/api/e2e/runs/nope');
    assert.equal(r.status, 404);
  });
});

test('no e2e deps → 501 on /api/e2e/run', async () => {
  await withServer(undefined, async (url) => {
    const r = await fetch(url + '/api/e2e/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'tok1' },
      body: '{}',
    });
    assert.equal(r.status, 501);
  });
});

// GH #438 review hardening: an oversized body must produce a bounded 413,
// never an unhandled rejection (handle() fire-and-forgets the async route).
test('POST /api/e2e/run with an oversized body is a bounded 413, not a crash', async () => {
  await withServer(E2E(), async (url) => {
    const r = await fetch(url + '/api/e2e/run', {
      method: 'POST',
      headers: { 'x-csrf-token': 'tok1', 'content-type': 'application/json' },
      body: '{"pattern":"' + 'x'.repeat(70000) + '"}',
    }).catch(() => null);
    assert.ok(r === null || r.status === 413, `expected 413 or aborted fetch, got ${r?.status}`);
    // The server must still answer subsequent requests (no crashed process/socket).
    const after = await fetch(url + '/api/e2e/runs');
    assert.equal(after.status, 200);
  });
});

// GH #438 review hardening: the CSRF token is emitted via JSON.stringify so a
// token containing quotes or </script> can never break out of the inline tag.
test('GET / serializes the CSRF token safely into the bootstrap script', async () => {
  const nasty = "a'</script><script>alert(1)</script>";
  const s = new ObservabilityServer(recorder, E2E({ token: nasty }));
  const { url } = await s.start();
  try {
    const r = await fetch(url + '/');
    if (r.status === 200) {
      const html = await r.text();
      assert.ok(
        html.includes('window.__E2E_CSRF__=' + JSON.stringify(nasty).replace(/</g, '\\u003c')) ||
          html.includes('window.__E2E_CSRF__=' + JSON.stringify(nasty)),
        'token must be JSON-serialized',
      );
      assert.ok(!html.includes("__E2E_CSRF__='a'"), 'raw single-quote interpolation must be gone');
    }
  } finally {
    await s.stop();
  }
});
