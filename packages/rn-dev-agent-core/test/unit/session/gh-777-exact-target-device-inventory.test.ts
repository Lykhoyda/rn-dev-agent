import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import {
  authorizedAndroidSerial,
  cachedPackageProbe,
  clearPackageProbeCache,
  discoverExactPort,
  inferPlatforms,
  probeAndroidDeviceModels,
  probeAndroidPackages,
} from '../../../dist/cdp/discovery.js';
import type { CDPClient } from '../../../dist/cdp-client.js';
import { connectExactSessionTarget } from '../../../dist/session/connect-exact-session-target.js';

const appId = 'com.rndevagent.testapp';

// GH #777: a dedicated QA simulator name carries no platform token, so neither
// inferPlatformFromDeviceName nor the dual-installed bundle probe can prove it.
const customSimulatorName = 'rn-qa';
const simulatorUdid = '59FBC743-4090-4D45-8FDC-AD13CFCB6196';

const bridgelessTarget = (overrides: Record<string, unknown> = {}) => ({
  id: 'device1-1',
  title: 'React Native Bridgeless [C++ connection]',
  description: 'React Native Bridgeless [C++ connection]',
  appId,
  type: 'node',
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/device1-1',
  deviceName: customSimulatorName,
  ...overrides,
});

test('gh-777: custom-named booted simulator with a dual-installed bundle is proven ios', () => {
  const targets = [bridgelessTarget()] as Parameters<typeof inferPlatforms>[0];
  inferPlatforms(targets, {
    readAndroid: () => new Set([appId]),
    readIOS: () => new Set([appId]),
    readIOSDeviceNames: () => new Set([customSimulatorName]),
    readAndroidDeviceModels: () => new Set(['be2013']),
  });
  assert.equal(targets[0]!.platform, 'ios');
  assert.equal(targets[0]!.platformInference, 'probed');
  assert.equal(targets[0]!.ambiguousPlatform, undefined);
});

test('gh-777: custom Android model deviceName with a dual-installed bundle is proven android', () => {
  const targets = [
    bridgelessTarget({ deviceName: 'BE2013 - 11 - API 30' }),
    bridgelessTarget({ id: 'device2-1', deviceName: 'BE2013' }),
  ] as Parameters<typeof inferPlatforms>[0];
  inferPlatforms(targets, {
    readAndroid: () => new Set([appId]),
    readIOS: () => new Set([appId]),
    readIOSDeviceNames: () => new Set([customSimulatorName]),
    readAndroidDeviceModels: () => new Set(['be2013']),
  });
  for (const target of targets) {
    assert.equal(target.platform, 'android');
    assert.equal(target.platformInference, 'probed');
  }
});

test('gh-777: a name present in both inventories stays with the fail-closed bundle inference', () => {
  const targets = [bridgelessTarget()] as Parameters<typeof inferPlatforms>[0];
  inferPlatforms(targets, {
    readAndroid: () => new Set([appId]),
    readIOS: () => new Set([appId]),
    readIOSDeviceNames: () => new Set([customSimulatorName]),
    readAndroidDeviceModels: () => new Set([customSimulatorName]),
  });
  assert.equal(targets[0]!.platform, 'ios');
  assert.equal(targets[0]!.platformInference, 'ambiguous');
  assert.equal(targets[0]!.ambiguousPlatform, true);
});

// One-sided inventory evidence with the other probe unavailable mirrors the
// B116 bundle-probe semantics (a null set never claims the name) — failing
// closed here would strand every custom-named simulator on a Mac without adb.
test('gh-777: iOS inventory match with Android tooling unavailable stays proven ios', () => {
  const targets = [bridgelessTarget()] as Parameters<typeof inferPlatforms>[0];
  inferPlatforms(targets, {
    readAndroid: () => new Set([appId]),
    readIOS: () => new Set([appId]),
    readIOSDeviceNames: () => new Set([customSimulatorName]),
    readAndroidDeviceModels: () => null,
  });
  assert.equal(targets[0]!.platform, 'ios');
  assert.equal(targets[0]!.platformInference, 'probed');
});

test('gh-777: Android inventory match with simctl unavailable stays proven android', () => {
  const targets = [bridgelessTarget({ deviceName: 'BE2013' })] as Parameters<
    typeof inferPlatforms
  >[0];
  inferPlatforms(targets, {
    readAndroid: () => new Set([appId]),
    readIOS: () => new Set([appId]),
    readIOSDeviceNames: () => null,
    readAndroidDeviceModels: () => new Set(['be2013']),
  });
  assert.equal(targets[0]!.platform, 'android');
  assert.equal(targets[0]!.platformInference, 'probed');
});

