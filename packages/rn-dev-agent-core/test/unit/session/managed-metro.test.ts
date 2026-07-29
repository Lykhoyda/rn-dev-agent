import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalAuthorityJson } from '../../../dist/session/authority-json.js';
import {
  hasNodeLoaderOption,
  hasUnsupportedNodeOption,
  inspectManagedMetroLifecycle,
  managedMetroChildEnvironment,
  managedMetroListenerPid,
  managedMetroParentPid,
  probeManagedMetroListener,
  refreshManagedMetroBuildGeneration,
  resolveManagedMetroCommand,
  signalManagedMetroProcessTree,
  startManagedMetro,
  stopManagedMetro,
  stopManagedMetroWithEvidence,
  verifyManagedMetroManagementProof,
} from '../../../dist/session/managed-metro.js';

const listenerExecutableDependencies = {
  exists: () => true,
  environment: { SystemRoot: 'C:\\Windows' },
};

test('managed Metro ancestry and cleanup use trusted absolute executables', () => {
  const executions: Array<{ executable: string; args: string[] }> = [];
  const execute = ((executable: string, args: string[]) => {
    executions.push({ executable, args });
    return executable.endsWith('powershell.exe') ? '41' : '';
  }) as typeof execFileSync;
  const executableDependencies = {
    environment: { SystemRoot: 'D:\\Windows' },
    exists: (path: string) =>
      path === 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' ||
      path === 'D:\\Windows\\System32\\taskkill.exe',
  };

  assert.equal(managedMetroParentPid(42, 'win32', execute, executableDependencies), 41);
  signalManagedMetroProcessTree(
    { launcherPid: 42, listenerPid: 43, launcherPresent: true, signal: 'SIGTERM' },
    'win32',
    execute,
    executableDependencies,
  );
  assert.deepEqual(
    executions.map(({ executable }) => executable),
    [
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'D:\\Windows\\System32\\taskkill.exe',
    ],
  );
});

test('managed Metro ancestry and cleanup fail closed without trusted executables', () => {
  let executed = false;
  const execute = (() => {
    executed = true;
    return '';
  }) as typeof execFileSync;
  const executableDependencies = { exists: () => false };

  assert.equal(managedMetroParentPid(42, 'linux', execute, executableDependencies), null);
  assert.throws(
    () =>
      signalManagedMetroProcessTree(
        { launcherPid: 42, listenerPid: 43, launcherPresent: true, signal: 'SIGTERM' },
        'win32',
        execute,
        executableDependencies,
      ),
    /METRO_CLEANUP_EXECUTABLE_UNAVAILABLE/,
  );
  assert.equal(executed, false);
});

