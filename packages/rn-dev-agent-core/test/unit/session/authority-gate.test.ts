import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthorityGate } from '../../../dist/session/authority-gate.js';
import { okResult } from '../../../dist/utils.js';

function fixture() {
  const calls = [];
  const status = {
    available: true,
    sessionId: 'session-a',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    state: 'ready',
    claimEpoch: 4,
    authorityVersion: 9,
    leaseUntilMs: 1000,
    source: { kind: 'git' },
    bindings: {
      install: {
        digest: 'install',
        platform: 'ios',
        deviceId: 'device',
        appId: 'dev.example',
      },
      metro: { instanceId: 'metro', port: 8193 },
      bundle: { authorityScope: 'initial-bundle', sourceFidelity: 'not-proven' },
      device: { platform: 'ios', deviceId: 'device', appId: 'dev.example' },
      runner: { instanceId: 'runner' },
      observe: { instanceId: 'observe' },
      proof: { runId: 'proof' },
    },
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const registry = {
    beginOperation: (_session, input) => {
      calls.push(`begin:${input.tool}`);
      return {
        operationId: input.operationId,
        sessionId: 'session-a',
        claimEpoch: 4,
        authorityVersion: 9,
      };
    },
    verifyOperation: () => calls.push('cas'),
    endOperation: () => calls.push('end'),
    replaceBindingsDuringOperation: (operation) => {
      calls.push('replace-binding');
      return { ...operation, authorityVersion: operation.authorityVersion + 1 };
    },
  };
  const runtime = {
    requireAvailable: () => ({
      registry,
      session: { sessionId: 'session-a', claimEpoch: 4 },
    }),
    status: () => status,
  };
  return { calls, runtime, status };
}

test('authoritative tools receive preflight/postflight receipts and an immediate CAS', async () => {
  const { calls, runtime } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });
  const wrapped = gate.wrap('cdp_interact', async () => {
    calls.push('dispatch');
    return okResult({ pressed: true });
  });

  const result = await wrapped({});
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityReceipt.bundle.sourceFidelity, 'not-proven');
  assert.deepEqual(
    calls.filter((call) => call.includes(':B')),
    ['preflight:B', 'postflight:B'],
  );
  assert.ok(calls.indexOf('cas') < calls.indexOf('dispatch'));
  assert.equal(calls.at(-1), 'end');
});

test('postflight drift rejects the result instead of returning a false success', async () => {
  const { runtime } = fixture();
  let postflight = false;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      if (phase === 'postflight') postflight = true;
      return {
        axis,
        identity: postflight && axis === 'D' ? 'foreign-device' : `${axis}-identity`,
      };
    },
  });

  const result = await gate.wrap('cdp_interact', async () => okResult({ pressed: true }))({});
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'AUTHORITY_LOST_DURING_OPERATION');
  assert.equal(envelope.data, undefined);
});

test('reload atomically replaces target authority and permits only B-axis identity change', async () => {
  const { runtime, calls, status } = fixture();
  status.bindings.metro.port = 8193;
  status.bindings.bundle.targetId = 'old-target';
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => ({
      axis,
      identity: axis === 'B' ? `${phase}-bundle` : `${axis}-identity`,
    }),
    refreshRuntimeBinding: async () => {
      calls.push('refresh-binding');
      status.authorityVersion += 1;
      status.bindings.bundle = {
        ...status.bindings.bundle,
        targetId: 'new-target',
      };
      return status.bindings.bundle;
    },
  });

  const result = await gate.wrap('cdp_reload', async () => okResult({ reloaded: true }))({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.deepEqual(
    calls.filter((call) => call === 'refresh-binding' || call === 'replace-binding'),
    ['refresh-binding', 'replace-binding'],
  );
  assert.equal(envelope.meta.authorityReceipt.authorityVersion, 10);
});

test('failed reload invalidates stale bundle authority under the active fence', async () => {
  const { runtime, calls, status } = fixture();
  status.bindings.metro.port = 8193;
  status.bindings.bundle.targetId = 'old-target';
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('cdp_reload', async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          code: 'RECONNECT_TIMEOUT',
          error: 'target did not return',
        }),
      },
    ],
    isError: true,
  }))({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'RECONNECT_TIMEOUT');
  assert.equal(envelope.meta.authorityInvalidated, true);
  assert.equal(calls.filter((call) => call === 'replace-binding').length, 1);
  assert.equal(
    calls.some((call) => call === 'postflight:B'),
    false,
  );
});

test('native profiles never request a live bundle probe', async () => {
  const { runtime, calls } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  await gate.wrap('device_press', async () => okResult({ pressed: true }))({});
  assert.equal(
    calls.some((call) => call.endsWith(':B')),
    false,
  );
});

test('legacy omitted targets are filled from the session before dispatch', async () => {
  const { runtime } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });
  let dispatched;
  await gate.wrap('device_deeplink', async (args) => {
    dispatched = args;
    return okResult({ opened: true });
  })({ url: 'example://route' });

  assert.equal(dispatched.platform, 'ios');
  assert.equal(dispatched.deviceId, 'device');
  assert.equal(dispatched.appId, 'dev.example');
  assert.equal(dispatched.bundleId, 'dev.example');
  assert.equal(dispatched.metroPort, 8193);
});

test('explicit target conflicts fail before the handler runs', async () => {
  const { runtime } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });
  let dispatched = false;
  const result = await gate.wrap('cdp_interact', async () => {
    dispatched = true;
    return okResult({ pressed: true });
  })({ deviceId: 'foreign-device' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(dispatched, false);
  assert.equal(envelope.code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.equal(envelope.meta.axis, 'D');
  assert.match(envelope.meta.expected, /^[a-f0-9]{16}$/);
  assert.match(envelope.meta.observed, /^[a-f0-9]{16}$/);
  assert.match(envelope.meta.nextAction, /rn_session/);
});

test('diagnostic tools stay passive and explicitly non-authoritative', async () => {
  const gate = createAuthorityGate(
    {
      requireAvailable: () => {
        throw new Error('must not be called');
      },
      status: () => ({ available: false }),
    },
    {
      probe: async () => {
        throw new Error('must not probe');
      },
    },
  );
  const result = await gate.wrap('device_list', async () => okResult({ devices: [] }))({});
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authoritative, false);
});
