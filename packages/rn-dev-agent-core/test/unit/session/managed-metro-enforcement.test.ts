import assert from 'node:assert/strict';
import { ChildProcess, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  prepareManagedMetroEnforcement,
  runManagedMetroEnforcementPreflight,
  verifyManagedMetroEnforcementReceipt,
} from '../../../dist/session/managed-metro-enforcement.js';
import {
  startManagedMetro,
  stopManagedMetro,
  verifyManagedMetroManagementProof,
} from '../../../dist/session/managed-metro.js';
import { renderMetroIntegrationAdapter } from '../../../dist/session/package-integration.js';
import { probeProcessBirth, readProcessBirth } from '../../../dist/session/process-birth.js';

const roots: string[] = [];
const requireFromTest = createRequire(import.meta.url);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('test port unavailable'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function fixtureInput(platform: NodeJS.Platform = 'darwin') {
  return {
    platform,
    appRoot: '/repo/apps/mobile',
    sourceRoot: '/repo',
    runtimeRoot: '/runtime/session',
    nodeExecutable: '/node/bin/node',
    nodeVersion: 'v24.14.0',
    commandExecutable: '/repo/apps/mobile/node_modules/.bin/expo',
    commandArguments: ['start', '--dev-client', '--port', '8341'],
    commandProbeArguments: ['--version'],
    commandChainInputs: ['/repo/apps/mobile/node_modules/.bin/expo'],
    nativeAddonRoots: ['/repo/node_modules'],
    port: 8341,
    instanceId: 'metro-instance',
    runtimeInputs: [
      '/repo/apps/mobile/package.json',
      '/repo/apps/mobile/metro.config.js',
      '/repo/node_modules',
    ],
  };
}

const verifiedPlatformBinary = {
  exists: () => true,
  canonicalize: (path: string) => path,
  stat: () => ({ isFile: () => true, uid: 0, mode: 0o100755 }),
  readBytes: () => Buffer.from('sandbox-exec'),
  run: (_command: string, args: readonly string[]) => {
    if (args[0] === '--verify') return { status: 0, stdout: '', stderr: '' };
    return {
      status: 0,
      stdout: '',
      stderr: [
        'Identifier=com.apple.sandbox-exec',
        'Platform identifier=26',
        'CDHash=0123456789abcdef0123456789abcdef01234567',
        'Authority=Software Signing',
        'Authority=Apple Code Signing Certification Authority',
        'Authority=Apple Root CA',
      ].join('\n'),
    };
  },
};

const verifiedRuntime = {
  ...verifiedPlatformBinary,
  readBytes: (path: string) => Buffer.from(path),
  runtimeFiles: () => ['/node/lib/libnode.dylib'],
  runtimeVersion: () => 'v24.14.0',
};

test('managed Metro keeps strict enforcement unsupported off Darwin', () => {
  assert.deepEqual(prepareManagedMetroEnforcement(fixtureInput('linux'), verifiedPlatformBinary), {
    status: 'unsupported',
    reason: 'host-enforcement-unavailable',
  });
});

test('managed Metro refuses an unverified Darwin sandbox executable', () => {
  assert.deepEqual(
    prepareManagedMetroEnforcement(fixtureInput(), {
      ...verifiedPlatformBinary,
      run: () => ({ status: 1, stdout: '', stderr: 'invalid signature' }),
    }),
    {
      status: 'unsupported',
      reason: 'sandbox-executable-unverified',
    },
  );
});

function platformBinaryWithSandboxLeaf(leaf: string) {
  return {
    ...verifiedRuntime,
    run: (_command: string, args: readonly string[]) => {
      if (args[0] === '--verify') return { status: 0, stdout: '', stderr: '' };
      return {
        status: 0,
        stdout: '',
        stderr: [
          'Identifier=com.apple.sandbox-exec',
          'Platform identifier=26',
          'CDHash=0123456789abcdef0123456789abcdef01234567',
          `Authority=${leaf}`,
          'Authority=Apple Code Signing Certification Authority',
          'Authority=Apple Root CA',
        ].join('\n'),
      };
    },
  };
}

test('managed Metro accepts every Apple platform signing leaf authority', (t) => {
  for (const leaf of ['Software Signing', 'macOS Software Signing']) {
    const result = prepareManagedMetroEnforcement(
      fixtureInput(),
      platformBinaryWithSandboxLeaf(leaf),
    );
    t.diagnostic(JSON.stringify({ leaf, status: result.status }));
    assert.equal(result.status, 'enforced', leaf);
  }
});

test('managed Metro refuses sandbox leaf authorities outside the Apple platform set', (t) => {
  for (const leaf of [
    'Developer ID Application: Example Corp (AB12CD34EF)',
    'Apple Development: someone@example.com (AB12CD34EF)',
    'Evil macOS Software Signing',
    'macOS Software Signing Services',
    'Software',
  ]) {
    const result = prepareManagedMetroEnforcement(
      fixtureInput(),
      platformBinaryWithSandboxLeaf(leaf),
    );
    t.diagnostic(JSON.stringify({ leaf, result }));
    assert.deepEqual(
      result,
      { status: 'unsupported', reason: 'sandbox-executable-unverified' },
      leaf,
    );
  }
});

test('managed Metro preserves sandbox signature, identity, and filesystem refusals', (t) => {
  const runtime = platformBinaryWithSandboxLeaf('macOS Software Signing');
  const details = runtime.run('/usr/bin/codesign', ['-dv']).stderr;
  const signingDetails = (stderr: string, status = 0) => ({
    run: (_command: string, args: readonly string[]) =>
      args[0] === '--verify'
        ? { status: 0, stdout: '', stderr: '' }
        : { status, stdout: '', stderr },
  });
  const cases: Array<{
    name: string;
    dependencies: NonNullable<Parameters<typeof prepareManagedMetroEnforcement>[1]>;
  }> = [
    { name: 'missing executable', dependencies: { exists: () => false } },
    {
      name: 'noncanonical executable',
      dependencies: { canonicalize: () => '/other/sandbox-exec' },
    },
    {
      name: 'directory',
      dependencies: { stat: () => ({ isFile: () => false, uid: 0, mode: 0o755 }) },
    },
    {
      name: 'nonroot owner',
      dependencies: { stat: () => ({ isFile: () => true, uid: 501, mode: 0o755 }) },
    },
    {
      name: 'group writable',
      dependencies: { stat: () => ({ isFile: () => true, uid: 0, mode: 0o775 }) },
    },
    {
      name: 'other writable',
      dependencies: { stat: () => ({ isFile: () => true, uid: 0, mode: 0o757 }) },
    },
    {
      name: 'unsigned',
      dependencies: {
        run: () => ({ status: 1, stdout: '', stderr: 'code object is not signed at all' }),
      },
    },
    {
      name: 'invalid signature',
      dependencies: { run: () => ({ status: 1, stdout: '', stderr: 'invalid signature' }) },
    },
    {
      name: 'ad-hoc signature',
      dependencies: signingDetails(
        details
          .split('\n')
          .filter((line) => !line.startsWith('Authority='))
          .concat('Signature=adhoc')
          .join('\n'),
      ),
    },
    { name: 'details command failure', dependencies: signingDetails(details, 1) },
    {
      name: 'wrong identifier',
      dependencies: signingDetails(details.replace('com.apple.sandbox-exec', 'com.apple.other')),
    },
    {
      name: 'invalid platform identifier',
      dependencies: signingDetails(
        details.replace('Platform identifier=26', 'Platform identifier=unknown'),
      ),
    },
    {
      name: 'invalid CDHash',
      dependencies: signingDetails(
        details.replace('0123456789abcdef0123456789abcdef01234567', 'invalid'),
      ),
    },
    {
      name: 'wrong intermediate',
      dependencies: signingDetails(
        details.replace(
          'Authority=Apple Code Signing Certification Authority',
          'Authority=Other Intermediate',
        ),
      ),
    },
    {
      name: 'wrong root',
      dependencies: signingDetails(
        details.replace('Authority=Apple Root CA', 'Authority=Other Root'),
      ),
    },
  ];
  for (const { name, dependencies } of cases) {
    const result = prepareManagedMetroEnforcement(fixtureInput(), { ...runtime, ...dependencies });
    t.diagnostic(JSON.stringify({ rejection: name, result }));
    assert.deepEqual(
      result,
      { status: 'unsupported', reason: 'sandbox-executable-unverified' },
      name,
    );
  }
});

const ownedCssInteropCache =
  '/repo/apps/mobile/node_modules/.pnpm/react-native-css-interop@1.0.0/node_modules/react-native-css-interop/.cache';

function writeGrants(plan: ReturnType<typeof prepareManagedMetroEnforcement>): string[] {
  if (plan.status !== 'enforced') return [];
  const block = plan.profile.match(/\(allow file-write\* file-test-existence\n([\s\S]*?\))\)\n/);
  return [...(block?.[1] ?? '').matchAll(/\(subpath ("(?:[^"\\]|\\.)*")\)/g)]
    .map((match) => JSON.parse(match[1]) as string)
    .sort();
}

test('managed Metro grants writes only to the owned css-interop cache directory', () => {
  const baseWriteRoots = ['/repo/apps/mobile/.expo', '/runtime/session'];
  const granted = prepareManagedMetroEnforcement(
    { ...fixtureInput(), cssInteropCacheRoot: ownedCssInteropCache },
    verifiedRuntime,
  );
  assert.deepEqual(writeGrants(granted), [...baseWriteRoots, ownedCssInteropCache].sort());
  assert.deepEqual(
    writeGrants(prepareManagedMetroEnforcement(fixtureInput(), verifiedRuntime)),
    baseWriteRoots,
  );
  const symlink = { lstat: () => ({ isSymbolicLink: () => true }) };
  const refused: Array<{
    name: string;
    candidate: string;
    runtimeRoot?: string;
    protectedRuntimeRoots?: string[];
    canonicalize?: (path: string) => string;
    lstat?: (path: string) => { isSymbolicLink(): boolean };
  }> = [
    {
      name: 'runtime root equals the cache',
      candidate: ownedCssInteropCache,
      runtimeRoot: ownedCssInteropCache,
    },
    {
      name: 'runtime root contains the cache',
      candidate: ownedCssInteropCache,
      runtimeRoot: dirname(ownedCssInteropCache),
    },
    {
      name: 'shared package store',
      candidate: '/Users/dev/Library/pnpm/store/v3/react-native-css-interop/.cache',
    },
    { name: 'other package cache', candidate: '/repo/apps/mobile/node_modules/nativewind/.cache' },
    {
      name: 'package source directory',
      candidate: '/repo/apps/mobile/node_modules/react-native-css-interop/dist',
    },
    {
      name: 'protected runtime root',
      candidate: ownedCssInteropCache,
      protectedRuntimeRoots: [dirname(ownedCssInteropCache)],
    },
    { name: 'symlinked cache directory', candidate: ownedCssInteropCache, ...symlink },
    {
      name: 'unreadable cache directory',
      candidate: ownedCssInteropCache,
      lstat: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    },
    {
      name: 'symlinked package directory',
      candidate: ownedCssInteropCache,
      canonicalize: (path: string) =>
        path === dirname(ownedCssInteropCache) ? '/elsewhere/react-native-css-interop' : path,
    },
  ];
  for (const {
    name,
    candidate,
    runtimeRoot,
    protectedRuntimeRoots,
    canonicalize,
    lstat,
  } of refused) {
    const input = { ...fixtureInput(), cssInteropCacheRoot: candidate, protectedRuntimeRoots };
    if (runtimeRoot) input.runtimeRoot = runtimeRoot;
    const plan = prepareManagedMetroEnforcement(input, {
      ...verifiedRuntime,
      ...(canonicalize ? { canonicalize } : {}),
      ...(lstat ? { lstat } : {}),
    });
    assert.equal(plan.status, 'enforced', name);
    assert.deepEqual(
      writeGrants(plan),
      ['/repo/apps/mobile/.expo', runtimeRoot ?? '/runtime/session'].sort(),
      name,
    );
  }
});

test('managed Metro preflight observation stays truthful without changing outcomes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rn-metro-preflight-observe-'));
  roots.push(root);
  const runtimeRoot = realpathSync(root);
  const plan = prepareManagedMetroEnforcement({ ...fixtureInput(), runtimeRoot }, verifiedRuntime);
  assert.equal(plan.status, 'enforced');
  if (plan.status !== 'enforced') return;
  const allTrue = Object.fromEntries(
    [
      'descendantCreationAllowed',
      'unauthorizedExecutableDenied',
      'unmanifestedReadDenied',
      'unmanifestedWriteDenied',
      'symlinkEscapeDenied',
      'unallocatedListenerDenied',
      'allocatedListenerAllowed',
      'networkOutboundDenied',
      'resolvedCommandAllowed',
      'commandCleanupConfirmed',
      'commandChainStable',
    ].map((flag) => [flag, true]),
  );
  const diagnostic = {
    timings: { allocatedMs: 3, spawnedMs: 9, occupancyMs: 15012, cleanupMs: 15040, totalMs: 15044 },
    commandExit: { code: 1, signal: null, atMs: 800 },
    commandCauses: ['EPERM'],
  };
  const cases: Array<{
    name: string;
    result: {
      status: number | null;
      stdout: string;
      stderr: string;
      signal?: string | null;
      timedOut?: boolean;
    };
    expectError: string | null;
    expect: Record<string, unknown>;
  }> = [
    {
      name: 'success',
      result: { status: 0, stdout: JSON.stringify({ ...allTrue, diagnostic }), stderr: '' },
      expectError: null,
      expect: { outcome: 'receipt', complete: true, status: 0, outerTimedOut: false },
    },
    {
      name: 'nonzero with failed flag',
      result: {
        status: 1,
        stdout: JSON.stringify({ ...allTrue, resolvedCommandAllowed: false, diagnostic }),
        stderr: '',
      },
      expectError: 'METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight failed',
      expect: { outcome: 'failed', complete: true, status: 1 },
    },
    {
      name: 'early child exit without receipt',
      result: { status: 1, stdout: '', stderr: 'node: bad option\n' },
      expectError: 'METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight failed',
      expect: { outcome: 'failed', complete: false, flags: null, timings: null },
    },
    {
      name: 'outer timeout',
      result: { status: null, stdout: '', stderr: '', signal: 'SIGTERM', timedOut: true },
      expectError: 'METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight failed',
      expect: {
        outcome: 'failed',
        complete: false,
        status: null,
        signal: 'SIGTERM',
        outerTimedOut: true,
      },
    },
    {
      name: 'zero exit with incomplete flags',
      result: {
        status: 0,
        stdout: JSON.stringify({ ...allTrue, symlinkEscapeDenied: false }),
        stderr: '',
      },
      expectError: 'METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight is incomplete',
      expect: { outcome: 'incomplete', complete: false, timings: null },
    },
  ];
  for (const { name, result, expectError, expect } of cases) {
    const observations: unknown[] = [];
    const runPreflight = () =>
      runManagedMetroEnforcementPreflight(plan, {
        writeCanary: () => {},
        removeCanary: () => {},
        run: () => result,
        observe: (observation) => observations.push(observation),
      });
    if (expectError) assert.throws(runPreflight, { message: expectError }, name);
    else assert.equal(runPreflight().resolvedCommandAllowed, true, name);
    assert.equal(observations.length, 1, name);
    const observation = observations[0] as Record<string, unknown>;
    t.diagnostic(JSON.stringify({ scenario: name, observation }));
    for (const [key, value] of Object.entries(expect)) {
      assert.deepEqual(observation[key], value, `${name}: ${key}`);
    }
    if (result.stdout.includes('"diagnostic"')) {
      assert.deepEqual(observation.timings, diagnostic.timings, name);
      assert.deepEqual(observation.commandExit, diagnostic.commandExit, name);
      assert.deepEqual(observation.commandCauses, ['EPERM'], name);
    }
  }
  const projected: unknown[] = [];
  runManagedMetroEnforcementPreflight(plan, {
    writeCanary: () => {},
    removeCanary: () => {},
    run: () => ({
      status: 0,
      signal: 'secret-signal',
      stdout: JSON.stringify({
        ...allTrue,
        diagnostic: {
          timings: { ...diagnostic.timings, 'API_TOKEN=hunter2': 123 },
          commandExit: { code: 'hunter2', signal: 'secret-signal', atMs: -1 },
          commandCauses: ['EPERM', 'RN_DEV_AGENT_PRIVATE', 'abcédef', 'PRIVATE'],
          exceptionCause: 'secret exception message',
        },
      }),
      stderr:
        'abcPRIVATE abcédef RN_DEV_AGENT_PRIVATE Node.js v123.456.789 JavaScript heap out of memory',
    }),
    observe: (observation) => projected.push(observation),
  });
  assert.deepEqual(projected[0], {
    version: 1,
    outcome: 'receipt',
    complete: true,
    status: 0,
    signal: 'unknown',
    outerTimedOut: false,
    elapsedMs: (projected[0] as { elapsedMs: number }).elapsedMs,
    flags: allTrue,
    timings: diagnostic.timings,
    commandExit: { code: null, signal: 'unknown', atMs: -1 },
    commandCauses: ['EPERM'],
    preflightCauses: ['RN_DEV_AGENT', 'NODE_RUNTIME', 'OUT_OF_MEMORY'],
    exceptionCause: 'unknown',
  });
  const setupFailures: unknown[] = [];
  assert.throws(
    () =>
      runManagedMetroEnforcementPreflight(plan, {
        writeCanary: () => {
          throw Object.assign(new Error('EEXIST: canary exists'), { code: 'EEXIST' });
        },
        removeCanary: () => {},
        run: () => ({ status: 0, stdout: '', stderr: '' }),
        observe: (observation) => setupFailures.push(observation),
      }),
    { message: 'METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight is invalid' },
  );
  assert.deepEqual(
    (setupFailures[0] as Record<string, unknown>).outcome,
    'invalid',
    'setup failure observed',
  );
  const swallowed = runManagedMetroEnforcementPreflight(plan, {
    writeCanary: () => {},
    removeCanary: () => {},
    run: () => ({ status: 0, stdout: JSON.stringify({ ...allTrue, diagnostic }), stderr: '' }),
    observe: () => {
      throw new Error('sink failure');
    },
  });
  assert.equal(swallowed.resolvedCommandAllowed, true, 'observer failure does not change outcome');

  for (const { name, result, expectError } of cases) {
    const removed: string[] = [];
    const emitted: unknown[] = [];
    const runPreflight = () =>
      runManagedMetroEnforcementPreflight(plan, {
        writeCanary: () => {},
        removeCanary: (path) => removed.push(path),
        run: () => ({
          ...result,
          get stderr() {
            throw new Error('observation construction failure');
          },
        }),
        observe: (observation) => emitted.push(observation),
      });
    if (expectError) assert.throws(runPreflight, { message: expectError }, name);
    else assert.deepEqual(runPreflight(), swallowed, name);
    assert.deepEqual(emitted, [], name);
    assert.deepEqual(removed, [plan.preflightEnvironmentPath, plan.canaryPath], name);
    assert.equal(fs.existsSync(plan.symlinkCanaryPath), false, name);
  }

  const setupError = new Error('canary setup failed');
  const emittedSetupFailures: unknown[] = [];
  assert.throws(
    () =>
      runManagedMetroEnforcementPreflight(plan, {
        writeCanary: () => {
          throw setupError;
        },
        observe: (observation) => emittedSetupFailures.push(observation),
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        'METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight is invalid',
      );
      assert.equal(error.cause, setupError);
      return true;
    },
  );
  assert.equal((emittedSetupFailures[0] as { exceptionCause: string }).exceptionCause, 'unknown');
  assert.ok(!JSON.stringify(emittedSetupFailures).includes(setupError.message));

  mkdirSync(plan.commandStderrPath);
  for (const { name, result, expectError } of cases) {
    const removed: string[] = [];
    const runPreflight = () =>
      runManagedMetroEnforcementPreflight(plan, {
        writeCanary: () => {},
        removeCanary: (path) => removed.push(path),
        run: () => result,
      });
    if (expectError) assert.throws(runPreflight, { message: expectError }, name);
    else assert.deepEqual(runPreflight(), swallowed, name);
    assert.deepEqual(removed, [plan.preflightEnvironmentPath, plan.canaryPath], name);
    assert.equal(fs.existsSync(plan.symlinkCanaryPath), false, name);
    assert.equal(fs.statSync(plan.commandStderrPath).isDirectory(), true, name);
  }
});

