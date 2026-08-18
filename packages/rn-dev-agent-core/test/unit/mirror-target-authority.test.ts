// GH #791: the mirror target resolver honors the PR #786 authority fence —
// an authority session without a proven device binding must refuse with a
// typed code instead of falling back to ambient device inference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMirrorTargetResolver } from '../../dist/observability/mirror/target.js';
import type { MirrorTargetDeps } from '../../dist/observability/mirror/target.js';
import { mapRegistryDeviceBinding } from '../../dist/cdp/discovery.js';

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
    assert.match(r.reason, /rn_session status/);
  }
});

// The {} sentinel is lossy: every present-but-failed authority collapses into
// it, so the one refusal it produces must not prescribe a recovery that only
// fits the unbound-session case (GH #791).
for (const code of [
  'SESSION_OWNER_LOST',
  'AUTHORITY_STORE_UNAVAILABLE',
  'PROCESS_BIRTH_UNAVAILABLE',
  'HANDOFF_NOT_AUTHORIZED',
]) {
  test(`${code} maps to the fence sentinel and refuses without prescribing bind_device`, async () => {
    const binding = mapRegistryDeviceBinding({ available: false, code }, true);
    assert.deepEqual(binding, {});

    const r = await buildMirrorTargetResolver({
      ...base,
      ...mustNotProbe,
      getRegistryDeviceBinding: () => binding,
    })();
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, 'DEVICE_AUTHORITY_UNBOUND');
      assert.doesNotMatch(
        r.reason,
        /bind_device/,
        `${code} cannot be cleared by bind_device, so the refusal must not name it`,
      );
      assert.match(r.reason, /rn_session status/);
    }
  });
}

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