test('managed Metro policy publication retains no-follow file authority', () => {
  const source = readFileSync(
    new URL('../../../src/session/managed-metro.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /writeFileSync\(policyPath/);
  assert.match(source, /constants\.O_RDWR \| constants\.O_CREAT \| constants\.O_NOFOLLOW/);
  assert.match(source, /ftruncateSync\(policyDescriptor, 0\)/);
  assert.match(source, /retainedDirectory\.ino !== policyDirectoryIdentity\.ino/);
  assert.match(source, /publishedPolicy\.ino !== policyIdentity\.ino/);
});

test('shipping artifacts omit retired runtime-authority claims', () => {
  for (const retiredClaim of [
    ['broker', 'v2'].join('-'),
    ['closed', 'world'].join('-'),
    ['exact executable', 'bytes'].join(' '),
  ]) {
    let matches = '';
    try {
      matches = execFileSync('git', ['grep', '-n', '--fixed-strings', retiredClaim, '--', '.'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if ((error as { status?: unknown }).status !== 1) throw error;
    }
    assert.equal(matches, '', retiredClaim);
  }
});

test('managed Metro rejects every Node loader option alias', () => {
  for (const option of [
    '--require=loader.cjs',
    '-r loader.cjs',
    '--import loader.mjs',
    '--loader=loader.mjs',
    '--experimental-loader loader.mjs',
    '--experimental_loader=loader.mjs',
    '"--require=/path with spaces/loader.cjs"',
    '"--requ\\ire" loader.cjs',
    '"--im\\port" loader.mjs',
  ]) {
    assert.equal(hasNodeLoaderOption(option), true, option);
  }
  assert.equal(hasNodeLoaderOption('--trace_warnings --title="metro worker"'), false);
});

test('managed Metro rejects unmodeled NODE_OPTIONS inputs', () => {
  for (const option of [
    '--openssl-config=/tmp/openssl.cnf',
    '--icu-data-dir /tmp/icu',
    '--env-file=.env',
    '--snapshot-blob=snapshot.blob',
    '--inspect',
    '--inspect-brk=127.0.0.1:9229',
    '--inspect-wait',
  ]) {
    assert.equal(hasUnsupportedNodeOption(option), true, option);
  }
  assert.equal(
    hasUnsupportedNodeOption('--conditions=react_native --max-old-space-size=4096'),
    false,
  );
});

test('managed Metro discovers listener PIDs with platform-native commands', () => {
  const calls: Array<[string, string[]]> = [];
  const execute = ((file: string, args: string[]) => {
    calls.push([file, args]);
    return file.endsWith('powershell.exe') ? '412\n' : 'users:(("node",pid=513,fd=19))\n';
  }) as never;

  assert.equal(
    managedMetroListenerPid(8341, 'win32', execute, listenerExecutableDependencies),
    412,
  );
  assert.equal(
    managedMetroListenerPid(8341, 'linux', execute, listenerExecutableDependencies),
    513,
  );
  assert.equal(calls[0]?.[0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(calls[1]?.[0], '/usr/bin/ss');
  let darwinCommand = '';
  const darwinProbe = probeManagedMetroListener(
    8341,
    'darwin',
    ((file: string) => {
      darwinCommand = file;
      return '412';
    }) as never,
    listenerExecutableDependencies,
  );
  assert.equal(darwinProbe.status, 'listening');
  assert.equal(darwinCommand, '/usr/sbin/lsof');
});

test('managed Metro listener probes require platform-specific positive absence', () => {
  assert.deepEqual(
    probeManagedMetroListener(
      8341,
      'win32',
      (() => 'ABSENT') as never,
      listenerExecutableDependencies,
    ),
    { status: 'absent' },
  );
  assert.deepEqual(
    probeManagedMetroListener(8341, 'linux', (() => '') as never, listenerExecutableDependencies),
    { status: 'absent' },
  );
  assert.deepEqual(
    probeManagedMetroListener(
      8341,
      'darwin',
      (() => {
        throw Object.assign(new Error('no matches'), { status: 1, stdout: '', stderr: '' });
      }) as never,
      listenerExecutableDependencies,
    ),
    { status: 'absent' },
  );
});

test('managed Metro listener probes reject ambiguous platform output', () => {
  assert.deepEqual(
    probeManagedMetroListener(
      8341,
      'win32',
      (() => 'Access denied') as never,
      listenerExecutableDependencies,
    ),
    { status: 'unknown' },
  );
  assert.deepEqual(
    probeManagedMetroListener(8341, 'win32', (() => '') as never, listenerExecutableDependencies),
    { status: 'unknown' },
  );
  assert.deepEqual(
    probeManagedMetroListener(
      8341,
      'linux',
      (() => 'LISTEN 0 511 *:8341 *:* users:(("node",fd=19))') as never,
      listenerExecutableDependencies,
    ),
    { status: 'unknown' },
  );
  assert.deepEqual(
    probeManagedMetroListener(
      8341,
      'darwin',
      (() => '412 warning') as never,
      listenerExecutableDependencies,
    ),
    { status: 'unknown' },
  );
  assert.deepEqual(
    probeManagedMetroListener(8341, 'darwin', (() => '') as never, listenerExecutableDependencies),
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
      listenerExecutableDependencies,
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
  assert.deepEqual(
    resolveManagedMetroCommand('/app', {
      platform: 'win32',
      readText: (path) =>
        path.endsWith('/node_modules/expo/package.json')
          ? JSON.stringify({ bin: { expo: 'bin/cli.js' } })
          : JSON.stringify({ dependencies: { expo: '1' } }),
      exists: () => true,
    }),
    {
      executable: '/app/node_modules/expo/bin/cli.js',
      args: ['start', '--dev-client'],
    },
  );
});

test('managed Metro child environment excludes session authority', () => {
  assert.deepEqual(
    managedMetroChildEnvironment({
      PATH: '/bin',
      HOME: '/home/test',
      EXPO_PUBLIC_MODE: 'test',
      BABEL_ENV: 'development',
      CI: 'true',
      CUSTOM_METRO_FLAG: 'enabled',
      RN_DEV_AGENT_SESSION_SECRET_PATH: '/secret',
      RN_DEV_AGENT_REGISTRY_PATH: '/registry',
      DATABASE_URL: 'secret',
    }),
    {
      PATH: '/bin',
      HOME: '/home/test',
      EXPO_PUBLIC_MODE: 'test',
      BABEL_ENV: 'development',
      CUSTOM_METRO_FLAG: 'enabled',
      DATABASE_URL: 'secret',
    },
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
  const nodeRuntimeAttestation = {
    version: 1 as const,
    executable: {
      path: process.execPath,
      sha256: 'd'.repeat(64),
      signingIdentity: null,
    },
    runtimeVersion: process.version,
    loadedRuntimeFiles: [],
    executableMappings: [],
  };
  let runtimeAdmissionChecked = false;
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
      prepareEnforcement: () => ({
        status: 'enforced',
        kind: 'darwin-seatbelt-v2',
        sandboxExecutable: '/usr/bin/sandbox-exec',
        sandboxExecutableSha256: 'a'.repeat(64),
        sandboxExecutableCdHash: 'b'.repeat(40),
        commandLaunchSha256: 'd'.repeat(64),
        resolvedCommandSha256: 'e'.repeat(64),
        profile: '(version 1)\n(deny default)\n',
        profileSha256: 'c'.repeat(64),
        canaryPath: '/private/tmp/rn-dev-agent-metro-test.canary',
        descendantCanaryPath: '/runtime/session/descendant-test.cjs',
        symlinkCanaryPath: '/runtime/session/enforcement-test.canary',
        port: 8341,
        unallocatedPort: 0,
        nodeExecutable: process.execPath,
        nodeRuntimeAttestation,
      }),
      preflightEnforcement: (plan) => ({
        version: 2,
        kind: plan.kind,
        profileSha256: plan.profileSha256,
        sandboxExecutableSha256: plan.sandboxExecutableSha256,
        sandboxExecutableCdHash: plan.sandboxExecutableCdHash,
        commandLaunchSha256: plan.commandLaunchSha256,
        resolvedCommandSha256: plan.resolvedCommandSha256,
        descendantCreationAllowed: true,
        unauthorizedExecutableDenied: true,
        unmanifestedReadDenied: true,
        unmanifestedWriteDenied: true,
        symlinkEscapeDenied: true,
        unallocatedListenerDenied: true,
        allocatedListenerAllowed: true,
        networkOutboundDenied: true,
        nodeRuntimeAttestation: plan.nodeRuntimeAttestation,
      }),
      verifyRuntimeAdmission: () => {
        runtimeAdmissionChecked = true;
        return true;
      },
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
  assert.equal(
    calls[0]?.env?.RN_DEV_AGENT_METRO_AUTHORITY_PRELOAD,
    '/app/.rn-agent/integration/rn-session-metro.cjs',
  );
  assert.equal(
    calls[0]?.env?.RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE,
    '/tmp/metro-runtime-evidence.jsonl',
  );
  assert.equal(
    calls[0]?.env?.RN_DEV_AGENT_METRO_NATIVE_ADDON_ACK_ROOT,
    '/tmp/native-addon-acknowledgments',
  );
  const runtimeEvidenceSocket = binding.runtimeEvidenceSocket;
  assert.equal(calls[0]?.env?.RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE_SOCKET, runtimeEvidenceSocket);
  assert.ok(runtimeEvidenceSocket.length < 100);
  assert.doesNotMatch(runtimeEvidenceSocket, /metro-a/);
  assert.equal(
    calls[0]?.env?.RN_DEV_AGENT_METRO_CHILD_NODE_OPTIONS,
    [
      (process.env.NODE_OPTIONS ?? '').trim(),
      '--require="/app/.rn-agent/integration/rn-session-metro.cjs"',
    ]
      .filter(Boolean)
      .join(' '),
  );
  assert.equal(calls[0]?.env?.NODE_OPTIONS, (process.env.NODE_OPTIONS ?? '').trim());
  assert.equal(binding.runtimeEvidencePath, '/tmp/metro-runtime-evidence.jsonl');
  assert.equal(binding.runtimeEvidenceSocket, runtimeEvidenceSocket);
  assert.equal(binding.runtimeEvidenceAuthority, 'managed-sandbox-v1');
  assert.equal(binding.runtimeEvidenceProtocol, 2);
  assert.equal(runtimeAdmissionChecked, true);
  assert.equal(calls[0]?.env?.RN_DEV_AGENT_SESSION_SECRET_PATH, undefined);
  assert.equal(calls[0]?.env?.RN_DEV_AGENT_REGISTRY_PATH, undefined);
  assert.equal(calls[0]?.env?.RCT_METRO_PORT, '8341');
  const runtimeEnforcement = JSON.parse(
    calls[0]?.env?.RN_DEV_AGENT_METRO_RUNTIME_ENFORCEMENT ?? '{}',
  ) as Record<string, unknown>;
  assert.equal(runtimeEnforcement.status, 'enforced');
  assert.equal(runtimeEnforcement.profileSha256, 'c'.repeat(64));
  const childEnvironment = JSON.parse(
    calls[0]?.env?.RN_DEV_AGENT_METRO_CHILD_ENVIRONMENT ?? '{}',
  ) as NodeJS.ProcessEnv;
  assert.equal(childEnvironment.RCT_METRO_PORT, '8341');
  assert.equal(childEnvironment.EXPO_UNSTABLE_HEADLESS, '1');
  assert.equal(childEnvironment.RN_DEV_AGENT_SESSION_SECRET_PATH, undefined);
  assert.equal(childEnvironment.RN_DEV_AGENT_REGISTRY_PATH, undefined);
  assert.equal(childEnvironment.RN_DEV_AGENT_METRO_CONTENT_ROOT, '/app');
  assert.equal(childEnvironment.RN_DEV_AGENT_METRO_APP_ROOT, '/app');
  const allowedCodeRoots = [
    '/app',
    '/app/.pnpm',
    '/app/.yarn/cache',
    '/app/.yarn/unplugged',
    '/app/node_modules',
    '/node_modules',
  ];
  assert.equal(
    childEnvironment.RN_DEV_AGENT_METRO_ALLOWED_CODE_ROOTS,
    JSON.stringify(allowedCodeRoots),
  );
  assert.match(childEnvironment.RN_DEV_AGENT_METRO_AUTHORITY_ROOT_NONCE ?? '', /^[a-f0-9]{32}$/);
  const runtimeManifest = JSON.parse(
    calls[0]?.env?.RN_DEV_AGENT_METRO_RUNTIME_MANIFEST ?? '{}',
  ) as Record<string, unknown>;
  assert.equal(
    runtimeManifest.environmentDigest,
    createHash('sha256').update(canonicalAuthorityJson(childEnvironment)).digest('hex'),
  );
  assert.equal(runtimeManifest.servingRoot, '/app');
  assert.equal(runtimeManifest.buildGeneration, 1);
  assert.equal(runtimeManifest.nodeVersion, process.version);
  assert.deepEqual(runtimeManifest.descendantAuthority, {
    version: 1,
    rootNonce: childEnvironment.RN_DEV_AGENT_METRO_AUTHORITY_ROOT_NONCE,
    allowedCodeRoots,
  });
  assert.ok(Array.isArray(runtimeManifest.runtimeInputs));
  assert.ok(
    (runtimeManifest.commandChainInputs as string[]).includes(
      '/app/.rn-agent/integration/rn-session-metro.cjs',
    ),
  );
  assert.equal(
    verifyManagedMetroManagementProof(binding as unknown as Record<string, unknown>, {
      sessionId: 'session-a',
      signerCapability: 'signer',
    }),
    true,
  );
  assert.equal(
    verifyManagedMetroManagementProof(binding as unknown as Record<string, unknown>, {
      sessionId: 'stale-session',
      signerCapability: 'signer',
    }),
    false,
  );
  assert.equal(
    verifyManagedMetroManagementProof(binding as unknown as Record<string, unknown>, {
      sessionId: 'session-a',
      signerCapability: 'forged-signer',
    }),
    false,
  );
  for (const property of [
    'instanceId',
    'launcherBirth',
    'runtimeEvidencePath',
    'runtimeEvidenceSocket',
    'runtimeEvidenceAuthority',
    'runtimeEvidenceProtocol',
    'servingRoot',
    'buildGeneration',
  ] as const) {
    assert.equal(
      verifyManagedMetroManagementProof(
        {
          ...binding,
          [property]:
            property === 'runtimeEvidenceProtocol' || property === 'buildGeneration'
              ? 99
              : 'forged',
        },
        { sessionId: 'session-a', signerCapability: 'signer' },
      ),
      false,
      property,
    );
  }
  assert.match(calls[0]?.args[1] ?? '', /childOutcome === null \|\| !evidenceFinished/);
  assert.match(calls[0]?.args[1] ?? '', /rn-dev-agent:evidence-barrier/);
  assert.match(calls[0]?.args[1] ?? '', /stream ended before Metro exited/);
  assert.match(calls[0]?.args[1] ?? '', /connection\.setTimeout/);
  assert.match(calls[0]?.args[1] ?? '', /for \(const connection of headConnections\)/);
  assert.match(calls[0]?.args[1] ?? '', /journalSignature: previousSignature/);
  assert.match(
    calls[0]?.args[1] ?? '',
    /runtimeEvidenceAuthority = managedSandbox \? 'managed-sandbox-v1' : 'reported-v1'/,
  );
  assert.match(calls[0]?.args[1] ?? '', /runtimeEnforcement: managedSandbox/);
  assert.match(
    calls[0]?.args[1] ?? '',
    /runtimeEnforcement\.status === 'enforced' && !managedSandbox/,
  );
  assert.match(calls[0]?.args[1] ?? '', /snapshots\.map\(\(\) => 'pipe'\)/);
  assert.match(calls[0]?.args[1] ?? '', /\.end\(commandChainSnapshot\.snapshots\[index\]\)/);
  assert.match(calls[0]?.args[1] ?? '', /spawn\(managedSandbox \? sandboxExecutable : executable/);
  assert.match(
    calls[0]?.args[1] ?? '',
    /createHash\('sha256'\)\.update\(snapshot\).*if \(!argumentPaths\.has\(entry\.path\)\) continue/s,
  );
  assert.match(
    calls[0]?.args[1] ?? '',
    /if \(payload\.kind === 'violation'\) \{\s+appendViolation/,
  );
  assert.match(calls[0]?.args[1] ?? '', /appendEvidence\(payload\);/);
});

test('managed Metro cannot claim managed sandbox when enforcement is unavailable', async () => {
  const calls: NodeJS.ProcessEnv[] = [];
  const child = {
    pid: process.pid,
    exitCode: null,
    signalCode: null,
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
      prepareEnforcement: () => ({
        status: 'unsupported',
        reason: 'host-enforcement-unavailable',
      }),
      spawnProcess: (_executable, _args, options) => {
        calls.push(options.env ?? {});
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

  assert.equal(binding.runtimeEvidenceAuthority, 'reported-v1');
  assert.deepEqual(JSON.parse(calls[0]?.RN_DEV_AGENT_METRO_RUNTIME_ENFORCEMENT ?? '{}'), {
    status: 'unsupported',
    reason: 'host-enforcement-unavailable',
  });
  assert.equal(
    verifyManagedMetroManagementProof(binding as unknown as Record<string, unknown>, {
      sessionId: 'session-a',
      signerCapability: 'signer',
    }),
    true,
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

test('managed Metro stops polling when the launcher exits by signal', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'rn-managed-metro-startup-refusal-'));
  const capability = createHmac('sha256', 'signer')
    .update('metro-runtime-policy')
    .digest('base64url');
  const violation = {
    version: 1,
    sessionId: 'session-a',
    metroInstanceId: 'metro-a',
    kind: 'violation',
    value: 'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON: outside:foreign-addon.node',
    digest: null,
    runtimeEvidenceAuthority: 'reported-v1',
    sequence: 1,
    previousSignature: null,
  };
  writeFileSync(
    join(runtimeRoot, 'metro-runtime-evidence.jsonl'),
    `${canonicalAuthorityJson({
      ...violation,
      signature: createHmac('sha256', capability)
        .update(canonicalAuthorityJson(violation))
        .digest('hex'),
    })}\n`,
  );
  writeFileSync(join(runtimeRoot, 'metro.log'), 'first line\nnative addon startup failed\n');
  let listenerProbes = 0;
  try {
    await assert.rejects(
      () =>
        startManagedMetro(
          {
            appRoot: '/app',
            runtimeRoot,
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
              signalCode: 'SIGTERM',
              kill: () => true,
              unref: () => {},
            }),
            listenerPid: () => {
              listenerProbes++;
              return null;
            },
            readBirth: (pid) => ({ pid, source: 'linux-proc', token: `birth-${pid}` }),
            probeBirth: () => ({ status: 'absent' }),
            probeListener: () => ({ status: 'absent' }),
            wait: async () =>
              assert.fail('signalled launcher must not wait for the startup deadline'),
          },
        ),
      (error: Error) => {
        assert.match(error.message, /^RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON:/);
        assert.match(error.message, /launcher signal SIGTERM/);
        assert.match(error.message, /native addon startup failed/);
        return true;
      },
    );
    assert.equal(listenerProbes, 0);
    assert.match(
      readFileSync(join(runtimeRoot, 'metro.log'), 'utf8'),
      /native addon startup failed/,
    );
  } finally {
    rmSync(runtimeRoot, { force: true, recursive: true });
  }
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
  let removedEvidenceSocket: string | null = null;

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
      removeEvidenceSocket: (path) => {
        removedEvidenceSocket = path;
      },
      wait: async () => {
        stopped = true;
      },
    },
  );

  assert.equal(result, true);
  assert.deepEqual(signals, [[101, 'SIGTERM']]);
  assert.equal(removedEvidenceSocket, binding.runtimeEvidenceSocket);
});

test('managed Metro lifecycle inspection fails closed for every lost authority signal', async (t) => {
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
        signalCode: null,
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
  const liveBirth = (pid: number) => ({
    status: 'present' as const,
    birth: { pid, source: 'linux-proc' as const, token: `birth-${pid}` },
  });
  const inspect = (
    overrides: {
      exists?: () => boolean;
      probeBirth?: (pid: number) => ReturnType<typeof liveBirth> | { status: 'absent' };
      probeListener?: () =>
        | { status: 'listening'; pid: number }
        | { status: 'absent' }
        | { status: 'unknown' };
    } = {},
  ) =>
    inspectManagedMetroLifecycle(
      binding as unknown as Record<string, unknown>,
      { sessionId: 'session-a', signerCapability: 'signer' },
      {
        exists: overrides.exists ?? (() => true),
        probeBirth: overrides.probeBirth ?? liveBirth,
        probeListener: overrides.probeListener ?? (() => ({ status: 'listening', pid: 202 })),
      },
    );

  assert.deepEqual(inspect(), { status: 'live' });

  await t.test('exit before bundle bind', () => {
    assert.equal(
      inspect({ probeBirth: (pid) => (pid === 101 ? { status: 'absent' } : liveBirth(pid)) }).code,
      'METRO_LAUNCHER_EXITED',
    );
  });
  await t.test('exit after bundle bind', () => {
    assert.equal(
      inspect({ probeBirth: (pid) => (pid === 202 ? { status: 'absent' } : liveBirth(pid)) }).code,
      'METRO_LISTENER_EXITED',
    );
  });
  await t.test('signal termination', () => {
    const afterSignal = inspect({ probeBirth: () => ({ status: 'absent' }) });
    assert.deepEqual(afterSignal, {
      status: 'lost',
      code: 'METRO_LAUNCHER_EXITED',
      reason: 'authenticated managed Metro launcher exited',
    });
  });
  await t.test('missing evidence socket', () => {
    assert.equal(inspect({ exists: () => false }).code, 'METRO_EVIDENCE_SOCKET_MISSING');
  });
  await t.test('stale listener process identity', () => {
    assert.equal(
      inspect({
        probeBirth: (pid) =>
          pid === 202
            ? {
                status: 'present',
                birth: { pid, source: 'linux-proc', token: 'replacement-birth' },
              }
            : liveBirth(pid),
      }).code,
      'METRO_LISTENER_IDENTITY_CHANGED',
    );
  });
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
    { ...binding, servingRoot: '/other' },
    { ...binding, buildGeneration: 2 },
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

test('managed Metro build-generation rotation preserves authenticated shutdown authority', async () => {
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

  const refreshed = refreshManagedMetroBuildGeneration(binding, {
    sessionId: 'session-a',
    buildGeneration: 2,
    signerCapability: 'signer',
  });

  assert.equal(refreshed.buildGeneration, 2);
  assert.notEqual(refreshed.managementProof, binding.managementProof);
  assert.equal(
    verifyManagedMetroManagementProof(refreshed, {
      sessionId: 'session-a',
      signerCapability: 'signer',
    }),
    true,
  );
  assert.equal(
    await stopManagedMetro(
      refreshed,
      { sessionId: 'session-a', signerCapability: 'signer' },
      {
        probeBirth: () => ({ status: 'absent' }),
        probeListener: () => ({ status: 'absent' }),
      },
    ),
    true,
  );
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

test('managed Metro cleanup evidence retains live processes and sockets', async (t) => {
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

  await t.test('live launcher blocks release after listener absence', async () => {
    const result = await stopManagedMetroWithEvidence(
      binding,
      { sessionId: 'session-a', signerCapability: 'signer' },
      {
        exists: () => false,
        probeBirth: (pid) =>
          pid === binding.launcherPid
            ? {
                status: 'present',
                birth: { pid, source: 'linux-proc', token: binding.launcherBirth },
              }
            : { status: 'absent' },
        probeListener: () => ({ status: 'absent' }),
        signalTree: () => {
          throw new Error('signal refused');
        },
      },
    );

    assert.equal(result.stopped, false);
    assert.equal(result.evidence.complete, false);
    assert.equal(result.evidence.launcher, 'present');
  });

  await t.test('retained evidence socket blocks release', async () => {
    const result = await stopManagedMetroWithEvidence(
      binding,
      { sessionId: 'session-a', signerCapability: 'signer' },
      {
        exists: () => true,
        probeBirth: () => ({ status: 'absent' }),
        probeListener: () => ({ status: 'absent' }),
        removeEvidenceSocket: () => {
          throw new Error('socket removal refused');
        },
      },
    );

    assert.equal(result.stopped, false);
    assert.equal(result.evidence.complete, false);
    assert.equal(result.evidence.evidenceSocket, 'present');
  });

  await t.test('confirmed owner recovery removes only an authorized stale socket', async () => {
    const invalidBinding = { ...binding, managementProof: '0'.repeat(64) };
    let socketPresent = true;
    let authorized = false;
    const dependencies = {
      authorizeEvidenceSocketRemoval: () => authorized,
      exists: () => socketPresent,
      probeBirth: () => ({ status: 'absent' as const }),
      probeListener: () => ({ status: 'absent' as const }),
      removeEvidenceSocket: () => {
        socketPresent = false;
      },
    };

    const blocked = await stopManagedMetroWithEvidence(
      invalidBinding,
      { sessionId: 'session-a', signerCapability: 'signer' },
      dependencies,
    );
    assert.equal(blocked.authenticated, false);
    assert.equal(blocked.evidence.complete, false);
    assert.equal(socketPresent, true);

    authorized = true;
    const recovered = await stopManagedMetroWithEvidence(
      invalidBinding,
      { sessionId: 'session-a', signerCapability: 'signer' },
      dependencies,
    );
    assert.equal(recovered.authenticated, false);
    assert.equal(recovered.stopped, false);
    assert.equal(recovered.evidence.complete, true);
    assert.equal(socketPresent, false);
  });
});

test('managed Metro stops an exact listener after transient post-signal uncertainty', async () => {
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
  let uncertainAfterSignal = true;
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
      probeListener: () => {
        if (listenerPresent) return { status: 'listening', pid: 202 };
        if (uncertainAfterSignal) {
          uncertainAfterSignal = false;
          return { status: 'unknown' };
        }
        return { status: 'absent' };
      },
      signalTree: ({ launcherPid, launcherPresent, listenerPid }) => {
        signals.push({ launcherPid, launcherPresent, listenerPid });
        listenerPresent = false;
      },
      wait: async () => {},
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
    /METRO_LAUNCHER_PRE_EVIDENCE_FAILED/,
  );

  assert.deepEqual(signals, [101]);
});

test('managed Metro surfaces a bounded sanitized pre-evidence launcher diagnostic', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'rn-metro-pre-evidence-'));
  const appRoot = join(runtimeRoot, 'app');
  const child = {
    pid: 101,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: () => true,
    unref: () => {},
  };
  let stopped = false;
  try {
    let failure: Error | undefined;
    try {
      await startManagedMetro(
        {
          appRoot,
          runtimeRoot,
          sourceRoot: appRoot,
          sessionId: 'secret-session-id',
          port: 8341,
          instanceId: 'secret-metro-instance',
          buildGeneration: 1,
          signerCapability: 'secret-signer-capability',
        },
        {
          environment: {
            AWS_ACCESS_KEY_ID: 'inherited-access-key',
            DATABASE_URL: 'postgres://user:database-password@example.test/service',
            NPM_TOKEN: 'inherited-npm-secret',
            SERVICE_CREDENTIAL: 'inherited-service-credential',
          },
          readText: () => JSON.stringify({ dependencies: { expo: '1' } }),
          exists: () => true,
          spawnProcess: () => child,
          listenerPid: () => null,
          readBirth: (pid) => ({ pid, source: 'linux-proc', token: `birth-${pid}` }),
          probeBirth: () =>
            stopped
              ? { status: 'absent' }
              : {
                  status: 'present',
                  birth: { pid: 101, source: 'linux-proc', token: 'birth-101' },
                },
          probeListener: () => ({ status: 'absent' }),
          signalTree: () => {
            stopped = true;
          },
          wait: async () => {
            writeFileSync(
              join(runtimeRoot, 'metro-launcher-diagnostic.json'),
              `${JSON.stringify({
                version: 1,
                code: 'METRO_LAUNCHER_ENVIRONMENT_INVALID',
                stage: 'environment',
                detail: 'native-addon-ack-root-missing',
              })}\n`,
            );
            writeFileSync(
              join(runtimeRoot, 'metro.log'),
              `${appRoot}/private-entry.cjs secret-session-id secret-signer-capability\nAWS_ACCESS_KEY_ID=inherited-access-key\nDATABASE_URL=postgres://user:database-password@example.test/service\nNPM_TOKEN=inherited-npm-secret\nSERVICE_CREDENTIAL: inherited-service-credential\nAuthorization: Bearer child-controlled-credential\n`,
              { flag: 'a' },
            );
            child.exitCode = 1;
          },
        },
      );
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    assert.ok(failure);
    assert.match(
      failure.message,
      /^METRO_LAUNCHER_ENVIRONMENT_INVALID: managed Metro launcher failed before runtime evidence/,
    );
    assert.match(failure.message, /stage environment/);
    assert.match(failure.message, /launcher exit 1/);
    assert.match(failure.message, /native-addon-ack-root-missing/);
    assert.doesNotMatch(
      failure.message,
      new RegExp(runtimeRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.doesNotMatch(failure.message, /secret-session-id|secret-metro-instance|secret-signer/);
    assert.doesNotMatch(
      failure.message,
      /database-password|inherited-access-key|inherited-npm-secret|inherited-service-credential|child-controlled-credential/,
    );
    assert.match(failure.message, /AWS_ACCESS_KEY_ID=<redacted>/);
    assert.match(failure.message, /DATABASE_URL=<redacted>/);
    assert.match(failure.message, /NPM_TOKEN=<redacted>/);
    assert.match(failure.message, /SERVICE_CREDENTIAL: <redacted>/);
    assert.match(failure.message, /Authorization: <redacted-authorization>/);
    assert.ok(failure.message.length <= 4_096);
  } finally {
    rmSync(runtimeRoot, { force: true, recursive: true });
  }
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
    /METRO_LAUNCHER_PRE_EVIDENCE_FAILED/,
  );

  assert.deepEqual(signals, [101]);
});

test('managed Metro startup cleanup rejects an unproven listener after launcher exit', async () => {
  const child = {
    pid: 101,
    exitCode: null as number | null,
    kill: () => true,
    unref: () => {},
  };
  let stopped = false;
  let captureAttempted = false;
  let signalled = false;

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
        signalTree: () => {
          signalled = true;
          stopped = true;
        },
        wait: async () => {
          if (captureAttempted) child.exitCode = 0;
        },
      },
    ),
    /METRO_START_CLEANUP_UNPROVEN/,
  );

  assert.equal(signalled, false);
});
