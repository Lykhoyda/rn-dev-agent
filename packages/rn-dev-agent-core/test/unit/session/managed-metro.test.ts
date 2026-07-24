import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  managedMetroListenerPid,
  probeManagedMetroListener,
  resolveManagedMetroCommand,
  startManagedMetro,
  stopManagedMetro,
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
    probeManagedMetroListener(8341, 'darwin', (() => {
      throw Object.assign(new Error('no matches'), { status: 1, stdout: '', stderr: '' });
    }) as never),
    { status: 'absent' },
  );
});

test('managed Metro listener probes reject ambiguous platform output', () => {
  assert.deepEqual(probeManagedMetroListener(8341, 'win32', (() => 'Access denied') as never), {
    status: 'unknown',
  });
  assert.deepEqual(probeManagedMetroListener(8341, 'win32', (() => '') as never), {
    status: 'unknown',
  });
  assert.deepEqual(
    probeManagedMetroListener(
      8341,
      'linux',
      (() => 'LISTEN 0 511 *:8341 *:* users:(("node",fd=19))') as never,
    ),
    { status: 'unknown' },
  );
  assert.deepEqual(probeManagedMetroListener(8341, 'darwin', (() => '412 warning') as never), {
    status: 'unknown',
  });
  assert.deepEqual(probeManagedMetroListener(8341, 'darwin', (() => '') as never), {
    status: 'unknown',
  });
  assert.deepEqual(
    probeManagedMetroListener(8341, 'darwin', (() => {
      throw Object.assign(new Error('permission denied'), {
        status: 1,
        stdout: '',
        stderr: 'permission denied',
      });
    }) as never),
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
  const calls: Array<{
    executable: string;
    args: string[];
    env: NodeJS.ProcessEnv | undefined;
  }> = [];
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
      spawnProcess: (executable, args, options) => {
        calls.push({ executable, args, env: options.env });
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
  assert.equal(calls[0]?.executable, process.execPath);
  assert.equal(calls[0]?.args[0], '-e');
  assert.equal(calls[0]?.env?.RN_DEV_AGENT_METRO_EXECUTABLE, '/app/node_modules/.bin/expo');
  assert.equal(
    calls[0]?.env?.RN_DEV_AGENT_METRO_ARGS,
    JSON.stringify(['start', '--dev-client', '--port', '8341']),
  );
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

test('managed Metro stops its owned process tree and proves the listener is gone', async () => {
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
      spawnProcess: () => ({
        pid: 101,
        exitCode: null,
        kill: () => true,
        unref: () => {},
      }),
      listenerPid: () => 202,
      listenerOwnedByLauncher: () => true,
      readBirth: (pid) => ({ pid, source: 'linux-proc', token: `birth-${pid}` }),
      capture: async (input) => ({
        ...input,
        birth: 'birth-202',
        servingRoot: '/app',
      }),
    },
  );
  let stopped = false;
  const signals: Array<[number, NodeJS.Signals]> = [];

  const result = await stopManagedMetro(
    binding,
    { sessionId: 'session-a', signerCapability: 'signer' },
    {
      probeBirth: (pid) =>
        stopped
          ? { status: 'absent' }
          : {
              status: 'present',
              birth: { pid, source: 'linux-proc', token: `birth-${pid}` },
            },
      probeListener: () => (stopped ? { status: 'absent' } : { status: 'listening', pid: 202 }),
      signalTree: ({ launcherPid, signal }) => signals.push([launcherPid, signal]),
      wait: async () => {
        stopped = true;
      },
    },
  );

  assert.equal(result, true);
  assert.deepEqual(signals, [[101, 'SIGTERM']]);
});

test('managed Metro proof authenticates every cleanup authority field', async () => {
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
      spawnProcess: () => ({
        pid: 101,
        exitCode: null,
        kill: () => true,
        unref: () => {},
      }),
      listenerPid: () => 202,
      listenerOwnedByLauncher: () => true,
      readBirth: (pid) => ({ pid, source: 'linux-proc', token: `birth-${pid}` }),
      capture: async (input) => ({
        ...input,
        birth: 'birth-202',
        servingRoot: '/app',
      }),
    },
  );
  const tampered = [
    { ...binding, port: 8342 },
    { ...binding, pid: 203 },
    { ...binding, birth: 'birth-203' },
    { ...binding, launcherPid: 102 },
    { ...binding, launcherBirth: 'birth-102' },
  ];

  for (const candidate of tampered) {
    assert.equal(
      await stopManagedMetro(candidate, {
        sessionId: 'session-a',
        signerCapability: 'signer',
      }),
      false,
    );
  }
});

