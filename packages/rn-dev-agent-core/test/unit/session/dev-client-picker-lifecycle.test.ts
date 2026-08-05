import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parkExactDevClientAtPicker } from '../../../dist/session/dev-client-picker-lifecycle.js';

for (const platform of ['ios', 'android'] as const) {
  test(`${platform} fresh-picker lifecycle stops exact Metro before URL-free app launch`, async () => {
    const calls: string[] = [];
    const identity = {
      platform,
      deviceId: platform === 'ios' ? 'SIM-A' : 'emulator-5660',
      appId: 'dev.example',
    };
    await parkExactDevClientAtPicker(identity, {
      captureInstalled: (target) => {
        assert.deepEqual(target, identity);
        calls.push('capture');
        return { artifactDigest: 'artifact-a', installGeneration: 'install-a' };
      },
      terminate: async (target) => {
        assert.deepEqual(target, identity);
        calls.push('terminate');
      },
      stopManagedMetro: async () => {
        calls.push('stop-metro');
        return true;
      },
      publishMetroStopped: () => calls.push('publish-stopped'),
      launchWithoutUrl: async (target) => {
        assert.deepEqual(target, identity);
        calls.push('launch-without-url');
      },
      checkpoint: () => calls.push('checkpoint'),
    });

    assert.deepEqual(calls, [
      'capture',
      'terminate',
      'checkpoint',
      'stop-metro',
      'checkpoint',
      'publish-stopped',
      'launch-without-url',
      'checkpoint',
      'capture',
    ]);
  });
}

test('fresh-picker lifecycle refuses unproven Metro cleanup before relaunch', async () => {
  let launched = false;
  await assert.rejects(
    parkExactDevClientAtPicker(
      { platform: 'android', deviceId: 'emulator-5660', appId: 'dev.example' },
      {
        captureInstalled: () => ({ artifactDigest: 'a', installGeneration: 'i' }),
        terminate: async () => {},
        stopManagedMetro: async () => false,
        publishMetroStopped: () => assert.fail('unproven cleanup cannot be published'),
        launchWithoutUrl: async () => {
          launched = true;
        },
        checkpoint: () => {},
      },
    ),
    /METRO_AUTHORITY_MISMATCH/,
  );
  assert.equal(launched, false);
});

test('fresh-picker lifecycle refuses install drift after relaunch', async () => {
  let captures = 0;
  await assert.rejects(
    parkExactDevClientAtPicker(
      { platform: 'ios', deviceId: 'SIM-A', appId: 'dev.example' },
      {
        captureInstalled: () => ({
          artifactDigest: ++captures === 1 ? 'before' : 'after',
          installGeneration: 'install-a',
        }),
        terminate: async () => {},
        stopManagedMetro: async () => true,
        publishMetroStopped: () => {},
        launchWithoutUrl: async () => {},
        checkpoint: () => {},
      },
    ),
    /APP_INSTALL_IDENTITY_CHANGED/,
  );
});
