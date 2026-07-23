import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureInstalledArtifact,
  verifyInstalledArtifact,
} from '../../../dist/session/install-authority.js';

test('iOS install identity is captured from the exact UUID and executable bytes', () => {
  const calls = [];
  const receipt = captureInstalledArtifact(
    { platform: 'ios', deviceId: 'IOS-UUID', appId: 'com.example.app' },
    {
      runText: (command, args) => {
        calls.push([command, args]);
        if (args[1] === 'get_app_container') return '/device/App.app\n';
        if (command === 'plutil') return 'ExampleApp\n';
        throw new Error('unexpected command');
      },
      runBuffer: () => {
        throw new Error('not used');
      },
      read: (path) => Buffer.from(path.endsWith('Info.plist') ? 'plist' : 'executable'),
    },
  );

  assert.equal(calls[0][1][2], 'IOS-UUID');
  assert.equal(receipt.deviceId, 'IOS-UUID');
  assert.match(receipt.artifactDigest, /^[a-f0-9]{64}$/);
});

test('Android install identity hashes the exact serial APK without first-device fallback', () => {
  const calls = [];
  const receipt = captureInstalledArtifact(
    { platform: 'android', deviceId: 'emulator-5558', appId: 'com.example.app' },
    {
      runText: (command, args) => {
        calls.push([command, args]);
        return 'package:/data/app/com.example.app/base.apk\n';
      },
      runBuffer: (command, args) => {
        calls.push([command, args]);
        return Buffer.from('apk-bytes');
      },
      read: () => {
        throw new Error('not used');
      },
    },
  );

  assert.deepEqual(calls[0][1].slice(0, 2), ['-s', 'emulator-5558']);
  assert.deepEqual(calls[1][1].slice(0, 2), ['-s', 'emulator-5558']);
  assert.match(receipt.artifactDigest, /^[a-f0-9]{64}$/);
});

test('same bundle ID with a foreign installed artifact is rejected', () => {
  assert.throws(
    () =>
      verifyInstalledArtifact(
        {
          platform: 'ios',
          deviceId: 'IOS-UUID',
          appId: 'com.example.app',
          artifactDigest: 'expected',
        },
        {
          platform: 'ios',
          deviceId: 'IOS-UUID',
          appId: 'com.example.app',
          artifactDigest: 'foreign',
        },
      ),
    /APP_INSTALL_IDENTITY_CHANGED/,
  );
});
