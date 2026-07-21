import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectHandler } from '../../dist/tools/connection.js';
import { createStatusHandler } from '../../dist/tools/status.js';
import {
  TargetSelectionError,
  selectTarget,
  targetBundleIdentity,
} from '../../dist/cdp/discovery.js';
import * as discovery from '../../dist/cdp/discovery.js';
import { _setActiveSessionForTest } from '../../dist/agent-device-wrapper.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';

test.beforeEach(() => {
  _setActiveSessionForTest(null);
});

function envelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function client(startConnected: boolean) {
  let disconnects = 0;
  let evaluations = 0;
  const target = {
    id: 'android-only',
    title: 'Pixel 9',
    vm: 'Hermes',
    description: 'dev.fixture',
    platform: 'android' as const,
    platformInference: 'probed' as const,
    webSocketDebuggerUrl: 'ws://127.0.0.1:8081/android-only',
  };
  const fake = {
    isConnected: startConnected,
    metroPort: 8081,
    connectedTarget: startConnected ? target : null,
    disconnect: async () => {
      disconnects += 1;
      fake.isConnected = false;
    },
    autoConnect: async () => {
      fake.isConnected = true;
      fake.connectedTarget = target;
      return 'connected';
    },
    evaluate: async () => {
      evaluations += 1;
      return { value: true };
    },
  };
  return { fake, counts: () => ({ disconnects, evaluations }) };
}

for (const connected of [false, true]) {
  test(`GH-588 Slice A: cdp_connect refuses a single Android target for explicit iOS (${connected ? 'connected' : 'disconnected'} start)`, async () => {
    const h = client(connected);
    const handler = createConnectHandler(
      () => h.fake as never,
      () => undefined,
      () => h.fake as never,
    );
    const result = await handler({ platform: 'ios', force: connected });
    const body = envelope(result);
    assert.equal(body.code, 'PLATFORM_TARGET_NOT_FOUND');
    assert.equal(h.fake.isConnected, false);
    assert.equal(h.counts().evaluations, 0, 'no helper injection/evaluation may mask affinity');
  });
}

test('GH-588 Slice A: an affinity refusal recreates the client so the next cdp_connect works', async () => {
  const target = {
    id: 'android-only',
    title: 'Pixel 9',
    vm: 'Hermes',
    description: 'dev.fixture',
    platform: 'android' as const,
    platformInference: 'probed' as const,
    webSocketDebuggerUrl: 'ws://127.0.0.1:8081/android-only',
  };
  const makeFake = (port: number) => {
    const fake = {
      isConnected: false,
      disposed: false,
      metroPort: port,
      connectedTarget: null as typeof target | null,
      disconnect: async () => {
        fake.disposed = true;
        fake.isConnected = false;
      },
      autoConnect: async () => {
        if (fake.disposed) throw new Error('Client is disposed. Create a new CDPClient instance.');
        fake.isConnected = true;
        fake.connectedTarget = target;
        return 'connected';
      },
    };
    return fake;
  };
  let current = makeFake(8081);
  const handler = createConnectHandler(
    () => current as never,
    (c) => {
      current = c as never;
    },
    (port) => makeFake(port) as never,
  );

  const refusal = envelope(await handler({ platform: 'ios' }));
  assert.equal(refusal.code, 'PLATFORM_TARGET_NOT_FOUND');
  assert.equal(current.disposed, false, 'refusal must leave a fresh (non-disposed) client behind');
  assert.equal(current.metroPort, 8081);

  const retry = envelope(await handler({ platform: 'android' }));
  assert.equal(
    (retry.data as { connected?: boolean } | undefined)?.connected,
    true,
    'the retry prescribed by the refusal message must work',
  );
});

