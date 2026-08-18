// GH #791: the mirror target resolver honors the PR #786 authority fence —
// an authority session without a proven device binding must refuse with a
// typed code instead of falling back to ambient device inference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMirrorTargetResolver } from '../../dist/observability/mirror/target.js';
import type { MirrorTargetDeps } from '../../dist/observability/mirror/target.js';

const mustNotProbe = {
  resolveIosUdid: async (): Promise<string | undefined> => {
    throw new Error('ambient iOS probe must not run');
  },
  listAndroidSerials: async (): Promise<string[]> => {
    throw new Error('ambient adb probe must not run');
  },
};

const base: MirrorTargetDeps = {
  getPlatform: () => 'ios',
  getSessionDeviceId: () => undefined,
  resolveIosUdid: async () => 'UDID-1',
  listAndroidSerials: async () => ['emulator-5554'],
};

test('fence sentinel {} refuses with a typed code and never probes ambient devices', async () => {
  const r = await buildMirrorTargetResolver({
    ...base,
    ...mustNotProbe,
    getRegistryDeviceBinding: () => ({}),
  })();
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'DEVICE_AUTHORITY_UNBOUND');
    assert.match(r.reason, /device authority is not bound/i);
    assert.match(r.reason, /bind_device/);
  }
});

test('exact registry device binding resolves without any ambient probe', async () => {
  const ios = await buildMirrorTargetResolver({
    ...base,
    ...mustNotProbe,
    getPlatform: () => null,
    getRegistryDeviceBinding: () => ({
      platform: 'ios',
      deviceId: 'BOUND-UDID',
    }),
  })();
  assert.deepEqual(ios, {
    ok: true,
    target: { platform: 'ios', deviceId: 'BOUND-UDID' },
  });

  const android = await buildMirrorTargetResolver({
    ...base,
    ...mustNotProbe,
    getRegistryDeviceBinding: () => ({
      platform: 'android',
      deviceId: 'emulator-5586',
    }),
  })();
  assert.deepEqual(android, {
    ok: true,
    target: { platform: 'android', deviceId: 'emulator-5586' },
  });
});

test('registry binding with an unknown platform is fenced, not guessed', async () => {
  const r = await buildMirrorTargetResolver({
    ...base,
    ...mustNotProbe,
    getRegistryDeviceBinding: () => ({ platform: 'tvos', deviceId: 'X' }),
  })();
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'DEVICE_AUTHORITY_UNBOUND');
});

test('partial registry binding (platform without deviceId) is fenced', async () => {
  const r = await buildMirrorTargetResolver({
    ...base,
    ...mustNotProbe,
    getRegistryDeviceBinding: () => ({ platform: 'ios' }),
  })();
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'DEVICE_AUTHORITY_UNBOUND');
});

test('null registry binding keeps the legacy ambient path', async () => {
  const r = await buildMirrorTargetResolver({
    ...base,
    getRegistryDeviceBinding: () => null,
  })();
  assert.deepEqual(r, {
    ok: true,
    target: { platform: 'ios', deviceId: 'UDID-1' },
  });
});

test('absent registry dep keeps the legacy ambient path (back-compat)', async () => {
  const r = await buildMirrorTargetResolver(base)();
  assert.deepEqual(r, {
    ok: true,
    target: { platform: 'ios', deviceId: 'UDID-1' },
  });
});

test('session deviceId still wins over the ambient path with a null registry binding', async () => {
  const r = await buildMirrorTargetResolver({
    ...base,
    ...mustNotProbe,
    getSessionDeviceId: () => 'SESSION-UDID',
    getRegistryDeviceBinding: () => null,
  })();
  assert.deepEqual(r, {
    ok: true,
    target: { platform: 'ios', deviceId: 'SESSION-UDID' },
  });
});