test('gh-777: unavailable device inventory preserves the ambiguous fail-close', () => {
  const targets = [bridgelessTarget()] as Parameters<typeof inferPlatforms>[0];
  inferPlatforms(targets, {
    readAndroid: () => new Set([appId]),
    readIOS: () => new Set([appId]),
    readIOSDeviceNames: () => null,
    readAndroidDeviceModels: () => null,
  });
  assert.equal(targets[0]!.platformInference, 'ambiguous');
  assert.equal(targets[0]!.ambiguousPlatform, true);
});

test('gh-777: targets without a deviceName never consult the device inventory', () => {
  let inventoryReads = 0;
  const targets = [bridgelessTarget({ deviceName: undefined })] as Parameters<
    typeof inferPlatforms
  >[0];
  inferPlatforms(targets, {
    readAndroid: () => new Set(),
    readIOS: () => new Set([appId]),
    readIOSDeviceNames: () => {
      inventoryReads += 1;
      return new Set([customSimulatorName]);
    },
    readAndroidDeviceModels: () => {
      inventoryReads += 1;
      return new Set();
    },
  });
  assert.equal(inventoryReads, 0);
  assert.equal(targets[0]!.platform, 'ios');
  assert.equal(targets[0]!.platformInference, 'probed');
});

// GH #777 QA follow-up: Android inventory reads are fenced to the device the
// registry binding authorizes — the same authority cdp_connect proves against.
// An ambient shared phone, or a stale device-wrapper session, is never queried.
const boundSerial = '1A2B3C4D';
const staleSerial = '9Z8Y7X6W';
const ambientPhoneSerial = '46828c2c';

function execSpy(model = 'be2013') {
  const calls: string[][] = [];
  return {
    calls,
    execute: (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (args.includes('getprop')) return `${model}\n`;
      return `package:${appId}\n`;
    },
  };
}

function noStores() {
  return { getSession: () => null, getRegistryBinding: () => null };
}

test('gh-777-qa: no bound session at all — the models probe never runs adb', () => {
  const spy = execSpy();
  const result = probeAndroidDeviceModels({ execute: spy.execute, ...noStores() });
  assert.equal(result, null);
  assert.deepEqual(spy.calls, []);
});

test('gh-777-qa: iOS registry binding before any device_snapshot open fences adb entirely', () => {
  const spy = execSpy();
  const stores = {
    getSession: () => null,
    getRegistryBinding: () => ({ platform: 'ios', deviceId: simulatorUdid }),
  };
  assert.equal(authorizedAndroidSerial(stores), null);
  assert.equal(probeAndroidDeviceModels({ execute: spy.execute, ...stores }), null);
  assert.equal(probeAndroidPackages({ execute: spy.execute, ...stores }), null);
  assert.deepEqual(spy.calls, []);
});

test('gh-777-qa: iOS device-wrapper session — no adb read runs, ambient phone untouched', () => {
  const spy = execSpy();
  const stores = {
    getSession: () => ({ platform: 'ios', deviceId: simulatorUdid }),
    getRegistryBinding: () => null,
  };
  assert.equal(authorizedAndroidSerial(stores), null);
  assert.equal(probeAndroidDeviceModels({ execute: spy.execute, ...stores }), null);
  assert.equal(probeAndroidPackages({ execute: spy.execute, ...stores }), null);
  assert.deepEqual(spy.calls, []);
});

test('gh-777-qa: a stale persisted android session with no registry binding is fenced', () => {
  const spy = execSpy();
  const stores = {
    getSession: () => ({ platform: 'android', deviceId: staleSerial }),
    getRegistryBinding: () => null,
  };
  assert.equal(authorizedAndroidSerial(stores), null);
  assert.equal(probeAndroidDeviceModels({ execute: spy.execute, ...stores }), null);
  assert.equal(probeAndroidPackages({ execute: spy.execute, ...stores }), null);
  assert.deepEqual(spy.calls, []);
});

test('gh-777-qa: a stale android session disagreeing with the registry binding is fenced', () => {
  const spy = execSpy();
  const stores = {
    getSession: () => ({ platform: 'android', deviceId: staleSerial }),
    getRegistryBinding: () => ({ platform: 'android', deviceId: boundSerial }),
  };
  assert.equal(authorizedAndroidSerial(stores), null);
  assert.equal(probeAndroidDeviceModels({ execute: spy.execute, ...stores }), null);
  assert.equal(probeAndroidPackages({ execute: spy.execute, ...stores }), null);
  assert.deepEqual(spy.calls, []);
  assert.ok(
    spy.calls.every((call) => !call.includes(staleSerial)),
    'a stale serial must never reach adb',
  );
});

