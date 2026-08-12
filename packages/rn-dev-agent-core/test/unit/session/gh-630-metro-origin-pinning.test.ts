import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthorityGate } from '../../../dist/session/authority-gate.js';
import { pinExactDevClient } from '../../../dist/session/dev-client-authority.js';
import { createLocalAuthorityProbe } from '../../../dist/session/local-authority-probe.js';
import {
  createForeignMetroOriginScanner,
  findForeignMetroOrigin,
  isProvenMetroOriginMismatch,
  memoizeForeignMetroOriginScanner,
  provenMetroOriginMismatch,
} from '../../../dist/session/metro-origin.js';
import { SessionAuthorityError } from '../../../dist/session/registry.js';
import { createSessionHandler } from '../../../dist/tools/session.js';
import { okResult } from '../../../dist/utils.js';

const SESSION_DEVICE = 'SIM-SESSION';
const SESSION_DEVICE_NAME = 'Session iPhone';
const SIBLING_DEVICE_NAME = 'Sibling iPhone';
const APP_ID = 'com.example.app';

function hermesTarget(port, deviceName, id = `${deviceName}-target`) {
  return {
    id,
    title: `${APP_ID} (${deviceName})`,
    appId: APP_ID,
    vm: 'Hermes',
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${id}`,
    deviceName,
  };
}

function simctlListWithSessionDeviceBooted() {
  return JSON.stringify({
    devices: {
      'iOS-18': [
        { udid: SESSION_DEVICE, name: SESSION_DEVICE_NAME, state: 'Booted' },
        { udid: 'SIM-SIBLING', name: SIBLING_DEVICE_NAME, state: 'Booted' },
      ],
    },
  });
}

function scannerWith(overrides = {}) {
  return createForeignMetroOriginScanner(
    { execute: async () => ({ stdout: simctlListWithSessionDeviceBooted() }) },
    {
      listSiblingMetroPorts: async () => [8081],
      fetchPortTargets: async (port) => [
        hermesTarget(port, SIBLING_DEVICE_NAME),
        hermesTarget(port, SESSION_DEVICE_NAME),
      ],
      ...overrides,
    },
  );
}

const query = {
  expectedMetroPort: 8082,
  platform: 'ios',
  deviceId: SESSION_DEVICE,
  appId: APP_ID,
};

test('foreign-origin scan proves a dev-client fallback onto a sibling Metro', async () => {
  const evidence = await scannerWith()(query);

  assert.deepEqual(evidence, { port: 8081, targetDeviceName: SESSION_DEVICE_NAME });
});

test('foreign-origin scan stays unprovable when only the sibling device is attached elsewhere', async () => {
  const evidence = await scannerWith({
    fetchPortTargets: async (port) => [hermesTarget(port, SIBLING_DEVICE_NAME)],
  })(query);

  assert.equal(evidence, null);
});

test('foreign-origin scan ignores targets a sibling Metro advertises for another port', async () => {
  const evidence = await scannerWith({
    fetchPortTargets: async () => [hermesTarget(9999, SESSION_DEVICE_NAME)],
  })(query);

  assert.equal(evidence, null);
});

test('foreign-origin scan rejects cross-platform device-name collisions', async () => {
  const collidingName = 'Pixel 7';
  const scan = createForeignMetroOriginScanner(
    {
      execute: async () => ({
        stdout: JSON.stringify({
          devices: {
            'iOS-18': [{ udid: SESSION_DEVICE, name: collidingName, state: 'Booted' }],
          },
        }),
      }),
    },
    {
      listSiblingMetroPorts: async () => [8081],
      fetchPortTargets: async (port) => [hermesTarget(port, collidingName)],
    },
  );

  assert.equal(await scan(query), null);
});

test('foreign-origin scan stays unprovable when two booted simulators share the session device name', async () => {
  const scan = createForeignMetroOriginScanner(
    {
      execute: async () => ({
        stdout: JSON.stringify({
          devices: {
            'iOS-18': [
              { udid: SESSION_DEVICE, name: SESSION_DEVICE_NAME, state: 'Booted' },
              { udid: 'SIM-CLONE', name: SESSION_DEVICE_NAME, state: 'Booted' },
            ],
          },
        }),
      }),
    },
    {
      listSiblingMetroPorts: async () => [8081],
      fetchPortTargets: async (port) => [hermesTarget(port, SESSION_DEVICE_NAME)],
    },
  );

  assert.equal(await scan(query), null);
});

test('foreign-origin scan yields no evidence without sibling Metros or on scan failures', async () => {
  assert.equal(await scannerWith({ listSiblingMetroPorts: async () => [] })(query), null);
  assert.equal(
    await scannerWith({
      listSiblingMetroPorts: async () => {
        throw new Error('registry offline');
      },
    })(query),
    null,
  );
  assert.equal(
    await findForeignMetroOrigin(query, {
      listSiblingMetroPorts: async () => [8081],
      fetchPortTargets: async () => {
        throw new Error('sibling uninspectable');
      },
      filterForExactDevice: async () => {
        throw new Error('unreachable');
      },
    }),
    null,
  );
});

test('only a proven origin mismatch carries the fail-closed marker', () => {
  const proven = provenMetroOriginMismatch(8082, query, {
    port: 8081,
    targetDeviceName: SESSION_DEVICE_NAME,
  });
  const unprovable = new SessionAuthorityError('METRO_ORIGIN_MISMATCH', 'uninspectable');

  assert.equal(isProvenMetroOriginMismatch(proven), true);
  assert.equal(proven.code, 'METRO_ORIGIN_MISMATCH');
  assert.match(proven.message, /served by Metro :8081/);
  assert.equal(isProvenMetroOriginMismatch(unprovable), false);
  assert.equal(isProvenMetroOriginMismatch(new Error('METRO_ORIGIN_MISMATCH: plain')), false);
});

function probeStatus(bindings) {
  return {
    sessionId: 'session-a',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    state: 'ready',
    claimEpoch: 4,
    authorityVersion: 9,
    leaseUntilMs: 1000,
    source: {},
    bindings,
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
}

function probeWith(overrides = {}) {
  return createLocalAuthorityProbe({
    runtime: {
      requireAvailable: () => {
        throw new Error('not used');
      },
    },
    getClient: () => ({ isConnected: false, connectedTarget: null }),
    getSecret: () => null,
    ...overrides,
  });
}

test('axis A refuses with proven evidence when the device app fell back to a sibling Metro', async () => {
  const probe = probeWith({
    fetchTargets: async () => [],
    proveTargetDevices: async () => {
      throw new Error('no target for the claimed device');
    },
    findForeignMetroOrigin: async (scanQuery) => {
      assert.deepEqual(scanQuery, query);
      return { port: 8081, targetDeviceName: SESSION_DEVICE_NAME };
    },
  });

  await assert.rejects(
    () =>
      probe({
        axis: 'A',
        status: probeStatus({
          metro: { port: 8082 },
          device: { platform: 'ios', deviceId: SESSION_DEVICE, appId: APP_ID },
        }),
      }),
    (error) => {
      assert.equal(isProvenMetroOriginMismatch(error), true);
      assert.equal(error.details?.expected, 'Metro :8082');
      assert.match(String(error.details?.observed), /Metro :8081/);
      return true;
    },
  );
});

test('axis A stays an unprovable mismatch when no sibling Metro evidence exists', async () => {
  const probe = probeWith({
    fetchTargets: async () => [],
    proveTargetDevices: async () => {
      throw new Error('no target for the claimed device');
    },
    findForeignMetroOrigin: async () => null,
  });

  await assert.rejects(
    () =>
      probe({
        axis: 'A',
        status: probeStatus({
          metro: { port: 8082 },
          device: { platform: 'ios', deviceId: SESSION_DEVICE, appId: APP_ID },
        }),
      }),
    (error) => {
      assert.equal(error instanceof SessionAuthorityError, true);
      assert.equal(error.code, 'METRO_ORIGIN_MISMATCH');
      assert.equal(isProvenMetroOriginMismatch(error), false);
      return true;
    },
  );
});

test('axis A refuses a device binding recorded against a different Metro origin', async () => {
  let scanned = false;
  const probe = probeWith({
    fetchTargets: async () => {
      throw new Error('must not be reached');
    },
    findForeignMetroOrigin: async () => {
      scanned = true;
      return null;
    },
  });

  await assert.rejects(
    () =>
      probe({
        axis: 'A',
        status: probeStatus({
          metro: { port: 8081 },
          device: {
            platform: 'ios',
            deviceId: SESSION_DEVICE,
            appId: APP_ID,
            expectedMetroPort: 8082,
          },
        }),
      }),
    (error) => {
      assert.equal(isProvenMetroOriginMismatch(error), true);
      assert.match(error.message, /recorded Metro :8082/);
      return true;
    },
  );
  assert.equal(scanned, false);
});

test('axis A accepts a device binding pinned to the bound Metro origin', async () => {
  const probe = probeWith({
    fetchTargets: async () => [hermesTarget(8082, SESSION_DEVICE_NAME)],
    proveTargetDevices: async () => {},
  });

  const observation = await probe({
    axis: 'A',
    status: probeStatus({
      metro: { port: 8082 },
      device: {
        platform: 'ios',
        deviceId: SESSION_DEVICE,
        appId: APP_ID,
        expectedMetroPort: 8082,
      },
    }),
  });

  assert.equal(observation.axis, 'A');
});

test('repeated preflights against a killed app pay the foreign-Metro scan once', async () => {
  let scans = 0;
  const scan = scannerWith({
    listSiblingMetroPorts: async () => {
      scans += 1;
      return [8081];
    },
    fetchPortTargets: async () => [],
  });
  const probe = probeWith({
    fetchTargets: async () => [],
    proveTargetDevices: async () => {
      throw new Error('target does not expose device association');
    },
    findForeignMetroOrigin: scan,
  });
  const preflight = () =>
    probe({
      axis: 'A',
      status: probeStatus({
        metro: { port: 8082 },
        device: { platform: 'ios', deviceId: SESSION_DEVICE, appId: APP_ID },
      }),
    });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(preflight, (error) => {
      assert.equal(error.code, 'METRO_ORIGIN_MISMATCH');
      assert.equal(isProvenMetroOriginMismatch(error), false);
      return true;
    });
  }
  await Promise.all([scan(query), scan(query)]);

  assert.equal(scans, 1);
});

test('memoized scans are shared in flight, keyed per device, and re-run after invalidation', async () => {
  let scans = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const memoized = memoizeForeignMetroOriginScanner(async () => {
    scans += 1;
    await gate;
    return null;
  });
  const concurrent = [memoized(query), memoized(query), memoized({ ...query, deviceId: 'OTHER' })];
  release();

  assert.deepEqual(await Promise.all(concurrent), [null, null, null]);
  assert.equal(scans, 2);

  assert.equal(await memoized(query), null);
  assert.equal(scans, 2);

  memoized.invalidate(query);
  assert.equal(await memoized(query), null);
  assert.equal(scans, 3);
  assert.equal(await memoized({ ...query, deviceId: 'OTHER' }), null);
  assert.equal(scans, 3);

  memoized.invalidate();
  assert.equal(await memoized({ ...query, deviceId: 'OTHER' }), null);
  assert.equal(scans, 4);
});

test('an invalidated in-flight scan cannot resurrect its pre-invalidation verdict', async () => {
  let scans = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const memoized = memoizeForeignMetroOriginScanner(async () => {
    scans += 1;
    await gate;
    return null;
  });

  const overlapping = memoized(query);
  memoized.invalidate();
  release();

  assert.equal(await overlapping, null);
  assert.equal(scans, 1);
  assert.equal(await memoized(query), null);
  assert.equal(scans, 2);
});

test('memoized proven evidence expires sooner than an unprovable verdict', async () => {
  let clock = 0;
  let scans = 0;
  let evidence = { port: 8081, targetDeviceName: SESSION_DEVICE_NAME };
  const memoized = memoizeForeignMetroOriginScanner(
    async () => {
      scans += 1;
      return evidence;
    },
    { now: () => clock, unprovableTtlMs: 10_000, evidenceTtlMs: 2_000 },
  );

  assert.deepEqual(await memoized(query), evidence);
  clock = 1_999;
  assert.deepEqual(await memoized(query), evidence);
  assert.equal(scans, 1);
  clock = 2_001;
  evidence = null;
  assert.equal(await memoized(query), null);
  assert.equal(scans, 2);

  clock = 9_000;
  assert.equal(await memoized(query), null);
  assert.equal(scans, 2);
  clock = 12_002;
  assert.equal(await memoized(query), null);
  assert.equal(scans, 3);
});

test('a rejected memoized scan is never cached', async () => {
  let scans = 0;
  const memoized = memoizeForeignMetroOriginScanner(async () => {
    scans += 1;
    throw new Error('scanner exploded');
  });

  await assert.rejects(() => memoized(query), /scanner exploded/);
  await assert.rejects(() => memoized(query), /scanner exploded/);

  assert.equal(scans, 2);
});

function gateFixture() {
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
      device: { platform: 'ios', deviceId: 'device', appId: APP_ID },
      runner: { instanceId: 'runner' },
    },
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const operation = {
    operationId: 'op',
    sessionId: 'session-a',
    claimEpoch: 4,
    authorityVersion: 9,
  };
  const registry = {
    beginOperation: () => operation,
    getClaim: () => null,
    verifyOperation: () => {},
    operationHasAxis: () => true,
    beginOperationAxisAdmission: () => {},
    completeOperationAxisAdmission: () => {},
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

const provenFallback = () =>
  provenMetroOriginMismatch(
    8082,
    { platform: 'ios', deviceId: 'device', appId: APP_ID },
    { port: 8081, targetDeviceName: SESSION_DEVICE_NAME },
  );

test('raw native reads refuse fail-closed on a proven foreign Metro origin', async () => {
  const { runtime } = gateFixture();
  let dispatched = false;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => {
      if (axis === 'A') throw provenFallback();
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('device_screenshot', async () => {
    dispatched = true;
    return okResult({ path: '/tmp/foreign-device.png' });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(dispatched, false);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'METRO_ORIGIN_MISMATCH');
  assert.match(envelope.error, /served by Metro :8081/);
  assert.equal(envelope.meta.foreignMetroPort, 8081);
});

test('raw native mutations refuse fail-closed on a proven foreign Metro origin', async () => {
  const { runtime } = gateFixture();
  let dispatched = false;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => {
      if (axis === 'A') throw provenFallback();
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('device_press', async () => {
    dispatched = true;
    return okResult({ pressed: true });
  })({ testId: 'button' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(dispatched, false);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'METRO_ORIGIN_MISMATCH');
});

test('a proven foreign origin refuses native control even when the bound Metro is gone', async () => {
  const { runtime } = gateFixture();
  let dispatched = false;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => {
      if (axis === 'M') {
        throw new SessionAuthorityError('METRO_INSTANCE_CHANGED', 'bound Metro process is gone');
      }
      if (axis === 'A') throw provenFallback();
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('device_screenshot', async () => {
    dispatched = true;
    return okResult({ path: '/tmp/foreign-device.png' });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(dispatched, false);
  assert.equal(envelope.code, 'METRO_ORIGIN_MISMATCH');
});

test('an unprovable origin keeps raw native control available with a not-proven label', async () => {
  const { runtime } = gateFixture();
  let dispatched = false;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => {
      if (axis === 'A') {
        throw new SessionAuthorityError('METRO_ORIGIN_MISMATCH', 'targets uninspectable');
      }
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('device_screenshot', async () => {
    dispatched = true;
    return okResult({ path: '/tmp/session-device.png' });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(dispatched, true);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.originAuthority, 'not-proven');
});

const pinInput = {
  sessionId: 'session-a',
  metroInstanceId: 'metro-a',
  worktreeKey: 'worktree-a',
  appId: APP_ID,
  platform: 'ios',
  buildGeneration: 2,
  deviceId: SESSION_DEVICE,
  metroPort: 8082,
  runtimeKind: 'bare-react-native',
  signerCapability: 'signer',
};

function pinDependencies(overrides = {}) {
  return {
    openUrl: async () => {},
    launchExactApp: async () => {},
    launchExactAppWithInitialUrl: async () => {},
    acceptIosOpenDialog: async () => {},
    connectExact: async () => {
      throw new Error(
        'CDP_TARGET_AUTHORITY_MISMATCH: exact managed-Metro target did not re-register after launch',
      );
    },
    readMarker: async () => null,
    ...overrides,
  };
}

test('cdp_connect pin refuses with METRO_ORIGIN_MISMATCH when the device app is on a sibling Metro', async () => {
  await assert.rejects(
    () =>
      pinExactDevClient(
        pinInput,
        pinDependencies({
          detectForeignMetroOrigin: async (scanQuery) => {
            assert.equal(scanQuery.expectedMetroPort, 8082);
            assert.equal(scanQuery.deviceId, SESSION_DEVICE);
            return { port: 8081, targetDeviceName: SESSION_DEVICE_NAME };
          },
        }),
      ),
    (error) => {
      assert.equal(isProvenMetroOriginMismatch(error), true);
      assert.match(error.message, /pin_dev_client|Metro :8081/);
      return true;
    },
  );
});

test('cdp_connect pin keeps the original failure when no foreign origin is provable', async () => {
  await assert.rejects(
    () =>
      pinExactDevClient(pinInput, pinDependencies({ detectForeignMetroOrigin: async () => null })),
    /CDP_TARGET_AUTHORITY_MISMATCH: exact managed-Metro target did not re-register/,
  );
});

function bindDeviceHandler(bindings, onReplace) {
  const status = {
    sessionId: 'session-a',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    state: 'source_bound',
    claimEpoch: 1,
    authorityVersion: 1,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings,
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  return createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          replaceDeviceAuthority: (_session, input) => onReplace(input),
        },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    },
    { deviceExists: () => true },
  );
}

test('bind_device records the session Metro origin on the device binding', async () => {
  let replacement;
  const handler = bindDeviceHandler({ metroPort: 8082 }, (input) => {
    replacement = input;
  });

  const result = await handler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: SESSION_DEVICE,
    appId: APP_ID,
  });

  assert.equal(result.isError, undefined);
  assert.equal(replacement.device.expectedMetroPort, 8082);
});

test('bind_device refuses when the session has no valid Metro origin to pin', async () => {
  let replaced = false;
  const handler = bindDeviceHandler({}, () => {
    replaced = true;
  });

  const result = await handler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: SESSION_DEVICE,
    appId: APP_ID,
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /METRO_ORIGIN_MISMATCH/);
  assert.equal(replaced, false);
});
