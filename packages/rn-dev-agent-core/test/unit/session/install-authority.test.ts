import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureInstalledArtifact,
  captureInstallGeneration,
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
      listAppFiles: () => ['ExampleApp', 'Info.plist'],
      lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      read: (path) => Buffer.from(path.endsWith('Info.plist') ? 'plist' : 'executable'),
      stat: (path) => ({
        ino: path.endsWith('Info.plist') ? 1 : 2,
        size: path.length,
        mtimeMs: 100,
      }),
    },
  );

  assert.equal(calls[0][1][2], 'IOS-UUID');
  assert.equal(receipt.deviceId, 'IOS-UUID');
  assert.match(receipt.artifactDigest, /^[a-f0-9]{64}$/);
  assert.match(receipt.installGeneration, /^[a-f0-9]{64}$/);
});

test('iOS install identity changes when any installed app resource changes', () => {
  const files = new Map([
    ['Info.plist', Buffer.from('plist')],
    ['ExampleApp', Buffer.from('executable')],
    ['main.jsbundle', Buffer.from('bundle-v1')],
  ]);
  let revision = 1;
  const dependencies = {
    runText: (command: string, args: readonly string[]) => {
      if (args[1] === 'get_app_container') return '/device/App.app\n';
      if (command === 'plutil') return 'ExampleApp\n';
      throw new Error('unexpected command');
    },
    runBuffer: () => {
      throw new Error('not used');
    },
    listAppFiles: () => [...files.keys()],
    lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    read: (path: string) => files.get(path.slice('/device/App.app/'.length))!,
    stat: (path: string) => {
      const contents = files.get(path.slice('/device/App.app/'.length))!;
      return { ino: 1, size: contents.length, mtimeMs: revision };
    },
  };

  const first = captureInstalledArtifact(
    { platform: 'ios', deviceId: 'IOS-UUID', appId: 'com.example.app' },
    dependencies,
  );
  files.set('main.jsbundle', Buffer.from('bundle-v2'));
  revision += 1;
  const second = captureInstalledArtifact(
    { platform: 'ios', deviceId: 'IOS-UUID', appId: 'com.example.app' },
    dependencies,
  );

  assert.notEqual(first.artifactDigest, second.artifactDigest);
  assert.notEqual(first.installGeneration, second.installGeneration);
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
  assert.match(receipt.installGeneration, /^[a-f0-9]{64}$/);
});

test('install generation probes avoid rereading installed artifact bytes', () => {
  let bufferReads = 0;
  const generation = captureInstallGeneration(
    {
      platform: 'android',
      deviceId: 'emulator-5554',
      appId: 'dev.example',
    },
    {
      runText: (_command, args) => {
        if (args.includes('path')) return 'package:/data/app/base.apk\n';
        return '1712345678 42000 /data/app/base.apk\n';
      },
      runBuffer: () => {
        bufferReads += 1;
        return Buffer.from('apk');
      },
    },
  );

  assert.match(generation, /^[a-f0-9]{64}$/);
  assert.equal(bufferReads, 0);
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
          installGeneration: 'generation-a',
        },
        {
          platform: 'ios',
          deviceId: 'IOS-UUID',
          appId: 'com.example.app',
          artifactDigest: 'foreign',
          installGeneration: 'generation-a',
        },
      ),
    /APP_INSTALL_IDENTITY_CHANGED/,
  );
});
