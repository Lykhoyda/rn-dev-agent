import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMirrorTargetResolver } from '../../dist/observability/mirror/target.js';

const base = {
  getPlatform: () => 'ios',
  getSessionDeviceId: () => undefined,
  resolveIosUdid: async () => 'UDID-1',
  listAndroidSerials: async () => ['emulator-5554'],
};

test('no platform → error mentioning session', async () => {
  const r = await buildMirrorTargetResolver({ ...base, getPlatform: () => null })();
  assert.equal(r.ok, false);
  assert.match(r.reason, /session/i);
});

test('session deviceId wins without probing', async () => {
  const r = await buildMirrorTargetResolver({
    ...base,
    getSessionDeviceId: () => 'SESSION-UDID',
    resolveIosUdid: async () => {
      throw new Error('must not probe');
    },
  })();
  assert.deepEqual(r, { ok: true, target: { platform: 'ios', deviceId: 'SESSION-UDID' } });
});

test('ios: single booted sim resolves; ambiguous → refusal', async () => {
  assert.equal((await buildMirrorTargetResolver(base)()).ok, true);
  const amb = await buildMirrorTargetResolver({ ...base, resolveIosUdid: async () => undefined })();
  assert.equal(amb.ok, false);
});

test('android: exactly one serial ok; zero and many refuse', async () => {
  const android = { ...base, getPlatform: () => 'android' };
  const one = await buildMirrorTargetResolver(android)();
  assert.deepEqual(one, { ok: true, target: { platform: 'android', deviceId: 'emulator-5554' } });
  const none = await buildMirrorTargetResolver({
    ...android,
    listAndroidSerials: async () => [],
  })();
  assert.equal(none.ok, false);
  const many = await buildMirrorTargetResolver({
    ...android,
    listAndroidSerials: async () => ['a', 'b'],
  })();
  assert.equal(many.ok, false);
  assert.match(many.reason, /multiple/i);
});