test('managed Metro preflight diagnostic capture bounds input and survives I/O failures', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rn-metro-preflight-capture-')));
  roots.push(root);
  const prepared = prepareManagedMetroEnforcement(
    { ...fixtureInput(), runtimeRoot: root },
    verifiedRuntime,
  );
  assert.equal(prepared.status, 'enforced');
  if (prepared.status !== 'enforced') return;
  const plan = { ...prepared, commandChainAttestation: [] };
  const expectedFlags = {
    descendantCreationAllowed: true,
    unauthorizedExecutableDenied: true,
    unmanifestedReadDenied: true,
    unmanifestedWriteDenied: true,
    symlinkEscapeDenied: true,
    unallocatedListenerDenied: true,
    allocatedListenerAllowed: true,
    networkOutboundDenied: true,
    resolvedCommandAllowed: true,
    commandCleanupConfirmed: true,
    commandChainStable: true,
  };
  let preflightSource = '';
  let preflightInput = '';
  const baselineReceipt = runManagedMetroEnforcementPreflight(plan, {
    writeCanary: () => {},
    removeCanary: () => {},
    run: (_command, args) => {
      preflightSource = args[4];
      preflightInput = args[5];
      return { status: 0, stdout: JSON.stringify(expectedFlags), stderr: '' };
    },
  });
  const finalDiagnostic = '\nEPERM: operation not permitted\n';
  const longSecret = `${'private-credential-line\n'.repeat(6000)}credential-end-abcédef`;
  let persistedResult = { status: 0, stdout: '', stderr: '' };
  const scenarios = [
    'split secret',
    'unicode stderr',
    'exception split secret',
    'noisy stderr',
    'single long line',
    'overlapping secrets',
    'read boundary secret',
    'long multiline secret',
    'non-ASCII secret',
    'open write failure',
    'open read failure',
    'stat failure',
    'read failure',
    'short read',
    'close failure',
  ];
  for (const scenario of scenarios) {
    const result = { status: -1, stdout: '', stderr: '' };
    const readSizes: number[] = [];
    let unboundedReads = 0;
    let listenerCount = 0;
    let stderrMode: unknown;
    const ioError = () => Object.assign(new Error('diagnostic I/O failure'), { code: 'EACCES' });
    const command = Object.assign(new EventEmitter(), {
      pid: 424242,
      exitCode: null as number | null,
      stdio: Array.from({ length: 10 }, () => ({ end: () => {}, resume: () => {} })),
      kill: () => {
        command.exitCode = 0;
        command.emit('exit', 0, 'SIGTERM');
      },
    });
    await runInNewContext(preflightSource, {
      Buffer,
      performance,
      setTimeout,
      process: {
        argv: ['node', preflightInput],
        exit: (status: number) => {
          result.status = status;
        },
        kill: () => {
          throw Object.assign(new Error('no process group'), { code: 'ESRCH' });
        },
      },
      require: (name: string) => {
        if (name === 'node:child_process') {
          return {
            spawnSync: () => ({ status: null, error: ioError() }),
            spawn: (_executable: string, _args: string[], options: { stdio: unknown[] }) => {
              stderrMode = options.stdio[2];
              if (typeof stderrMode === 'number') {
                const output =
                  scenario === 'single long line'
                    ? `${'x'.repeat(70000)} EPERM: operation not permitted\n`
                    : scenario === 'overlapping secrets'
                      ? `${'x'.repeat(70000)}\nabcPRIVATE\nEPERM\n`
                      : scenario === 'unicode stderr'
                        ? '€'.repeat(3000)
                        : scenario === 'read boundary secret'
                          ? `API_TOKEN=hunter2${'.'.repeat(65536 - 6 - finalDiagnostic.length)}${finalDiagnostic}`
                          : scenario === 'long multiline secret'
                            ? `Rejected value ${longSecret}${finalDiagnostic}`
                            : scenario === 'non-ASCII secret'
                              ? `Rejected value abcédef${finalDiagnostic}`
                              : `API_TOKEN=hunter2${'.'.repeat(8186)}`;
                fs.writeSync(stderrMode, output);
                if (scenario === 'noisy stderr') {
                  const size = 256 * 1024 * 1024;
                  fs.ftruncateSync(stderrMode, size);
                  fs.writeSync(stderrMode, finalDiagnostic, size - finalDiagnostic.length);
                }
              }
              return command;
            },
          };
        }
        if (name === 'node:fs') {
          return {
            ...fs,
            openSync: (path: string, flags: string | number, mode?: number) => {
              if (
                (scenario === 'open write failure' && flags === 'w') ||
                (scenario === 'open read failure' && flags !== 'w')
              )
                throw ioError();
              return fs.openSync(path, flags, mode);
            },
            closeSync: (descriptor: number) => {
              fs.closeSync(descriptor);
              if (scenario === 'close failure') throw ioError();
            },
            fstatSync: (descriptor: number) => {
              if (scenario === 'stat failure') throw ioError();
              return fs.fstatSync(descriptor);
            },
            readSync: (
              descriptor: number,
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              readSizes.push(length);
              if (scenario === 'read failure') throw ioError();
              if (scenario === 'short read') return 0;
              return fs.readSync(descriptor, buffer, offset, length, position);
            },
            readFileSync: (path: string) => {
              if (path === plan.preflightEnvironmentPath) {
                if (scenario === 'exception split secret') {
                  throw new Error(`${'x'.repeat(510)}hunter2`);
                }
                return '{}';
              }
              if (path === plan.commandStderrPath) unboundedReads += 1;
              throw ioError();
            },
            writeFileSync: (path: string | number, data: string) => {
              if (path === 1) result.stdout = data;
              else throw ioError();
            },
          };
        }
        if (name === 'node:net') {
          return {
            createServer: () => {
              const server = Object.assign(new EventEmitter(), {
                listen: (_port: number, _host: string, callback: () => void) => {
                  listenerCount += 1;
                  queueMicrotask(() => {
                    if (listenerCount === 2 || listenerCount === 4) {
                      server.emit('error', { code: listenerCount === 2 ? 'EADDRINUSE' : 'EPERM' });
                    } else callback();
                  });
                },
                close: (callback: () => void) => callback(),
              });
              return server;
            },
            createConnection: () => {
              const connection = new EventEmitter();
              queueMicrotask(() => connection.emit('error', ioError()));
              return connection;
            },
          };
        }
        return requireFromTest(name);
      },
    });
    assert.equal(result.status, scenario === 'exception split secret' ? 1 : 0, scenario);
    assert.equal(unboundedReads, 0, scenario);
    assert.ok(readSizes.reduce((total, size) => total + size, 0) <= 65536, scenario);
    if (scenario === 'noisy stderr') assert.deepEqual(readSizes, [65536], scenario);
    if (scenario === 'open write failure') assert.equal(stderrMode, 'ignore', scenario);
    const observations: Array<{ commandCauses: string[]; exceptionCause: string | null }> = [];
    const runPreflight = () =>
      runManagedMetroEnforcementPreflight(plan, {
        writeCanary: () => {},
        removeCanary: () => {},
        run: () => result,
        observe: (observation) => observations.push(observation),
      });
    if (scenario === 'exception split secret') {
      assert.throws(runPreflight, {
        message: 'METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight failed',
      });
      assert.equal(observations[0].exceptionCause, 'unknown', scenario);
    } else assert.deepEqual(runPreflight(), baselineReceipt, scenario);
    assert.equal(observations.length, 1, scenario);
    const expectedCauses = [
      'noisy stderr',
      'single long line',
      'overlapping secrets',
      'read boundary secret',
      'long multiline secret',
      'non-ASCII secret',
    ].includes(scenario)
      ? ['EPERM']
      : ['unknown'];
    assert.deepEqual(observations[0].commandCauses, expectedCauses, scenario);
    assert.doesNotMatch(JSON.stringify(observations), /hunter2|PRIVATE|abc[é?]def/);
    assert.doesNotMatch(result.stdout, /hunter2|PRIVATE|abc[é?]def/);
    t.diagnostic(JSON.stringify({ scenario, readSizes, observation: observations[0] }));
    if (scenario === 'single long line') persistedResult = result;
  }
  await assert.rejects(
    startManagedMetro(
      {
        appRoot: root,
        runtimeRoot: root,
        sourceRoot: root,
        sessionId: 'diagnostic-session',
        instanceId: 'diagnostic-metro',
        buildGeneration: 1,
        signerCapability: 'diagnostic-signer',
        port: 8341,
      },
      {
        environment: {
          API_TOKEN: 'prefixabc',
          SERVICE_SECRET: 'bcPRIVATE',
          OTHER_TOKEN: 'abcédef',
        },
        exists: () => true,
        readText: () => JSON.stringify({ dependencies: { expo: '1' } }),
        prepareEnforcement: () => plan,
        preflightEnforcement: (input, dependencies) =>
          runManagedMetroEnforcementPreflight(input, {
            ...dependencies,
            writeCanary: () => {},
            removeCanary: () => {},
            run: () => persistedResult,
          }),
        spawnProcess: () => new ChildProcess(),
      },
    ),
    { message: 'METRO_START_UNAVAILABLE: package-local Metro process did not start' },
  );
  const record = JSON.parse(
    readFileSync(join(root, 'metro-enforcement-diagnostic-diagnostic-metro.json'), 'utf8'),
  );
  assert.equal(record.recordComplete, true);
  assert.equal(
    fs.statSync(join(root, 'metro-enforcement-diagnostic-diagnostic-metro.json')).mode & 0o777,
    0o600,
  );
  assert.deepEqual(record.preflight.commandCauses, ['EPERM']);
  assert.equal(record.preflight.outcome, 'receipt');
  assert.doesNotMatch(
    JSON.stringify(record),
    /prefixabc|PRIVATE|abc[é?]def|operation not permitted/,
  );
  t.diagnostic(JSON.stringify({ persistedDiagnostic: record, mode: '0600' }));
});

