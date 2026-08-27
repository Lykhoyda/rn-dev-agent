import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPassiveStatusHandler } from '../../../dist/tools/status.js';

const METRO_PORT = 8193;

function authorityStatus() {
  return {
    available: true as const,
    sessionId: 'session-secret',
    sourceKey: 'source-secret',
    worktreeKey: 'worktree-secret',
    appRootKey: 'app-root-secret',
    state: 'device_bound',
    claimEpoch: 2,
    authorityVersion: 9,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings: {
      metroPort: METRO_PORT,
      metro: { mode: 'external', port: METRO_PORT },
      device: {
        platform: 'ios',
        deviceId: 'device-id-secret',
        appId: 'com.example.secret',
      },
    } as Record<string, unknown>,
    claims: [],
    worker: { instanceId: 'worker-secret', pid: 1, birthAvailable: true },
  };
}

function client() {
  return {
    isConnected: false,
    metroPort: METRO_PORT,
    connectedTarget: null,
  } as never;
}

const exactTarget = {
  id: 'target-id-secret',
  title: 'target-title-secret',
  appId: 'com.example.secret',
  deviceName: 'iPhone Secret',
  platform: 'ios' as const,
  platformInference: 'probed' as const,
  webSocketDebuggerUrl: `ws://127.0.0.1:${METRO_PORT}/secret`,
};

test('cdp_status waits passively for the exact target and omission performs zero probes', async () => {
  let now = 0;
  let listCalls = 0;
  let exactDeviceCalls = 0;
  const handler = createPassiveStatusHandler(client, { status: authorityStatus } as never, {
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
    listTargetsExact: async () => {
      listCalls += 1;
      return {
        port: METRO_PORT,
        targets: listCalls === 1 ? [] : [exactTarget],
      };
    },
    filterTargetsForExactDevice: async ({ targets }) => {
      exactDeviceCalls += 1;
      return [...targets];
    },
  });

  const immediate = await handler({});
  assert.equal(immediate.isError, undefined);
  assert.equal(listCalls, 0);
  assert.equal(exactDeviceCalls, 0);

  const waited = await handler({ waitForTargetMs: 1_000 });
  const envelope = JSON.parse(waited.content[0]!.text);
  assert.equal(waited.isError, undefined, waited.content[0]!.text);
  assert.equal(envelope.data.targetWait.outcome, 'ready');
  assert.equal(envelope.data.targetWait.probes, 2);
  assert.equal(listCalls, 2);
  assert.equal(exactDeviceCalls, 1);
  for (const secret of [
    'session-secret',
    'device-id-secret',
    'com.example.secret',
    'target-id-secret',
    'target-title-secret',
    'iPhone Secret',
  ]) {
    assert.equal(waited.content[0]!.text.includes(secret), false);
  }
});

test('cdp_status rejects foreign targets until its explicit wait deadline', async () => {
  let now = 0;
  let listCalls = 0;
  let exactDeviceCalls = 0;
  const handler = createPassiveStatusHandler(client, { status: authorityStatus } as never, {
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
    listTargetsExact: async () => {
      listCalls += 1;
      return {
        port: METRO_PORT,
        targets: [exactTarget],
      };
    },
    filterTargetsForExactDevice: async () => {
      exactDeviceCalls += 1;
      return [];
    },
  });

  const result = await handler({ waitForTargetMs: 500 });
  const envelope = JSON.parse(result.content[0]!.text);
  assert.equal(result.isError, true);
  assert.equal(envelope.code, 'CDP_TARGET_WAIT_TIMEOUT');
  assert.equal(envelope.meta.targetWait.outcome, 'timeout');
  assert.deepEqual(envelope.meta.targetWait.lastObservation, {
    advertisedTargetCount: 1,
    sessionTargetCount: 1,
    exactTargetCount: 0,
  });
  assert.equal(envelope.meta.targetWait.elapsedMs, 500);
  assert.equal(listCalls, 2);
  assert.equal(exactDeviceCalls, 2);
});

test('cdp_status preserves exact-device authority refusal without leaking probe details', async () => {
  const handler = createPassiveStatusHandler(client, { status: authorityStatus } as never, {
    listTargetsExact: async () => ({ port: METRO_PORT, targets: [exactTarget] }),
    filterTargetsForExactDevice: async () => {
      throw new Error(
        'CDP_TARGET_AUTHORITY_MISMATCH: foreign device /private/secret/device-id-secret',
      );
    },
  });

  const result = await handler({ waitForTargetMs: 1_000 });
  const envelope = JSON.parse(result.content[0]!.text);
  assert.equal(result.isError, true);
  assert.equal(envelope.code, 'CDP_TARGET_AUTHORITY_MISMATCH');
  assert.equal(envelope.error.includes('/private/secret'), false);
  assert.equal(result.content[0]!.text.includes('device-id-secret'), false);
});

