import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  managedMetroListenerPid,
  probeManagedMetroListener,
  resolveManagedMetroCommand,
  startManagedMetro,
} from '../../../dist/session/managed-metro.js';

test('managed Metro discovers listener PIDs with platform-native commands', () => {
  const calls: Array<[string, string[]]> = [];
  const execute = ((file: string, args: string[]) => {
    calls.push([file, args]);
    return file === 'powershell.exe' ? '412\n' : 'users:(("node",pid=513,fd=19))\n';
  }) as never;

  assert.equal(managedMetroListenerPid(8341, 'win32', execute), 412);
  assert.equal(managedMetroListenerPid(8341, 'linux', execute), 513);
  assert.equal(calls[0]?.[0], 'powershell.exe');
  assert.equal(calls[1]?.[0], 'ss');
});

test('managed Metro listener probes require platform-specific positive absence', () => {
  assert.deepEqual(probeManagedMetroListener(8341, 'win32', (() => 'ABSENT') as never), {
    status: 'absent',
  });
  assert.deepEqual(probeManagedMetroListener(8341, 'linux', (() => '') as never), {
    status: 'absent',
  });
  assert.deepEqual(
    probeManagedMetroListener(
      8341,
      'darwin',
      (() => {
        throw Object.assign(new Error('no matches'), { status: 1, stdout: '', stderr: '' });
      }) as never,
    ),
    { status: 'absent' },
  );
});

test('managed Metro listener probes reject ambiguous platform output', () => {
  assert.deepEqual(
    probeManagedMetroListener(8341, 'win32', (() => 'Access denied') as never),
    { status: 'unknown' },
  );
  assert.deepEqual(
    probeManagedMetroListener(8341, 'win32', (() => '') as never),
    { status: 'unknown' },
  );
  assert.deepEqual(
    probeManagedMetroListener(
      8341,
      'linux',
      (() => 'LISTEN 0 511 *:8341 *:* users:(("node",fd=19))') as never,
    ),
    { status: 'unknown' },
  );
  assert.deepEqual(
    probeManagedMetroListener(8341, 'darwin', (() => '412 warning') as never),
    { status: 'unknown' },
  );
  assert.deepEqual(
    probeManagedMetroListener(8341, 'darwin', (() => '') as never),
    { status: 'unknown' },
  );
  assert.deepEqual(
    probeManagedMetroListener(
      8341,
      'darwin',
      (() => {
        throw Object.assign(new Error('permission denied'), {
          status: 1,
          stdout: '',
          stderr: 'permission denied',
        });
      }) as never,
    ),
    { status: 'unknown' },
  );
});

test('managed Metro selects only package-local Expo and bare RN CLIs', () => {
  assert.deepEqual(
    resolveManagedMetroCommand('/app', {
      readText: () => JSON.stringify({ dependencies: { expo: '1' } }),
      exists: () => true,
    }),
    { executable: '/app/node_modules/.bin/expo', args: ['start', '--dev-client'] },
  );
  assert.deepEqual(
    resolveManagedMetroCommand('/app', {
      readText: () => JSON.stringify({ dependencies: { 'react-native': '1' } }),
      exists: () => true,
    }),
    { executable: '/app/node_modules/.bin/react-native', args: ['start'] },
  );
});

test('managed Metro binds the actual listener rather than the launcher shim', async () => {
  const calls: unknown[] = [];
  const child = {
    pid: process.pid,
    exitCode: null,
    kill: () => true,
    unref: () => {},
  };
  const binding = await startManagedMetro(
    {
      appRoot: '/app',
      runtimeRoot: '/tmp',
      sourceRoot: '/app',
      sessionId: 'session-a',
      port: 8341,
      instanceId: 'metro-a',
      buildGeneration: 1,
      signerCapability: 'signer',
    },
    {
      readText: () => JSON.stringify({ dependencies: { expo: '1' } }),
      exists: () => true,
      spawnProcess: (executable, args) => {
        calls.push([executable, args]);
        return child;
      },
      listenerPid: () => 4242,
      listenerOwnedByLauncher: () => true,
      readBirth: (pid) => ({ pid, source: 'linux-proc', token: `birth-${pid}` }),
      capture: async (input) => ({
        ...input,
        birth: 'listener-birth',
        servingRoot: '/app',
      }),
    },
  );

  assert.equal(binding.pid, 4242);
  assert.equal(binding.launcherPid, process.pid);
  assert.equal(binding.mode, 'managed');
  assert.deepEqual(calls[0], [
    '/app/node_modules/.bin/expo',
    ['start', '--dev-client', '--port', '8341'],
  ]);
});

test('managed Metro proves a cross-platform listener belongs to the spawned launcher', async () => {
  const child = {
    pid: 101,
    exitCode: null,
    kill: () => true,
    unref: () => {},
  };
  let ownershipChecked = false;
  const binding = await startManagedMetro(
    {
      appRoot: '/app',
      runtimeRoot: '/tmp',
      sourceRoot: '/app',
      sessionId: 'session-a',
      port: 8341,
      instanceId: 'metro-a',
      buildGeneration: 1,
      signerCapability: 'signer',
    },
    {
      readText: () => JSON.stringify({ dependencies: { expo: '1' } }),
      exists: () => true,
      spawnProcess: () => child,
      listenerPid: () => 202,
      listenerOwnedByLauncher: (listenerPid, launcherPid) => {
        ownershipChecked = true;
        return listenerPid === 202 && launcherPid === 101;
      },
      readBirth: (pid) => ({ pid, source: 'linux-proc', token: `birth-${pid}` }),
      capture: async (input, dependencies) => ({
        ...input,
        birth: 'listener-birth',
        servingRoot: dependencies.servingRoot(input.port) ?? '',
      }),
    },
  );

  assert.equal(ownershipChecked, true);
  assert.equal(binding.servingRoot, '/app');
});
