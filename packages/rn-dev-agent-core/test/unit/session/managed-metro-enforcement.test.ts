import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
