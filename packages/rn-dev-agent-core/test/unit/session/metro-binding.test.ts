import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureMetroBinding,
  probeMetroListener,
  resolveMetroListenerExecutable,
  resolveTrustedSystemExecutable,
} from '../../../dist/session/metro-binding.js';

test('listener probes select an existing trusted absolute executable', () => {
  const windowsExecutable = 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  assert.equal(
    resolveMetroListenerExecutable('win32', {
      environment: { SystemRoot: 'D:\\Windows' },
      exists: (path) => path === windowsExecutable,
    }),
    windowsExecutable,
  );
  assert.equal(
    resolveMetroListenerExecutable('win32', {
      environment: { SystemRoot: 'D:\\untrusted' },
      exists: (path) => path === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    }),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(
    resolveMetroListenerExecutable('linux', {
      exists: (path) => path === '/usr/sbin/ss',
    }),
    '/usr/sbin/ss',
  );
  assert.equal(
    resolveTrustedSystemExecutable('taskkill', 'win32', {
      environment: { SystemRoot: 'D:\\Windows' },
      exists: (path) => path === 'D:\\Windows\\System32\\taskkill.exe',
    }),
    'D:\\Windows\\System32\\taskkill.exe',
  );
  assert.equal(
    resolveTrustedSystemExecutable('ps', 'linux', {
      exists: (path) => path === '/bin/ps',
    }),
    '/bin/ps',
  );
});

test('listener probes fail closed when no trusted executable exists', () => {
  let executed = false;
  assert.deepEqual(
    probeMetroListener(
      8341,
      'linux',
      (() => {
        executed = true;
        return '';
      }) as never,
      { exists: () => false },
    ),
    { status: 'unknown' },
  );
  assert.equal(executed, false);
});

test('Metro binding requires exact port, process birth, serving root, and instance', async () => {
  const binding = await captureMetroBinding(
    {
      port: 8341,
      pid: 202,
      instanceId: 'metro-a',
      sourceRoot: '/repo/worktree',
      buildGeneration: 3,
    },
    {
      readBirth: () => ({ pid: 202, source: 'darwin-ps', token: 'metro-birth' }),
      listenerPid: () => 202,
      fetchStatus: async (port) =>
        port === 8341 ? 'packager-status:running' : 'packager-status:unknown',
      servingRoot: () => '/repo/worktree/apps/mobile',
    },
  );

  assert.deepEqual(binding, {
    port: 8341,
    pid: 202,
    birth: 'metro-birth',
    instanceId: 'metro-a',
    servingRoot: '/repo/worktree/apps/mobile',
    buildGeneration: 3,
  });
});

test('Metro binding rejects a live PID that does not own the claimed port', async () => {
  await assert.rejects(
    captureMetroBinding(
      {
        port: 8341,
        pid: 202,
        instanceId: 'metro-a',
        sourceRoot: '/repo/worktree',
        buildGeneration: 3,
      },
      {
        listenerPid: () => 303,
        readBirth: () => ({ pid: 202, source: 'darwin-ps', token: 'metro-birth' }),
        fetchStatus: async () => 'packager-status:running',
        servingRoot: () => '/repo/worktree',
      },
    ),
    /METRO_AUTHORITY_MISMATCH/,
  );
});

test('Metro binding fails closed when serving-root provenance is unavailable', async () => {
  await assert.rejects(
    captureMetroBinding(
      {
        port: 8341,
        pid: 202,
        instanceId: 'metro-a',
        sourceRoot: '/repo/worktree',
        buildGeneration: 3,
      },
      {
        listenerPid: () => 202,
        readBirth: () => ({ pid: 202, source: 'darwin-ps', token: 'metro-birth' }),
        fetchStatus: async () => 'packager-status:running',
        servingRoot: () => null,
      },
    ),
    /METRO_AUTHORITY_MISMATCH/,
  );
});

test('Metro binding rejects a serving root above the claimed worktree', async () => {
  await assert.rejects(
    captureMetroBinding(
      {
        port: 8341,
        pid: 202,
        instanceId: 'metro-a',
        sourceRoot: '/repo/worktree',
        buildGeneration: 3,
      },
      {
        listenerPid: () => 202,
        readBirth: () => ({ pid: 202, source: 'darwin-ps', token: 'metro-birth' }),
        fetchStatus: async () => 'packager-status:running',
        servingRoot: () => '/repo',
      },
    ),
    /METRO_AUTHORITY_MISMATCH/,
  );
});
