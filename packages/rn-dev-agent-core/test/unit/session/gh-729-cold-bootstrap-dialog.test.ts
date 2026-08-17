import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthorityGate } from '../../../dist/session/authority-gate.js';
import { provenMetroOriginMismatch } from '../../../dist/session/metro-origin.js';
import { SessionAuthorityError } from '../../../dist/session/registry.js';
import { okResult } from '../../../dist/utils.js';

// GH #729: on a cold Expo dev-client bootstrap the app cannot attach to the
// bound Metro until the SpringBoard "Open in <app>?" confirmation is
// dismissed, so the dialog tools must dispatch while origin evidence is still
// unprovable — and keep refusing fail-closed on a proven foreign origin.

const APP_ID = 'com.example.app';

function gateFixture() {
  const operationAxes = new Set();
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
    source: { kind: 'git', appRoot: process.cwd() },
    bindings: {
      install: { digest: 'install', platform: 'ios', deviceId: 'device', appId: APP_ID },
      metro: { instanceId: 'metro', port: 8082 },
      bundle: {
        targetId: 'target',
        connectionGeneration: 1,
        authorityScope: 'initial-bundle',
        sourceFidelity: 'not-proven',
      },
      device: { platform: 'ios', deviceId: 'device', appId: APP_ID },
      runner: { instanceId: 'runner' },
    },
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const registry = {
    beginOperation: (_session, input) => {
      operationAxes.clear();
      for (const axis of input.profile) operationAxes.add(axis);
      return {
        operationId: input.operationId,
        sessionId: 'session-a',
        claimEpoch: 4,
        authorityVersion: 9,
      };
    },
    getClaim: () => null,
    verifyOperation: () => {},
    operationHasAxis: (_operation, axis) => operationAxes.has(axis),
    beginOperationAxisAdmission: () => {},
    completeOperationAxisAdmission: (_operation, axis, admitted) => {
      if (admitted) operationAxes.add(axis);
    },
    runWithOperation: async (_operation, callback) => callback(),
    commitPlatformAuthorityReceipts: () => {},
    endOperation: () => {},
    cancelOperation: () => {},
    updateBindings: () => {},
    endOperationWithBindings: () => {},
    refreshOperation: (current) => current,
    replaceBindingsDuringOperation: (current) => current,
  };
  const runtime = {
    requireAvailable: () => ({ registry, session: { sessionId: 'session-a', claimEpoch: 4 } }),
    status: () => status,
  };
  return { runtime, status };
}

const coldBootstrapRefusal = () =>
  new SessionAuthorityError(
    'METRO_ORIGIN_MISMATCH',
    'the claimed device app is not attached to the authority-bound Metro',
  );

const provenForeignOrigin = () =>
  provenMetroOriginMismatch(
    8082,
    { platform: 'ios', deviceId: 'device', appId: APP_ID },
    { port: 8081, targetDeviceName: 'Session iPhone' },
  );

for (const tool of ['device_accept_system_dialog', 'device_dismiss_system_dialog']) {
  test(`${tool} dispatches during cold bootstrap while the app is not yet attached`, async () => {
    const { runtime } = gateFixture();
    let dispatched = false;
    const probes = [];
    const gate = createAuthorityGate(runtime, {
      probe: async ({ axis, phase }) => {
        if (phase === 'preflight') probes.push(axis);
        if (axis === 'A') throw coldBootstrapRefusal();
        return { axis, identity: `${axis}-identity` };
      },
    });

    const result = await gate.wrap(tool, async () => {
      dispatched = true;
      return okResult({ tapped: true, matchedLabel: 'Open', via: 'rn-fast-runner' });
    })({});
    const envelope = JSON.parse(result.content[0].text);

    assert.equal(dispatched, true);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.meta.originAuthority, 'not-proven');
    assert.equal(
      envelope.meta.authorityReceipt.axes.some(({ axis }) => axis === 'M' || axis === 'A'),
      false,
    );
    assert.deepEqual(
      probes.filter((axis) => ['C', 'S', 'I', 'D', 'R'].includes(axis)).sort(),
      ['C', 'D', 'I', 'R', 'S'],
    );
  });

  test(`${tool} refuses fail-closed on a proven foreign Metro origin without dispatch`, async () => {
    const { runtime } = gateFixture();
    let dispatched = false;
    const gate = createAuthorityGate(runtime, {
      probe: async ({ axis }) => {
        if (axis === 'A') throw provenForeignOrigin();
        return { axis, identity: `${axis}-identity` };
      },
    });

    const result = await gate.wrap(tool, async () => {
      dispatched = true;
      return okResult({ tapped: true });
    })({});
    const envelope = JSON.parse(result.content[0].text);

    assert.equal(dispatched, false);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'METRO_ORIGIN_MISMATCH');
    assert.equal(envelope.meta.foreignMetroPort, 8081);
  });
}

test('a wrong-device argument refuses before any dialog dispatch during cold bootstrap', async () => {
  const { runtime } = gateFixture();
  let dispatched = false;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => {
      if (axis === 'A') throw coldBootstrapRefusal();
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('device_accept_system_dialog', async () => {
    dispatched = true;
    return okResult({ tapped: true });
  })({ platform: 'android' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(dispatched, false);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'DEVICE_AUTHORITY_MISMATCH');
});

test('lost runner ownership refuses the bootstrap dialog without dispatch', async () => {
  const { runtime } = gateFixture();
  let dispatched = false;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => {
      if (axis === 'R') {
        throw new SessionAuthorityError(
          'RUNNER_OWNERSHIP_MISMATCH',
          'runner instance is owned by another session',
        );
      }
      if (axis === 'A') throw coldBootstrapRefusal();
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('device_accept_system_dialog', async () => {
    dispatched = true;
    return okResult({ tapped: true });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(dispatched, false);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'RUNNER_OWNERSHIP_MISMATCH');
});

test('the bootstrap admission does not extend to runtime-bound tools before attachment', async () => {
  const { runtime, status } = gateFixture();
  delete status.bindings.bundle;
  let dispatched = false;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('cdp_navigate', async () => {
    dispatched = true;
    return okResult({ navigated: true });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(dispatched, false);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'BUNDLE_HANDSHAKE_UNAVAILABLE');
});

for (const tool of ['device_accept_system_dialog', 'device_dismiss_system_dialog']) {
  test(`${tool} keeps the proven post-attachment path unchanged`, async () => {
    const { runtime } = gateFixture();
    let dispatched = false;
    const gate = createAuthorityGate(runtime, {
      probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
    });

    const result = await gate.wrap(tool, async () => {
      dispatched = true;
      return okResult({ tapped: true, matchedLabel: 'Allow' });
    })({});
    const envelope = JSON.parse(result.content[0].text);

    assert.equal(dispatched, true);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.meta.originAuthority, 'proven');
    assert.deepEqual(
      envelope.meta.authorityReceipt.axes
        .map(({ axis }) => axis)
        .filter((axis) => axis === 'M' || axis === 'A'),
      ['M', 'A'],
    );
  });
}
