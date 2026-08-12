// GH #750: the picker probe only takes its short readiness budget when the
// session runtime is provably absent. These cover the two ways that verdict can
// be wrong — a device probe that merely failed, and a relaunch window sampled
// once while the app is still coming up.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionRuntimeAbsenceProbe } from '../../../dist/session/session-runtime-absence.js';

const appId = 'com.rndevagent.testapp';

const iosBinding = {
  platform: 'ios' as const,
  deviceId: 'ios-device-id',
  appId,
  metroPort: 8081,
};

const sessionTarget = {
  id: 'ios-exact-1',
  title: `${appId} (iPhone 17 Pro)`,
  description: 'React Native Bridgeless [C++ connection]',
  appId,
  type: 'node',
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/ios-exact',
  deviceName: 'iPhone 17 Pro',
  platform: 'ios',
  platformInference: 'probed',
};

function probeWith(overrides: Record<string, unknown>): () => Promise<boolean> {
  return createSessionRuntimeAbsenceProbe({
    resolveBinding: () => iosBinding,
    listTargets: async () => ({ port: 8081, targets: [] }),
    execute: async () => ({ stdout: '' }),
    wait: async () => {},
    ...overrides,
  } as never);
}

test('GH #750: two agreeing observations report the session runtime absent', async () => {
  let samples = 0;
  const absent = await probeWith({
    execute: async (file: string) => {
      assert.equal(file, 'xcrun');
      samples += 1;
      return { stdout: 'no application processes' };
    },
  })();
  assert.equal(absent, true);
  assert.equal(samples, 2, 'absence must hold across the re-sample gap');
});

test('GH #750: a failed device probe is inconclusive, never absent', async () => {
  const absent = await probeWith({
    execute: async () => {
      throw Object.assign(new Error('spawn xcrun ETIMEDOUT'), { killed: true, code: null });
    },
  })();
  assert.equal(absent, false, 'a probe that could not answer must keep the wider budget');
});

test('GH #750: a running app is not absent', async () => {
  const absent = await probeWith({
    execute: async () => ({ stdout: `1234 0 UIKitApplication:${appId}[0x1234][rb-legacy]` }),
  })();
  assert.equal(absent, false);
});

test('GH #750: an app that re-registers between samples is not absent', async () => {
  let listings = 0;
  const absent = await probeWith({
    listTargets: async () => {
      listings += 1;
      return { port: 8081, targets: listings >= 2 ? [sessionTarget] : [] };
    },
  })();
  assert.equal(absent, false, 'a target appearing in the relaunch window must not fail fast');
  assert.equal(listings, 2);
});

test('GH #750: an unresolved session binding is inconclusive', async () => {
  const absent = await probeWith({ resolveBinding: () => null })();
  assert.equal(absent, false);
});

test('GH #750: target discovery on a foreign port is inconclusive', async () => {
  const absent = await probeWith({
    listTargets: async () => ({ port: 8082, targets: [] }),
  })();
  assert.equal(absent, false);
});

test('GH #750: Android pidof exit 1 is a conclusive not-running verdict', async () => {
  let probes = 0;
  const absent = await createSessionRuntimeAbsenceProbe({
    resolveBinding: () => ({
      platform: 'android',
      deviceId: '46828c2c',
      appId,
      metroPort: 8081,
    }),
    listTargets: async () => ({ port: 8081, targets: [] }),
    execute: async (file: string, args: string[]) => {
      assert.equal(file, 'adb');
      assert.deepEqual(args, ['-s', '46828c2c', 'shell', 'pidof', appId]);
      probes += 1;
      throw Object.assign(new Error('Command failed: adb shell pidof'), { code: 1 });
    },
    wait: async () => {},
  } as never)();
  assert.equal(absent, true);
  assert.equal(probes, 2);
});

test('GH #750: an Android probe that cannot reach the device is inconclusive', async () => {
  const absent = await createSessionRuntimeAbsenceProbe({
    resolveBinding: () => ({
      platform: 'android',
      deviceId: '46828c2c',
      appId,
      metroPort: 8081,
    }),
    listTargets: async () => ({ port: 8081, targets: [] }),
    execute: async () => {
      throw Object.assign(new Error('device offline'), { code: 255 });
    },
    wait: async () => {},
  } as never)();
  assert.equal(absent, false);
});