test('managed Metro accepts authenticated cleanup when processes and port are already absent', async () => {
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
      spawnProcess: () => ({
        pid: 101,
        exitCode: null,
        kill: () => true,
        unref: () => {},
      }),
      listenerPid: () => 202,
      listenerOwnedByLauncher: () => true,
      readBirth: (pid) => ({ pid, source: 'linux-proc', token: `birth-${pid}` }),
      capture: async (input) => ({
        ...input,
        birth: 'birth-202',
        servingRoot: '/app',
      }),
    },
  );
  let signalled = false;

  const result = await stopManagedMetro(
    binding,
    { sessionId: 'session-a', signerCapability: 'signer' },
    {
      probeBirth: () => ({ status: 'absent' }),
      probeListener: () => ({ status: 'absent' }),
      signalTree: () => {
        signalled = true;
      },
    },
  );

  assert.equal(result, true);
  assert.equal(signalled, false);
});

test('managed Metro refuses cleanup when process absence is unknown', async () => {
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
      spawnProcess: () => ({
        pid: 101,
        exitCode: null,
        kill: () => true,
        unref: () => {},
      }),
      listenerPid: () => 202,
      listenerOwnedByLauncher: () => true,
      readBirth: (pid) => ({ pid, source: 'linux-proc', token: `birth-${pid}` }),
      capture: async (input) => ({
        ...input,
        birth: 'birth-202',
        servingRoot: '/app',
      }),
    },
  );

  const result = await stopManagedMetro(
    binding,
    { sessionId: 'session-a', signerCapability: 'signer' },
    {
      probeBirth: () => ({ status: 'unknown' }),
      probeListener: () => ({ status: 'absent' }),
    },
  );

  assert.equal(result, false);
});

test('managed Metro stops an exact listener after its launcher already exited', async () => {
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
      spawnProcess: () => ({
        pid: 101,
        exitCode: null,
        kill: () => true,
        unref: () => {},
      }),
      listenerPid: () => 202,
      listenerOwnedByLauncher: () => true,
      readBirth: (pid) => ({ pid, source: 'linux-proc', token: `birth-${pid}` }),
      capture: async (input) => ({
        ...input,
        birth: 'birth-202',
        servingRoot: '/app',
      }),
    },
  );
  let listenerPresent = true;
  const signals: Array<{
    launcherPid: number;
    launcherPresent: boolean;
    listenerPid: number;
  }> = [];

  const result = await stopManagedMetro(
    binding,
    { sessionId: 'session-a', signerCapability: 'signer' },
    {
      probeBirth: (pid) => {
        if (pid === 101 || !listenerPresent) return { status: 'absent' };
        return {
          status: 'present',
          birth: { pid, source: 'linux-proc', token: 'birth-202' },
        };
      },
      probeListener: () =>
        listenerPresent ? { status: 'listening', pid: 202 } : { status: 'absent' },
      signalTree: ({ launcherPid, launcherPresent, listenerPid }) => {
        signals.push({ launcherPid, launcherPresent, listenerPid });
        listenerPresent = false;
      },
    },
  );

  assert.equal(result, true);
  assert.deepEqual(signals, [{ launcherPid: 101, launcherPresent: false, listenerPid: 202 }]);
});

