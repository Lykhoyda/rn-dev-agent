import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObservabilityServer, type E2eServerDeps } from '../../../dist/observability/server.js';
import { ObserveRootUnavailableError } from '../../../dist/observability/observe-project-root.js';
import { recorder } from '../../../dist/observability/recorder.js';

const REASON = 'session app root is not a React Native project (/pool/rn-dev-agent)';

function refusingDeps(): E2eServerDeps {
  const refuse = (): never => {
    throw new ObserveRootUnavailableError(REASON);
  };
  return {
    token: 'tok1',
    triggerRun: async () => refuse(),
    listRuns: async () => refuse(),
    loadRun: async () => refuse(),
    listActions: async () => refuse(),
    runAction: async () => refuse(),
  };
}

async function withServer(
  e2e: E2eServerDeps | undefined,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server = new ObservabilityServer(recorder, e2e);
  const { url } = await server.start();
  try {
    await fn(url);
  } finally {
    await server.stop();
  }
}

test('GET /api/e2e/actions refuses truthfully when no project root resolves', async () => {
  await withServer(refusingDeps(), async (url) => {
    const r = await fetch(`${url}/api/e2e/actions`);
    assert.equal(r.status, 503);
    const body = (await r.json()) as { error: string; code: string };
    assert.equal(body.error, REASON);
    assert.equal(body.code, 'PROJECT_ROOT_UNAVAILABLE');
  });
});

test('GET /api/e2e/runs refuses truthfully when no project root resolves', async () => {
  await withServer(refusingDeps(), async (url) => {
    const r = await fetch(`${url}/api/e2e/runs`);
    assert.equal(r.status, 503);
    const body = (await r.json()) as { error: string; code: string };
    assert.equal(body.error, REASON);
    assert.equal(body.code, 'PROJECT_ROOT_UNAVAILABLE');
  });
});

test('GET /api/e2e/runs/:id refuses truthfully when no project root resolves', async () => {
  await withServer(refusingDeps(), async (url) => {
    const r = await fetch(`${url}/api/e2e/runs/run-1`);
    assert.equal(r.status, 503);
    const body = (await r.json()) as { error: string; code: string };
    assert.equal(body.error, REASON);
    assert.equal(body.code, 'PROJECT_ROOT_UNAVAILABLE');
  });
});

test('POST /api/e2e/run refuses truthfully when no project root resolves', async () => {
  await withServer(refusingDeps(), async (url) => {
    const r = await fetch(`${url}/api/e2e/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'tok1' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 503);
    const body = (await r.json()) as { error: string; code: string };
    assert.equal(body.error, REASON);
    assert.equal(body.code, 'PROJECT_ROOT_UNAVAILABLE');
  });
});

test('POST /api/e2e/actions/run reports the refusal through its ok:false result contract', async () => {
  await withServer(
    {
      ...refusingDeps(),
      runAction: async () => ({ ok: false as const, error: REASON }),
    },
    async (url) => {
      const r = await fetch(`${url}/api/e2e/actions/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'tok1' },
        body: JSON.stringify({ actionId: 'login' }),
      });
      assert.equal(r.status, 500);
      const body = (await r.json()) as { ok: boolean; error: string };
      assert.equal(body.ok, false);
      assert.equal(body.error, REASON);
    },
  );
});

test('unexpected errors still return the generic 500', async () => {
  await withServer(
    {
      ...refusingDeps(),
      listActions: async () => {
        throw new Error('disk exploded');
      },
    },
    async (url) => {
      const r = await fetch(`${url}/api/e2e/actions`);
      assert.equal(r.status, 500);
      const body = (await r.json()) as { error: string };
      assert.equal(body.error, 'internal server error');
    },
  );
});