test('managed Metro derives a deterministic descendant-capable Darwin profile', () => {
  const first = prepareManagedMetroEnforcement(fixtureInput(), verifiedRuntime);
  const second = prepareManagedMetroEnforcement(fixtureInput(), verifiedRuntime);

  assert.equal(first.status, 'enforced');
  assert.deepEqual(second, first);
  if (first.status !== 'enforced') return;
  assert.equal(first.kind, 'darwin-seatbelt-v2');
  assert.equal(first.sandboxExecutable, '/usr/bin/sandbox-exec');
  assert.match(first.profileSha256, /^[a-f0-9]{64}$/);
  assert.match(first.sandboxExecutableSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.sandboxExecutableCdHash, '0123456789abcdef0123456789abcdef01234567');
  assert.match(first.profile, /\(deny default\)/);
  assert.match(first.profile, /\(local tcp "\*:8341"\)/);
  assert.match(first.profile, /\(subpath "\/repo"\)/);
  assert.match(first.profile, /\(subpath "\/runtime\/session"\)/);
  assert.match(first.profile, /\(subpath "\/repo\/apps\/mobile\/\.expo"\)/);
  assert.match(first.profile, /\(allow process-fork\)/);
  assert.doesNotMatch(first.profile, /\(deny process-fork\)/);
  assert.doesNotMatch(first.profile, /\(literal "\/bin\/sh"\)/);
  assert.match(first.profile, /\(deny network-outbound\)/);
  assert.match(first.profile, /\(extension "node"\)/);
  assert.match(first.profile, /\(subpath "\/repo\/node_modules"\)/);
  assert.deepEqual(first.nodeRuntimeAttestation, {
    version: 1,
    executable: {
      path: '/node/bin/node',
      sha256: createHash('sha256').update('/node/bin/node').digest('hex'),
      signingIdentity: {
        authorities: [
          'Apple Code Signing Certification Authority',
          'Apple Root CA',
          'Software Signing',
        ],
        cdHash: '0123456789abcdef0123456789abcdef01234567',
        identifier: 'com.apple.sandbox-exec',
      },
    },
    executableMappings: [
      {
        path: '/node/bin/node',
        sha256: createHash('sha256').update('/node/bin/node').digest('hex'),
        signingIdentity: {
          authorities: [
            'Apple Code Signing Certification Authority',
            'Apple Root CA',
            'Software Signing',
          ],
          cdHash: '0123456789abcdef0123456789abcdef01234567',
          identifier: 'com.apple.sandbox-exec',
        },
      },
      {
        path: '/repo/apps/mobile/node_modules/.bin/expo',
        sha256: createHash('sha256')
          .update('/repo/apps/mobile/node_modules/.bin/expo')
          .digest('hex'),
        signingIdentity: {
          authorities: [
            'Apple Code Signing Certification Authority',
            'Apple Root CA',
            'Software Signing',
          ],
          cdHash: '0123456789abcdef0123456789abcdef01234567',
          identifier: 'com.apple.sandbox-exec',
        },
      },
      {
        path: '/usr/bin/env',
        sha256: createHash('sha256').update('/usr/bin/env').digest('hex'),
        signingIdentity: {
          authorities: [
            'Apple Code Signing Certification Authority',
            'Apple Root CA',
            'Software Signing',
          ],
          cdHash: '0123456789abcdef0123456789abcdef01234567',
          identifier: 'com.apple.sandbox-exec',
        },
      },
    ],
    linkedRuntimePaths: ['/node/lib/libnode.dylib'],
    loadedRuntimeFiles: [
      {
        path: '/node/bin/node',
        sha256: createHash('sha256').update('/node/bin/node').digest('hex'),
        signingIdentity: {
          authorities: [
            'Apple Code Signing Certification Authority',
            'Apple Root CA',
            'Software Signing',
          ],
          cdHash: '0123456789abcdef0123456789abcdef01234567',
          identifier: 'com.apple.sandbox-exec',
        },
      },
      {
        path: '/node/lib/libnode.dylib',
        sha256: createHash('sha256').update('/node/lib/libnode.dylib').digest('hex'),
        signingIdentity: {
          authorities: [
            'Apple Code Signing Certification Authority',
            'Apple Root CA',
            'Software Signing',
          ],
          cdHash: '0123456789abcdef0123456789abcdef01234567',
          identifier: 'com.apple.sandbox-exec',
        },
      },
    ],
    runtimeVersion: 'v24.14.0',
    sharedRuntimeCache: null,
  });
  assert.equal(first.unallocatedPort, 0);
});