test('cdp_status refuses when exact-device association cannot be measured', async () => {
  const handler = createPassiveStatusHandler(client, { status: authorityStatus } as never, {
    listTargetsExact: async () => ({ port: METRO_PORT, targets: [exactTarget] }),
    filterTargetsForExactDevice: async () => {
      throw new Error('xcrun inventory failed at /private/secret/inventory');
    },
  });

  const result = await handler({ waitForTargetMs: 1_000 });
  const envelope = JSON.parse(result.content[0]!.text);
  assert.equal(result.isError, true);
  assert.equal(envelope.code, 'CDP_TARGET_AUTHORITY_MISMATCH');
  assert.equal(result.content[0]!.text.includes('/private/secret'), false);
});

test('cdp_status wait redacts an unavailable authority reason', async () => {
  let listCalls = 0;
  const handler = createPassiveStatusHandler(
    client,
    {
      status: () => ({
        available: false,
        code: 'SESSION_NOT_INITIALIZED',
        reason: 'registry failed at /private/secret/session-source',
      }),
    } as never,
    {
      listTargetsExact: async () => {
        listCalls += 1;
        return { port: METRO_PORT, targets: [] };
      },
      filterTargetsForExactDevice: async ({ targets }) => [...targets],
    },
  );

  const result = await handler({ waitForTargetMs: 1_000 });
  const envelope = JSON.parse(result.content[0]!.text);
  assert.equal(result.isError, true);
  assert.equal(envelope.code, 'SESSION_NOT_INITIALIZED');
  assert.equal(result.content[0]!.text.includes('/private/secret'), false);
  assert.equal(listCalls, 0);
});

test('cdp_status does not report ready after the exact authority binding changes', async () => {
  let now = 0;
  let statusCalls = 0;
  const changedAuthority = {
    ...authorityStatus(),
    authorityVersion: 10,
    bindings: {
      ...authorityStatus().bindings,
      device: {
        platform: 'ios',
        deviceId: 'replacement-device',
        appId: 'com.example.replacement',
      },
    },
  };
  const handler = createPassiveStatusHandler(
    client,
    {
      status: () => {
        statusCalls += 1;
        return statusCalls === 1 ? authorityStatus() : changedAuthority;
      },
    } as never,
    {
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
      listTargetsExact: async () => ({ port: METRO_PORT, targets: [exactTarget] }),
      filterTargetsForExactDevice: async ({ targets }) => [...targets],
    },
  );

  const result = await handler({ waitForTargetMs: 500 });
  const envelope = JSON.parse(result.content[0]!.text);
  assert.equal(result.isError, true);
  assert.equal(envelope.code, 'CDP_TARGET_WAIT_TIMEOUT');
  assert.equal(envelope.meta.targetWait.outcome, 'timeout');
});

test('cdp_status ready response uses the authority snapshot that proved the target', async () => {
  let statusCalls = 0;
  const changedAuthority = {
    ...authorityStatus(),
    authorityVersion: 10,
    bindings: {
      ...authorityStatus().bindings,
      device: {
        platform: 'android',
        deviceId: 'replacement-device',
        appId: 'com.example.replacement',
      },
    },
  };
  const handler = createPassiveStatusHandler(
    client,
    {
      status: () => {
        statusCalls += 1;
        return statusCalls <= 2 ? authorityStatus() : changedAuthority;
      },
    } as never,
    {
      listTargetsExact: async () => ({ port: METRO_PORT, targets: [exactTarget] }),
      filterTargetsForExactDevice: async ({ targets }) => [...targets],
    },
  );

  const result = await handler({ waitForTargetMs: 1_000 });
  const envelope = JSON.parse(result.content[0]!.text);
  assert.equal(result.isError, undefined, result.content[0]!.text);
  assert.equal(envelope.data.targetWait.outcome, 'ready');
  assert.equal(envelope.data.authority.platform, 'ios');
  assert.equal(statusCalls, 2);
});

test('cdp_status rejects target proof that resolves after the absolute deadline', async () => {
  let now = 0;
  const handler = createPassiveStatusHandler(client, { status: authorityStatus } as never, {
    now: () => now,
    listTargetsExact: async () => ({ port: METRO_PORT, targets: [exactTarget] }),
    filterTargetsForExactDevice: async ({ targets }) => {
      now = 1_001;
      return [...targets];
    },
  });

  const result = await handler({ waitForTargetMs: 1_000 });
  const envelope = JSON.parse(result.content[0]!.text);
  assert.equal(result.isError, true);
  assert.equal(envelope.code, 'CDP_TARGET_WAIT_TIMEOUT');
  assert.equal(envelope.meta.targetWait.outcome, 'timeout');
});

test('cdp_status absolute deadline bounds a stalled exact-port probe', async () => {
  const handler = createPassiveStatusHandler(client, { status: authorityStatus } as never, {
    listTargetsExact: () => new Promise(() => {}),
    filterTargetsForExactDevice: async ({ targets }) => [...targets],
  });
  const startedAt = Date.now();
  const result = await handler({ waitForTargetMs: 20 });
  const elapsedMs = Date.now() - startedAt;
  const envelope = JSON.parse(result.content[0]!.text);

  assert.equal(result.isError, true);
  assert.equal(envelope.code, 'CDP_TARGET_WAIT_TIMEOUT');
  assert.ok(elapsedMs < 250, `absolute target wait took ${elapsedMs}ms`);
});