test('gh-777-qa: registry-bound android device — exactly one getprop scoped to that serial', () => {
  const spy = execSpy();
  const stores = {
    getSession: () => null,
    getRegistryBinding: () => ({ platform: 'android', deviceId: boundSerial }),
  };
  assert.equal(authorizedAndroidSerial(stores), boundSerial);
  const models = probeAndroidDeviceModels({ execute: spy.execute, ...stores });
  assert.deepEqual([...(models ?? [])], ['be2013']);
  assert.deepEqual(spy.calls, [['adb', '-s', boundSerial, 'shell', 'getprop', 'ro.product.model']]);
  assert.ok(
    spy.calls.every((call) => !call.includes('devices') && !call.includes(ambientPhoneSerial)),
    'no adb devices enumeration and no ambient serial may ever be queried',
  );
});

test('gh-777-qa: registry-bound android device — package probe is scoped with -s', () => {
  const spy = execSpy();
  const stores = {
    getSession: () => ({ platform: 'android', deviceId: boundSerial }),
    getRegistryBinding: () => ({ platform: 'android', deviceId: boundSerial }),
  };
  const packages = probeAndroidPackages({ execute: spy.execute, ...stores });
  assert.ok(packages?.has(appId));
  assert.deepEqual(spy.calls, [['adb', '-s', boundSerial, 'shell', 'pm', 'list', 'packages']]);
});

test('gh-777-qa: both stores empty keeps the single pre-existing baseline read', () => {
  const spy = execSpy();
  const packages = probeAndroidPackages({ execute: spy.execute, ...noStores() });
  assert.ok(packages?.has(appId));
  assert.deepEqual(spy.calls, [['adb', 'shell', 'pm', 'list', 'packages']]);
});

// P1 (PR #782 review): an available authority runtime with NO device binding
// reports the {} sentinel, never null — a source/Metro-bound worker must not
// collapse to the ambient legacy read when the wrapper session is also empty.
test('gh-777-qa: source/Metro-bound authority with no device binding fences adb entirely', () => {
  const spy = execSpy();
  const stores = {
    getSession: () => null,
    getRegistryBinding: () => ({}),
  };
  assert.equal(authorizedAndroidSerial(stores), null);
  assert.equal(probeAndroidDeviceModels({ execute: spy.execute, ...stores }), null);
  assert.equal(probeAndroidPackages({ execute: spy.execute, ...stores }), null);
  assert.deepEqual(spy.calls, []);
});

test('gh-777-qa: a throwing registry lookup is fenced, never ambient', () => {
  const spy = execSpy();
  const stores = {
    getSession: () => null,
    getRegistryBinding: () => {
      throw new Error('authority runtime unavailable');
    },
  };
  assert.equal(authorizedAndroidSerial(stores), null);
  assert.equal(probeAndroidDeviceModels({ execute: spy.execute, ...stores }), null);
  assert.equal(probeAndroidPackages({ execute: spy.execute, ...stores }), null);
  assert.deepEqual(spy.calls, []);
});

function iosExactFixture(listedTargets: unknown[]) {
  let now = 0;
  const client = {
    metroPort: 8081,
    connectedTarget: null,
    connectionGeneration: 0,
    listTargetsExact: async () => ({ port: 8081, targets: listedTargets }),
    connectExact: async () => {
      throw new Error('connectExact must not run without an exact candidate');
    },
    disconnect: async () => {},
  };
  return {
    input: { metroPort: 8081, platform: 'ios' as const, appId, deviceId: simulatorUdid },
    dependencies: {
      getClient: () => client as unknown as CDPClient,
      setClient: () => {},
      createClient: () => client as unknown as CDPClient,
      execute: async (file: string, args: string[]) => {
        assert.equal(file, 'xcrun');
        assert.deepEqual(args, ['simctl', 'list', 'devices', '--json']);
        return {
          stdout: JSON.stringify({
            devices: {
              runtime: [{ udid: simulatorUdid, name: customSimulatorName, state: 'Booted' }],
            },
          }),
        };
      },
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
      },
    },
  };
}

test('gh-777: unproven-platform exclusion is named instead of a false "found 0"', async () => {
  const fixture = iosExactFixture([
    bridgelessTarget({ platform: 'ios', platformInference: 'ambiguous' }),
  ]);
  await assert.rejects(
    connectExactSessionTarget(fixture.input, 1_000, fixture.dependencies),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^CDP_TARGET_AUTHORITY_MISMATCH:/);
      assert.match(error.message, /platform=ios association is unproven/);
      assert.match(error.message, /confidence=ambiguous/);
      assert.doesNotMatch(error.message, /expected one target on the exact device, found 0/);
      return true;
    },
  );
});

test('gh-777: app-identity exclusion is named as the failing stage', async () => {
  const fixture = iosExactFixture([
    bridgelessTarget({
      appId: 'com.foreign.app',
      title: 'React Native Bridgeless [C++ connection]',
      platform: 'ios',
      platformInference: 'probed',
    }),
  ]);
  await assert.rejects(
    connectExactSessionTarget(fixture.input, 1_000, fixture.dependencies),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /none carries the proven app identity appId=com\.rndevagent\.testapp/,
      );
      assert.doesNotMatch(error.message, /expected one target on the exact device, found 0/);
      return true;
    },
  );
});

