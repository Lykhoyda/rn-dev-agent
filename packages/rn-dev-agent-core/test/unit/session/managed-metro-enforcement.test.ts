import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

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
  assert.match(first.profile, /\(deny file-map-executable/);
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
  async () => {
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

    assert.equal(plan.status, 'enforced');
    if (plan.status !== 'enforced') return;
    const receipt = runManagedMetroEnforcementPreflight(plan);

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
  'managed Metro earns managed-sandbox-v1 only after an attested sandbox launch',
  { skip: process.platform !== 'darwin', timeout: 30_000 },
  async () => {
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
      assert.equal(binding.runtimeEvidenceAuthority, 'managed-sandbox-v1');
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
      assert.equal(policy.runtimeEnforcement, 'os-enforced-v1');
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
    }
  },
);
