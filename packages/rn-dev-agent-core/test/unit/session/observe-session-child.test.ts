import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObservabilityServer } from '../../../dist/observability/server.js';
import { Recorder } from '../../../dist/observability/recorder.js';

const authority = {
  sessionId: 'session-child',
  claimEpoch: 7,
  instanceId: 'observe-live',
  capability: 'capability-live',
};

function headers(value = authority) {
  return {
    authorization: `Bearer ${value.capability}`,
    'x-rn-observe-instance': value.instanceId,
  };
}

test('Observe serves a session-bound view without any device authority', async () => {
  const server = new ObservabilityServer(
    new Recorder(),
    undefined,
    undefined,
    undefined,
    authority,
  );
  const { url } = await server.start();
  try {
    const origin = new URL(url).origin;
    assert.equal((await fetch(origin)).status, 200);
    const identity = await fetch(`${origin}/api/authority`, { headers: headers() });
    assert.equal(identity.status, 200);
    assert.deepEqual(await identity.json(), {
      sessionId: 'session-child',
      claimEpoch: 7,
      instanceId: 'observe-live',
    });
    const state = await fetch(`${origin}/api/state/route`, { headers: headers() });
    assert.equal(state.status, 501);
  } finally {
    await server.stop();
  }
});

test('Observe refuses stale or foreign endpoint identity on every API request', async () => {
  const server = new ObservabilityServer(
    new Recorder(),
    undefined,
    undefined,
    undefined,
    authority,
  );
  const { url } = await server.start();
  try {
    const origin = new URL(url).origin;
    const invalid: RequestInit[] = [
      {},
      { headers: headers({ ...authority, capability: 'capability-forged' }) },
      { headers: headers({ ...authority, instanceId: 'observe-from-crashed-session' }) },
    ];
    for (const init of invalid) {
      assert.equal((await fetch(`${origin}/api/authority`, init)).status, 403);
      assert.equal((await fetch(`${origin}/api/state/route`, init)).status, 403);
    }
  } finally {
    await server.stop();
  }
});

test('mutating e2e routes stay behind CSRF and their gated tool handlers', async () => {
  const invoked: string[] = [];
  const e2e = {
    token: 'csrf-token-1',
    triggerRun: async (pattern?: string) => {
      invoked.push(`run:${pattern ?? ''}`);
      return { started: true };
    },
    listRuns: async () => [],
    loadRun: async () => null,
    listActions: async () => [],
    runAction: async (actionId: string) => {
      invoked.push(`action:${actionId}`);
      return { ok: false as const, error: 'SESSION_AUTHORITY_REQUIRED: refused by the tool gate' };
    },
  };
  const server = new ObservabilityServer(new Recorder(), e2e, undefined, undefined, authority);
  const { url } = await server.start();
  try {
    const origin = new URL(url).origin;
    const authenticated = { ...headers(), 'content-type': 'application/json' };
    const noCsrfRun = await fetch(`${origin}/api/e2e/run`, {
      method: 'POST',
      headers: authenticated,
      body: '{}',
    });
    assert.equal(noCsrfRun.status, 403);
    const noCsrfAction = await fetch(`${origin}/api/e2e/actions/run`, {
      method: 'POST',
      headers: authenticated,
      body: JSON.stringify({ actionId: 'login' }),
    });
    assert.equal(noCsrfAction.status, 403);
    assert.deepEqual(invoked, []);

    const csrf = { ...authenticated, 'x-csrf-token': 'csrf-token-1' };
    const run = await fetch(`${origin}/api/e2e/run`, { method: 'POST', headers: csrf, body: '{}' });
    assert.equal(run.status, 200);
    const action = await fetch(`${origin}/api/e2e/actions/run`, {
      method: 'POST',
      headers: csrf,
      body: JSON.stringify({ actionId: 'login' }),
    });
    assert.equal(action.status, 500);
    assert.deepEqual(invoked, ['run:', 'action:login']);
  } finally {
    await server.stop();
  }
});