test('managed Metro attests non-materialized system libraries through the dyld cache', () => {
  const cachePath = '/System/Library/dyld/dyld_shared_cache_arm64e';
  const plan = prepareManagedMetroEnforcement(fixtureInput(), {
    ...verifiedRuntime,
    exists: (path: string) => path !== '/usr/lib/libSystem.B.dylib',
    runtimeFiles: () => ['/usr/lib/libSystem.B.dylib'],
    runtimeCache: () => cachePath,
  });

  assert.equal(plan.status, 'enforced');
  if (plan.status !== 'enforced') return;
  assert.deepEqual(plan.nodeRuntimeAttestation.linkedRuntimePaths, ['/usr/lib/libSystem.B.dylib']);
  assert.equal(plan.nodeRuntimeAttestation.sharedRuntimeCache?.path, cachePath);
  assert.equal(
    plan.nodeRuntimeAttestation.sharedRuntimeCache?.sha256,
    createHash('sha256').update(cachePath).digest('hex'),
  );
});

test('managed Metro rejects a receipt after Node executable bytes change', () => {
  const plan = prepareManagedMetroEnforcement(fixtureInput(), verifiedRuntime);
  assert.equal(plan.status, 'enforced');
  if (plan.status !== 'enforced') return;
  const receipt = {
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
    resolvedCommandAllowed: true,
    commandCleanupConfirmed: true,
    commandChainStable: true,
    nodeRuntimeAttestation: plan.nodeRuntimeAttestation,
    commandChainAttestation: plan.commandChainAttestation,
  };

  assert.equal(
    verifyManagedMetroEnforcementReceipt(fixtureInput(), receipt, verifiedRuntime),
    true,
  );
  assert.equal(
    verifyManagedMetroEnforcementReceipt(fixtureInput(), receipt, {
      ...verifiedRuntime,
      readBytes: (path: string) => Buffer.from(path === '/node/bin/node' ? 'replaced-node' : path),
    }),
    false,
  );
  assert.equal(
    verifyManagedMetroEnforcementReceipt(
      { ...fixtureInput(), commandArguments: ['start', '--port', '8341'] },
      receipt,
      verifiedRuntime,
    ),
    false,
  );
  assert.equal(
    verifyManagedMetroEnforcementReceipt(fixtureInput(), receipt, {
      ...verifiedRuntime,
      readBytes: (path: string) =>
        Buffer.from(path.endsWith('/node_modules/.bin/expo') ? 'replaced-shim' : path),
    }),
    false,
  );
});