test('managed Metro startup failure stops the owned tree before returning', async () => {
  const child = {
    pid: 101,
    exitCode: null,
    kill: () => true,
    unref: () => {},
  };
  let stopped = false;
  let captureAttempted = false;
  const signals: number[] = [];

  await assert.rejects(
    startManagedMetro(
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
        listenerOwnedByLauncher: () => true,
        readBirth: (pid) => ({ pid, source: 'linux-proc', token: `birth-${pid}` }),
        probeBirth: (pid) =>
          stopped
            ? { status: 'absent' }
            : {
                status: 'present',
                birth: { pid, source: 'linux-proc', token: `birth-${pid}` },
              },
        probeListener: () => (stopped ? { status: 'absent' } : { status: 'listening', pid: 202 }),
        capture: async () => {
          captureAttempted = true;
          throw new Error('capture failed');
        },
        signalTree: ({ launcherPid }) => {
          signals.push(launcherPid);
          stopped = true;
        },
        wait: async () => {
          if (captureAttempted) child.exitCode = 1;
        },
      },
    ),
    /METRO_START_UNAVAILABLE/,
  );

  assert.deepEqual(signals, [101]);
});

test('managed Metro cleans the spawned group when launcher birth is unavailable', async () => {
  let stopped = false;
  const signals: number[] = [];

  await assert.rejects(
    startManagedMetro(
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
        spawnProcess: () => ({
          pid: 101,
          exitCode: null,
          kill: () => true,
          unref: () => {},
        }),
        readBirth: () => null,
        probeBirth: () => (stopped ? { status: 'absent' } : { status: 'unknown' }),
        probeListener: () => (stopped ? { status: 'absent' } : { status: 'listening', pid: 202 }),
        signalTree: ({ launcherPid }) => {
          signals.push(launcherPid);
          stopped = true;
        },
      },
    ),
    /PROCESS_BIRTH_UNAVAILABLE/,
  );

  assert.deepEqual(signals, [101]);
});

test('managed Metro startup cleanup signals its group before listener birth is known', async () => {
  const child = {
    pid: 101,
    exitCode: null as number | null,
    kill: () => true,
    unref: () => {},
  };
  let stopped = false;
  let captureAttempted = false;
  const signals: number[] = [];

  await assert.rejects(
    startManagedMetro(
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
        listenerOwnedByLauncher: () => true,
        readBirth: (pid) => ({ pid, source: 'linux-proc', token: `birth-${pid}` }),
        probeBirth: (pid) => {
          if (stopped) return { status: 'absent' };
          if (pid === 202) return { status: 'unknown' };
          return {
            status: 'present',
            birth: { pid, source: 'linux-proc', token: 'birth-101' },
          };
        },
        probeListener: () => (stopped ? { status: 'absent' } : { status: 'listening', pid: 202 }),
        capture: async () => {
          captureAttempted = true;
          throw new Error('capture failed');
        },
        signalTree: ({ launcherPid }) => {
          signals.push(launcherPid);
          stopped = true;
        },
        wait: async () => {
          if (captureAttempted) child.exitCode = 1;
        },
      },
    ),
    /METRO_START_UNAVAILABLE/,
  );

  assert.deepEqual(signals, [101]);
});

test('managed Metro startup cleanup retains an owned listener after launcher exit', async () => {
  const child = {
    pid: 101,
    exitCode: null as number | null,
    kill: () => true,
    unref: () => {},
  };
  let stopped = false;
  let captureAttempted = false;
  const signals: Array<{ launcherPid: number; listenerPid: number }> = [];

  await assert.rejects(
    startManagedMetro(
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
        listenerOwnedByLauncher: () => true,
        readBirth: (pid) => ({ pid, source: 'linux-proc', token: `birth-${pid}` }),
        probeBirth: (pid) =>
          stopped || pid === 101 ? { status: 'absent' } : { status: 'unknown' },
        probeListener: () => (stopped ? { status: 'absent' } : { status: 'listening', pid: 202 }),
        capture: async () => {
          captureAttempted = true;
          throw new Error('capture failed');
        },
        signalTree: ({ launcherPid, listenerPid }) => {
          signals.push({ launcherPid, listenerPid });
          stopped = true;
        },
        wait: async () => {
          if (captureAttempted) child.exitCode = 0;
        },
      },
    ),
    /METRO_START_UNAVAILABLE/,
  );

  assert.deepEqual(signals, [{ launcherPid: 101, listenerPid: 202 }]);
});