test('gh-777: duplicate booted simulator names keep refusing the exact-device bind', async () => {
  let now = 0;
  const target = bridgelessTarget({ platform: 'ios', platformInference: 'probed' });
  const client = {
    metroPort: 8081,
    connectedTarget: null,
    connectionGeneration: 0,
    listTargetsExact: async () => ({ port: 8081, targets: [target] }),
    connectExact: async () => {
      assert.fail('a duplicate-named device set must never reach connect');
    },
    disconnect: async () => {},
  };
  await assert.rejects(
    connectExactSessionTarget(
      { metroPort: 8081, platform: 'ios', appId, deviceId: simulatorUdid },
      1_000,
      {
        getClient: () => client as unknown as CDPClient,
        setClient: () => {},
        createClient: () => client as unknown as CDPClient,
        execute: async () => ({
          stdout: JSON.stringify({
            devices: {
              runtime: [
                { udid: simulatorUdid, name: customSimulatorName, state: 'Booted' },
                {
                  udid: '84977359-9EDE-4609-BA2D-B67DBD804A42',
                  name: customSimulatorName,
                  state: 'Booted',
                },
              ],
            },
          }),
        }),
        now: () => now,
        wait: async (ms: number) => {
          now += ms;
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^CDP_TARGET_AUTHORITY_MISMATCH:/);
      assert.match(error.message, /iOS target association is ambiguous or foreign/);
      return true;
    },
  );
});

// The Android side is fenced (no registry binding is wired in-process), so this
// exercises the one-sided iOS-inventory branch through the production readers.
test('gh-777: the real discovery path proves a custom-named simulator target', async () => {
  const server = createServer((request, response) => {
    if (request.url !== '/json/list') {
      response.writeHead(404).end();
      return;
    }
    const port = (server.address() as AddressInfo).port;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify([
        bridgelessTarget({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/device1-1` }),
      ]),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  clearPackageProbeCache();
  cachedPackageProbe('ios', () => new Set([appId]));
  cachedPackageProbe('android', () => new Set([appId]));
  cachedPackageProbe(
    'ios-booted-simulators',
    () => new Set([`${simulatorUdid}\t${customSimulatorName}\tBooted`]),
  );
  try {
    const discovered = await discoverExactPort(port, { platform: 'ios', bundleId: appId });
    assert.equal(discovered.targets.length, 1);
    assert.equal(discovered.targets[0]!.platform, 'ios');
    assert.equal(discovered.targets[0]!.platformInference, 'probed');
    assert.equal(discovered.targets[0]!.deviceName, customSimulatorName);
  } finally {
    clearPackageProbeCache();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('gh-777: device-association exclusion names the mismatched deviceName', async () => {
  const fixture = iosExactFixture([
    bridgelessTarget({
      deviceName: 'some-other-simulator',
      platform: 'ios',
      platformInference: 'probed',
    }),
  ]);
  await assert.rejects(
    connectExactSessionTarget(fixture.input, 1_000, fixture.dependencies),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^CDP_TARGET_AUTHORITY_MISMATCH:/);
      assert.match(error.message, /none is provably on device 59FBC743/);
      assert.match(error.message, /some-other-simulator/);
      return true;
    },
  );
});

test('gh-777: empty Metro target list keeps the no-targets refusal', async () => {
  const fixture = iosExactFixture([]);
  await assert.rejects(
    connectExactSessionTarget(fixture.input, 1_000, fixture.dependencies),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /advertises no debuggable targets/);
      return true;
    },
  );
});

test('gh-777: the sole custom-named exact-device target connects', async () => {
  let now = 0;
  const target = bridgelessTarget({ platform: 'ios', platformInference: 'probed' });
  const client = {
    metroPort: 8081,
    connectedTarget: null as typeof target | null,
    connectionGeneration: 0,
    listTargetsExact: async () => ({ port: 8081, targets: [target] }),
    connectExact: async () => {
      client.connectedTarget = target;
      client.connectionGeneration = 1;
    },
    disconnect: async () => {},
  };
  const connected = await connectExactSessionTarget(
    { metroPort: 8081, platform: 'ios', appId, deviceId: simulatorUdid },
    5_000,
    {
      getClient: () => client as unknown as CDPClient,
      setClient: () => assert.fail('iOS must retain the existing exact client'),
      createClient: () => client as unknown as CDPClient,
      execute: async () => ({
        stdout: JSON.stringify({
          devices: {
            runtime: [{ udid: simulatorUdid, name: customSimulatorName, state: 'Booted' }],
          },
        }),
      }),
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
      },
    },
  );
  assert.equal(connected.targetId, target.id);
  assert.equal(connected.deviceId, simulatorUdid);
});