test(
  'managed Metro Darwin preflight proves allowed bind and denied escapes',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'rn-metro-enforcement-'));
    roots.push(root);
    const sourceRoot = realpathSync(root);
    const runtimeRoot = join(sourceRoot, 'runtime');
    const commandExecutable = join(sourceRoot, 'metro-entry.js');
    writeFileSync(
      commandExecutable,
      "require('node:net').createServer(() => {}).listen(Number(process.argv[2]), '127.0.0.1'); setInterval(() => {}, 1 << 30);",
    );
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('test port unavailable'));
          return;
        }
        server.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    });
    const plan = prepareManagedMetroEnforcement({
      platform: process.platform,
      appRoot: sourceRoot,
      sourceRoot,
      runtimeRoot,
      nodeExecutable: process.execPath,
      nodeVersion: process.version,
      commandExecutable: process.execPath,
      commandArguments: [commandExecutable, String(port)],
      commandProbeArguments: [commandExecutable, '--version'],
      commandChainInputs: [process.execPath, commandExecutable],
      port,
      instanceId: 'integration',
      runtimeInputs: [commandExecutable],
    });

    t.diagnostic(JSON.stringify({ sandboxPlan: plan.status }));
    assert.equal(plan.status, 'enforced');
    if (plan.status !== 'enforced') return;
    const receipt = runManagedMetroEnforcementPreflight(plan);
    t.diagnostic(JSON.stringify({ sandboxExecutable: plan.sandboxExecutable, receipt }));

    assert.deepEqual(receipt, {
      version: 2,
      kind: 'darwin-seatbelt-v2',
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
      resolvedCommandAllowed: true,
      commandCleanupConfirmed: true,
      commandChainStable: true,
      nodeRuntimeAttestation: plan.nodeRuntimeAttestation,
      commandChainAttestation: plan.commandChainAttestation,
    });
    assert.equal(dirname(plan.canaryPath), '/private/tmp');
  },
);