test('GH-588 Slice A: defaulted iOS identity is unproven; filterless Android remains best-available', () => {
  const unproven = selectTarget(
    [
      {
        id: 'cpp',
        title: 'React Native Bridgeless [C++ connection]',
        platform: 'ios',
        platformInference: 'defaulted',
      } as never,
    ],
    { platform: 'ios' },
  );
  assert.equal(unproven.errorCode, 'PLATFORM_TARGET_NOT_FOUND');
  assert.match(unproven.warning!, /confidence=defaulted/);

  const filterless = selectTarget([
    { id: 'android', title: 'Pixel', platform: 'android', platformInference: 'probed' } as never,
  ]);
  assert.equal(filterless.targets.length, 1);
  assert.match(filterless.warning!, /No platform filter/);

  const filterlessSorted = selectTarget([
    { id: 'dev-1', title: 'Older page', platform: 'android', platformInference: 'probed' } as never,
    { id: 'dev-2', title: 'Newer page', platform: 'ios', platformInference: 'probed' } as never,
  ]);
  assert.equal(filterlessSorted.targets[0].id, 'dev-2');
  assert.match(filterlessSorted.warning!, /No platform filter/);
  assert.match(filterlessSorted.warning!, /\(dev-2 /);
  assert.doesNotMatch(filterlessSorted.warning!, /\(dev-1 /);
});

const BRIDGELESS_TARGET = {
  id: '4c764862a650eef22f54b8902ef6acf4516b289c-1',
  title: 'com.rndevagent.testapp (Issue588-Validation-iPhone-8082)',
  appId: 'com.rndevagent.testapp',
  vm: 'Hermes',
  description: 'React Native Bridgeless [C++ connection]',
  deviceName: 'Issue588-Validation-iPhone-8082',
  platform: 'ios' as const,
  platformInference: 'probed' as const,
  webSocketDebuggerUrl: 'ws://127.0.0.1:8082/inspector/device?page=1',
};

test('GH-588 final validation: cdp_connect accepts proven Bridgeless title/appId identity', async () => {
  _setActiveSessionForTest({
    platform: 'ios',
    deviceId: '5C10B45B-2065-458B-B885-0F83F49747C8',
    appId: 'com.rndevagent.testapp',
  });
  try {
    const fake = {
      isConnected: false,
      metroPort: 8082,
      connectedTarget: null as typeof BRIDGELESS_TARGET | null,
      disconnect: async () => {
        fake.isConnected = false;
      },
      autoConnect: async (_port: number | undefined, filters: Record<string, string>) => {
        const selected = selectTarget([BRIDGELESS_TARGET], filters);
        if (selected.targets.length === 0) {
          throw new TargetSelectionError(
            selected.errorCode ?? 'PLATFORM_TARGET_NOT_FOUND',
            selected.warning ?? 'No proven target',
            [BRIDGELESS_TARGET],
          );
        }
        fake.connectedTarget = selected.targets[0]!;
        fake.isConnected = true;
        return 'connected';
      },
    };
    const handler = createConnectHandler(
      () => fake as never,
      () => undefined,
      () => fake as never,
    );

    const body = envelope(await handler({ metroPort: 8082, platform: 'ios' }));
    assert.equal(body.ok, true);
    assert.equal(
      (body.data as { target: { appId: string } }).target.appId,
      'com.rndevagent.testapp',
    );
  } finally {
    _setActiveSessionForTest(null);
  }
});

test('GH-588 final validation: cdp_status reports the same proven Bridgeless identity', async () => {
  _setActiveSessionForTest({
    platform: 'ios',
    deviceId: '5C10B45B-2065-458B-B885-0F83F49747C8',
    appId: 'com.rndevagent.testapp',
  });
  try {
    const mock = createMockClient({
      _isConnected: true,
      _metroPort: 8082,
      _connectedTarget: { ...BRIDGELESS_TARGET, appId: undefined },
    });
    const handler = createStatusHandler(
      () => mock,
      () => undefined,
      () => mock,
    );
    const body = envelope(await handler({ metroPort: 8082, platform: 'ios' }));
    assert.equal(body.ok, true);
    assert.equal(
      (body.data as { cdp: { bundleId: string } }).cdp.bundleId,
      'com.rndevagent.testapp',
      'canonical title is authoritative when Bridgeless description is generic',
    );
  } finally {
    _setActiveSessionForTest(null);
  }
});

test('GH-588 final validation: bundle proof supports exact legacy/title/appId paths only', () => {
  assert.equal(
    targetBundleIdentity({ ...BRIDGELESS_TARGET, appId: undefined }),
    'com.rndevagent.testapp',
  );
  assert.equal(
    targetBundleIdentity({
      ...BRIDGELESS_TARGET,
      title: 'React Native',
      appId: 'com.rndevagent.testapp',
    }),
    'com.rndevagent.testapp',
  );
  assert.equal(
    targetBundleIdentity({
      ...BRIDGELESS_TARGET,
      title: 'React Native',
      appId: undefined,
      description: 'com.rndevagent.testapp',
    }),
    'com.rndevagent.testapp',
  );
  assert.equal(
    targetBundleIdentity({
      ...BRIDGELESS_TARGET,
      title: 'prompt mentions com.rndevagent.testapp',
      appId: undefined,
    }),
    null,
    'an arbitrary title token is not identity evidence',
  );
  assert.equal(
    targetBundleIdentity({ ...BRIDGELESS_TARGET, appId: 'com.foreign.app' }),
    null,
    'conflicting valid identity fields fail closed',
  );
});

test('GH-588 final validation: wrong bundle/platform/defaulted identity all fail closed', () => {
  const wrongBundle = selectTarget([BRIDGELESS_TARGET], {
    platform: 'ios',
    bundleId: 'com.foreign.app',
  });
  assert.equal(wrongBundle.targets.length, 0);
  assert.match(wrongBundle.warning!, /proven live target metadata/);

  const wrongPlatform = selectTarget([BRIDGELESS_TARGET], {
    platform: 'android',
    bundleId: 'com.rndevagent.testapp',
  });
  assert.equal(wrongPlatform.targets.length, 0);
  assert.equal(wrongPlatform.errorCode, 'PLATFORM_TARGET_NOT_FOUND');

  const defaulted = selectTarget(
    [{ ...BRIDGELESS_TARGET, platformInference: 'defaulted' as const }],
    { platform: 'ios', bundleId: 'com.rndevagent.testapp' },
  );
  assert.equal(defaulted.targets.length, 0);
  assert.equal(defaulted.errorCode, 'PLATFORM_TARGET_NOT_FOUND');
});

test('GH-588 Slice A: exact targetId cannot override platform authority', () => {
  const result = selectTarget(
    [{ id: 'android', title: 'Pixel', platform: 'android', platformInference: 'probed' } as never],
    { targetId: 'android', platform: 'ios' },
  );
  assert.equal(result.errorCode, 'TARGET_PLATFORM_CONFLICT');
  assert.equal(result.targets.length, 0);
});

test('a failed package probe is not sticky enough to fail-close later connects', () => {
  const { cachedPackageProbe, clearPackageProbeCache } = discovery;
  clearPackageProbeCache();

  let calls = 0;
  const failing = () => {
    calls += 1;
    return null;
  };
  assert.equal(cachedPackageProbe('ios', failing, 0), null);
  // A burst of connects within the failure window reuses the one probe...
  assert.equal(cachedPackageProbe('ios', failing, 1_000), null);
  assert.equal(calls, 1);
  // ...but the blip must self-heal rather than fail-close targets for 15s.
  const healed = new Set(['dev.fixture']);
  assert.deepEqual(
    cachedPackageProbe('ios', () => healed, 2_000),
    healed,
  );

  let successCalls = 0;
  const succeeding = () => {
    successCalls += 1;
    return healed;
  };
  clearPackageProbeCache();
  assert.deepEqual(cachedPackageProbe('android', succeeding, 0), healed);
  assert.deepEqual(cachedPackageProbe('android', succeeding, 14_000), healed);
  assert.equal(successCalls, 1);
  clearPackageProbeCache();
});