test(
  'managed Metro sandbox admits only the owned css-interop cache write',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'rn-metro-cache-grant-'));
    roots.push(root);
    const outside = mkdtempSync(join(tmpdir(), 'rn-metro-shared-store-'));
    roots.push(outside);
    const appRoot = realpathSync(root);
    const runtimeRoot = join(appRoot, 'runtime');
    const protectedRoot = join(appRoot, '.rn-agent', 'integration');
    const pnpmRoot = join(appRoot, 'node_modules', '.pnpm');
    const cssInteropRoot = join(
      pnpmRoot,
      'react-native-css-interop@1.0.0',
      'node_modules',
      'react-native-css-interop',
    );
    const nativeWindRoot = join(pnpmRoot, 'nativewind@1.0.0', 'node_modules', 'nativewind');
    const sharedStoreCache = join(realpathSync(outside), 'react-native-css-interop', '.cache');
    for (const directory of [
      runtimeRoot,
      protectedRoot,
      join(cssInteropRoot, '.cache'),
      nativeWindRoot,
      dirname(sharedStoreCache),
    ]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(join(cssInteropRoot, 'index.js'), 'module.exports = {};\n');
    symlinkSync(
      join(realpathSync(outside), 'escape-target'),
      join(cssInteropRoot, '.cache', 'escape'),
    );
    const command = join(appRoot, 'metro-entry.js');
    writeFileSync(
      command,
      "require('node:net').createServer(() => {}).listen(Number(process.argv[2]), '127.0.0.1'); setInterval(() => {}, 1 << 30);",
    );
    const port = await freePort();
    const planFor = (cssInteropCacheRoot: string | null) =>
      prepareManagedMetroEnforcement({
        platform: process.platform,
        appRoot,
        sourceRoot: appRoot,
        runtimeRoot,
        nodeExecutable: process.execPath,
        nodeVersion: process.version,
        commandExecutable: process.execPath,
        commandArguments: [command, String(port)],
        commandProbeArguments: [command, '--version'],
        commandChainInputs: [process.execPath, command],
        protectedRuntimeRoots: [protectedRoot],
        cssInteropCacheRoot,
        port,
        instanceId: 'cache-grant',
        runtimeInputs: [command],
      });
    const attempts = {
      ownedCache: join(cssInteropRoot, '.cache', 'ios.js'),
      otherPackageCache: join(nativeWindRoot, '.cache', 'native.js'),
      packageSource: join(cssInteropRoot, 'index.js'),
      escapedTarget: join(cssInteropRoot, '.cache', 'escape'),
      sharedStore: join(sharedStoreCache, 'ios.js'),
      protectedRoot: join(protectedRoot, 'ios.js'),
    };
    const probe = (cssInteropCacheRoot: string | null) => {
      const plan = planFor(cssInteropCacheRoot);
      assert.equal(plan.status, 'enforced');
      if (plan.status !== 'enforced') throw new Error('unreachable');
      const result = spawnSync(
        plan.sandboxExecutable,
        [
          '-p',
          plan.profile,
          plan.nodeExecutable,
          '-e',
          `const fs = require('node:fs');
const { dirname } = require('node:path');
const results = {};
for (const [name, path] of Object.entries(JSON.parse(process.env.RN_TEST_WRITE_ATTEMPTS))) {
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, 'generated');
    results[name] = 'written';
  } catch (error) {
    results[name] = error.code;
  }
}
process.stdout.write(JSON.stringify(results));`,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_OPTIONS: '',
            RN_TEST_WRITE_ATTEMPTS: JSON.stringify(attempts),
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const observed = JSON.parse(result.stdout) as Record<string, string>;
      t.diagnostic(JSON.stringify({ cssInteropCacheRoot, observed }));
      return observed;
    };

    assert.deepEqual(probe(join(cssInteropRoot, '.cache')), {
      ownedCache: 'written',
      otherPackageCache: 'EPERM',
      packageSource: 'EPERM',
      escapedTarget: 'EPERM',
      sharedStore: 'EPERM',
      protectedRoot: 'EPERM',
    });
    assert.equal(probe(null).ownedCache, 'EPERM');
    assert.equal(probe(sharedStoreCache).sharedStore, 'EPERM');
  },
);

test(
  'managed Metro earns managed-sandbox-v1 only after an attested sandbox launch',
  { skip: process.platform !== 'darwin', timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'rn-metro-managed-sandbox-'));
    roots.push(root);
    const appRoot = realpathSync(root);
    const runtimeRoot = join(appRoot, 'runtime');
    const integrationRoot = join(appRoot, '.rn-agent', 'integration');
    const binRoot = join(appRoot, 'node_modules', '.bin');
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(integrationRoot, { recursive: true });
    mkdirSync(binRoot, { recursive: true });
    writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ dependencies: { expo: '1' } }));
    writeFileSync(join(integrationRoot, 'rn-session-metro.cjs'), renderMetroIntegrationAdapter());
    const pnpmRoot = join(appRoot, 'node_modules', '.pnpm');
    const nativeWindRoot = join(pnpmRoot, 'nativewind@1.0.0', 'node_modules', 'nativewind');
    const cssInteropRoot = join(
      pnpmRoot,
      'react-native-css-interop@1.0.0',
      'node_modules',
      'react-native-css-interop',
    );
    const lightningCssRoot = join(pnpmRoot, 'lightningcss@1.0.0', 'node_modules', 'lightningcss');
    for (const dependencyRoot of [nativeWindRoot, cssInteropRoot, lightningCssRoot]) {
      mkdirSync(dependencyRoot, { recursive: true });
    }
    writeFileSync(
      join(nativeWindRoot, 'index.js'),
      "module.exports = require('react-native-css-interop');\n",
    );
    writeFileSync(join(cssInteropRoot, 'index.js'), "module.exports = require('lightningcss');\n");
    writeFileSync(
      join(nativeWindRoot, 'package.json'),
      JSON.stringify({ name: 'nativewind', version: '1.0.0' }),
    );
    mkdirSync(join(nativeWindRoot, 'metro'), { recursive: true });
    writeFileSync(
      join(nativeWindRoot, 'metro', 'package.json'),
      JSON.stringify({ main: '../dist/metro' }),
    );
    mkdirSync(join(nativeWindRoot, 'dist', 'metro'), { recursive: true });
    writeFileSync(
      join(nativeWindRoot, 'dist', 'metro', 'index.js'),
      "module.exports = require('react-native-css-interop/metro');\n",
    );
    symlinkSync(
      cssInteropRoot,
      join(pnpmRoot, 'nativewind@1.0.0', 'node_modules', 'react-native-css-interop'),
      'dir',
    );
    writeFileSync(
      join(cssInteropRoot, 'package.json'),
      JSON.stringify({ name: 'react-native-css-interop', version: '1.0.0' }),
    );
    mkdirSync(join(cssInteropRoot, 'metro'), { recursive: true });
    writeFileSync(
      join(cssInteropRoot, 'metro', 'package.json'),
      JSON.stringify({ main: '../dist/metro/index.js' }),
    );
    mkdirSync(join(cssInteropRoot, 'dist', 'metro'), { recursive: true });
    writeFileSync(
      join(cssInteropRoot, 'dist', 'metro', 'index.js'),
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const outputDirectory = path.resolve(__dirname, '../../.cache');",
        'fs.mkdirSync(outputDirectory, { recursive: true });',
        "fs.writeFileSync(path.join(outputDirectory, 'ios.js'), 'generated');",
        'module.exports = {};',
      ].join('\n'),
    );
    const cssInteropCachePath = join(cssInteropRoot, '.cache', 'ios.js');
    writeFileSync(
      join(lightningCssRoot, 'index.js'),
      "module.exports = require('./lightningcss.node');\n",
    );
    const addonPath = join(lightningCssRoot, 'lightningcss.node');
    copyFileSync(
      requireFromTest.resolve('@oxfmt/binding-darwin-arm64/oxfmt.darwin-arm64.node'),
      addonPath,
    );
    const alternateCssInteropRoot = join(
      pnpmRoot,
      'react-native-css-interop@2.0.0',
      'node_modules',
      'react-native-css-interop',
    );
    mkdirSync(join(alternateCssInteropRoot, '.cache'), { recursive: true });
    writeFileSync(
      join(alternateCssInteropRoot, 'package.json'),
      JSON.stringify({ name: 'react-native-css-interop', version: '2.0.0' }),
    );
    writeFileSync(join(alternateCssInteropRoot, 'index.js'), 'module.exports = {};\n');
    const alternateCacheWriteResult = join(runtimeRoot, 'alternate-cache-write.json');
    symlinkSync(nativeWindRoot, join(appRoot, 'node_modules', 'nativewind'), 'dir');
    symlinkSync(
      alternateCssInteropRoot,
      join(appRoot, 'node_modules', 'react-native-css-interop'),
      'dir',
    );
    symlinkSync(lightningCssRoot, join(appRoot, 'node_modules', 'lightningcss'), 'dir');
    const descendantEntry = join(appRoot, 'metro-descendant.cjs');
    writeFileSync(descendantEntry, 'process.exit(0);\n');
    const expoRoot = join(appRoot, 'node_modules', 'expo', 'bin');
    mkdirSync(expoRoot, { recursive: true });
    const expoEntry = join(expoRoot, 'cli');
    writeFileSync(
      expoEntry,
      `const { createServer } = require('node:net');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--version')) {
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
require('nativewind');
require('nativewind/metro');
let alternateCacheWrite = 'written';
try {
  require('node:fs').writeFileSync(${JSON.stringify(join(alternateCssInteropRoot, '.cache', 'ios.js'))}, 'generated');
} catch (error) {
  alternateCacheWrite = error.code;
}
require('node:fs').writeFileSync(${JSON.stringify(alternateCacheWriteResult)}, JSON.stringify(alternateCacheWrite));
const descendant = spawnSync(process.execPath, [${JSON.stringify(descendantEntry)}]);
if (descendant.status !== 0) process.exit(descendant.status || 1);
createServer(() => {}).listen(port, '127.0.0.1');
setInterval(() => {}, 1 << 30);
`,
    );
    const executable = join(binRoot, 'expo');
    writeFileSync(
      executable,
      `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
case \`uname\` in
  *CYGWIN*|*MINGW*|*MSYS*) basedir=\`cygpath -w "$basedir"\`;;
esac
exec node "$basedir/../expo/bin/cli" "$@"
`,
    );
    chmodSync(executable, 0o755);
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('test port unavailable'));
          return;
        }
        server.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    });
    const binding = await startManagedMetro(
      {
        appRoot,
        runtimeRoot,
        sourceRoot: appRoot,
        sessionId: 'integration-session',
        port,
        instanceId: 'integration-metro',
        buildGeneration: 1,
        signerCapability: 'integration-signer',
      },
      {
        capture: async (input) => {
          const birth = readProcessBirth(input.pid);
          assert.ok(birth);
          return {
            ...input,
            birth: birth.token,
            servingRoot: appRoot,
          };
        },
      },
    );

    try {
      t.diagnostic(JSON.stringify({ runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority }));
      try {
        t.diagnostic(
          readFileSync(
            join(runtimeRoot, 'metro-enforcement-diagnostic-integration-metro.json'),
            'utf8',
          ).slice(0, 3000),
        );
      } catch {
        t.diagnostic('no enforcement diagnostic recorded');
      }
      assert.equal(
        binding.runtimeEvidenceAuthority,
        'managed-sandbox-v1',
        readFileSync(join(runtimeRoot, 'metro.log'), 'utf8'),
      );
      assert.equal(
        verifyManagedMetroManagementProof(binding as unknown as Record<string, unknown>, {
          sessionId: 'integration-session',
          signerCapability: 'integration-signer',
        }),
        true,
      );
      const policy = JSON.parse(
        readFileSync(join(integrationRoot, 'metro-runtime-policy.json'), 'utf8'),
      ) as Record<string, unknown>;
      const runtimeManifest = policy.runtimeManifest as Record<string, unknown>;
      t.diagnostic(
        JSON.stringify({
          runtimeEnforcement: policy.runtimeEnforcement,
          receipt: policy.runtimeEnforcementReceipt,
        }),
      );
      assert.equal(policy.runtimeEnforcement, 'os-enforced-v1');
      assert.equal(runtimeManifest.cssInteropCacheRoot, join(cssInteropRoot, '.cache'));
      assert.equal(readFileSync(cssInteropCachePath, 'utf8'), 'generated');
      assert.equal(JSON.parse(readFileSync(alternateCacheWriteResult, 'utf8')), 'EPERM');
      const enforcementDiagnostic = JSON.parse(
        readFileSync(
          join(runtimeRoot, 'metro-enforcement-diagnostic-integration-metro.json'),
          'utf8',
        ),
      ) as Record<string, unknown>;
      t.diagnostic(JSON.stringify({ enforcementDiagnostic }));
      assert.equal(enforcementDiagnostic.metroInstanceId, 'integration-metro');
      assert.equal(enforcementDiagnostic.sessionId, 'integration-session');
      assert.deepEqual(enforcementDiagnostic.preparation, {
        status: 'enforced',
        profileSha256: (policy.runtimeEnforcementReceipt as Record<string, unknown>).profileSha256,
      });
      const preflight = enforcementDiagnostic.preflight as Record<string, unknown>;
      assert.equal(preflight.outcome, 'receipt');
      assert.equal(preflight.complete, true);
      const timings = preflight.timings as Record<string, number>;
      const phases = ['allocatedMs', 'spawnedMs', 'occupancyMs', 'cleanupMs', 'totalMs'];
      for (const phase of phases) assert.ok(Number.isFinite(timings[phase]), phase);
      const observedTimings = phases.map((phase) => timings[phase]);
      assert.deepEqual(
        observedTimings,
        [...observedTimings].sort((left, right) => left - right),
        'phase timings are monotonic',
      );
      assert.equal(enforcementDiagnostic.recordComplete, true);
      assert.ok(
        (runtimeManifest.commandChainInputs as string[]).includes(
          join(integrationRoot, 'rn-session-metro.cjs'),
        ),
      );
      assert.equal(
        (policy.runtimeEnforcementReceipt as Record<string, unknown>).networkOutboundDenied,
        true,
      );
      const verificationInput = {
        platform: process.platform,
        appRoot,
        sourceRoot: appRoot,
        runtimeRoot,
        nodeExecutable: runtimeManifest.nodeExecutable as string,
        nodeVersion: runtimeManifest.nodeVersion as string,
        commandExecutable: runtimeManifest.executable as string,
        commandArguments: runtimeManifest.args as string[],
        commandProbeArguments: runtimeManifest.commandProbeArguments as string[],
        commandExecutableMappings: runtimeManifest.commandExecutableMappings as string[],
        commandChainInputs: runtimeManifest.commandChainInputs as string[],
        protectedRuntimeRoots: runtimeManifest.protectedRuntimeRoots as string[],
        nativeAddonRoots: runtimeManifest.nativeAddonRoots as string[],
        cssInteropCacheRoot: runtimeManifest.cssInteropCacheRoot as string,
        port: runtimeManifest.port as number,
        instanceId: 'integration-metro',
        runtimeInputs: policy.runtimeInputs as string[],
      };
      const reconstructed = prepareManagedMetroEnforcement(verificationInput);
      assert.equal(reconstructed.status, 'enforced');
      if (reconstructed.status !== 'enforced') return;
      assert.deepEqual(
        reconstructed.nodeRuntimeAttestation,
        (policy.runtimeEnforcementReceipt as Record<string, unknown>).nodeRuntimeAttestation,
      );
      const observedReceipt = policy.runtimeEnforcementReceipt as Record<string, unknown>;
      assert.equal(observedReceipt.version, 2);
      assert.equal(observedReceipt.kind, reconstructed.kind);
      assert.equal(observedReceipt.profileSha256, reconstructed.profileSha256);
      assert.equal(observedReceipt.sandboxExecutableSha256, reconstructed.sandboxExecutableSha256);
      assert.equal(observedReceipt.sandboxExecutableCdHash, reconstructed.sandboxExecutableCdHash);
      assert.equal(observedReceipt.commandLaunchSha256, reconstructed.commandLaunchSha256);
      assert.equal(observedReceipt.resolvedCommandSha256, reconstructed.resolvedCommandSha256);
      for (const field of [
        'descendantCreationAllowed',
        'unauthorizedExecutableDenied',
        'unmanifestedReadDenied',
        'unmanifestedWriteDenied',
        'symlinkEscapeDenied',
        'unallocatedListenerDenied',
        'allocatedListenerAllowed',
        'networkOutboundDenied',
        'resolvedCommandAllowed',
        'commandCleanupConfirmed',
        'commandChainStable',
      ]) {
        assert.equal(observedReceipt[field], true, field);
      }
      assert.equal(
        verifyManagedMetroEnforcementReceipt(verificationInput, policy.runtimeEnforcementReceipt),
        true,
      );
      const evidence = readFileSync(join(runtimeRoot, 'metro-runtime-evidence.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const launches = new Set(
        evidence.filter((entry) => entry.kind === 'launch').map((entry) => entry.value),
      );
      const attestations = new Set(
        evidence.filter((entry) => entry.kind === 'attestation').map((entry) => entry.value),
      );
      assert.ok(
        evidence.some(
          (entry) =>
            entry.kind === 'input' &&
            entry.value === realpathSync(addonPath) &&
            entry.digest === createHash('sha256').update(readFileSync(addonPath)).digest('hex'),
        ),
      );
      assert.equal(launches.size, 1);
      assert.deepEqual(launches, attestations);
      const launch = JSON.parse([...launches][0]);
      assert.equal(launch.authority.sessionId, 'integration-session');
      assert.equal(launch.authority.metroInstanceId, 'integration-metro');
      assert.equal(
        launch.parent.nonce,
        (runtimeManifest.descendantAuthority as Record<string, unknown>).rootNonce,
      );
      assert.equal(
        launch.parent.identity,
        (runtimeManifest.descendantAuthority as Record<string, unknown>).rootIdentity,
      );
    } finally {
      await stopManagedMetro(
        binding,
        {
          sessionId: 'integration-session',
          signerCapability: 'integration-signer',
        },
        {
          removeEvidenceSocket: () => {},
        },
      );
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (
          probeProcessBirth(binding.launcherPid).status === 'absent' &&
          probeProcessBirth(binding.pid).status === 'absent'
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(probeProcessBirth(binding.launcherPid).status, 'absent');
      assert.equal(probeProcessBirth(binding.pid).status, 'absent');
      t.diagnostic('Managed Metro listener and launcher cleanup confirmed.');
    }
  },
);
