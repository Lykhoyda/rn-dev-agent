import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
    commandExecutable: '/repo/apps/mobile/node_modules/.bin/expo',
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

test('managed Metro derives a deterministic closed-world Darwin profile', () => {
  const first = prepareManagedMetroEnforcement(fixtureInput(), verifiedPlatformBinary);
  const second = prepareManagedMetroEnforcement(fixtureInput(), verifiedPlatformBinary);

  assert.equal(first.status, 'enforced');
  assert.deepEqual(second, first);
  if (first.status !== 'enforced') return;
  assert.equal(first.kind, 'darwin-seatbelt-v1');
  assert.equal(first.sandboxExecutable, '/usr/bin/sandbox-exec');
  assert.match(first.profileSha256, /^[a-f0-9]{64}$/);
  assert.match(first.sandboxExecutableSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.sandboxExecutableCdHash, '0123456789abcdef0123456789abcdef01234567');
  assert.match(first.profile, /\(deny default\)/);
  assert.match(first.profile, /\(local tcp "\*:8341"\)/);
  assert.match(first.profile, /\(subpath "\/repo"\)/);
  assert.match(first.profile, /\(subpath "\/runtime\/session"\)/);
  assert.match(first.profile, /\(subpath "\/repo\/apps\/mobile\/\.expo"\)/);
  assert.match(first.profile, /\(deny process-fork\)/);
  assert.match(first.profile, /\(deny network-outbound\)/);
  assert.match(first.profile, /\(deny file-map-executable/);
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
    writeFileSync(commandExecutable, 'process.exit(0);');
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
      commandExecutable,
      port,
      instanceId: 'integration',
      runtimeInputs: [commandExecutable],
    });

    assert.equal(plan.status, 'enforced');
    if (plan.status !== 'enforced') return;
    const receipt = runManagedMetroEnforcementPreflight(plan);

    assert.deepEqual(receipt, {
      version: 1,
      kind: 'darwin-seatbelt-v1',
      profileSha256: plan.profileSha256,
      sandboxExecutableSha256: plan.sandboxExecutableSha256,
      sandboxExecutableCdHash: plan.sandboxExecutableCdHash,
      processCreationDenied: true,
      unmanifestedReadDenied: true,
      unmanifestedWriteDenied: true,
      symlinkEscapeDenied: true,
      unallocatedListenerDenied: true,
      allocatedListenerAllowed: true,
      networkOutboundDenied: true,
    });
    assert.equal(dirname(plan.canaryPath), '/private/tmp');
  },
);

test(
  'managed Metro earns broker-v2 only after an actual attested sandbox launch',
  { skip: process.platform !== 'darwin', timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'rn-metro-broker-v2-'));
    roots.push(root);
    const appRoot = realpathSync(root);
    const runtimeRoot = join(appRoot, 'runtime');
    const integrationRoot = join(appRoot, '.rn-agent', 'integration');
    const binRoot = join(appRoot, 'node_modules', '.bin');
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(integrationRoot, { recursive: true });
    mkdirSync(binRoot, { recursive: true });
    writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ dependencies: { expo: '1' } }));
    writeFileSync(join(integrationRoot, 'rn-session-metro.cjs'), '');
    const executable = join(binRoot, 'expo');
    writeFileSync(
      executable,
      `#!/usr/bin/env node
const { createServer } = require('node:net');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
createServer(() => {}).listen(port, '127.0.0.1');
setInterval(() => {}, 1 << 30);
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
      assert.equal(binding.runtimeEvidenceAuthority, 'broker-v2');
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
      assert.equal(
        (policy.runtimeEnforcementReceipt as Record<string, unknown>).networkOutboundDenied,
        true,
      );
      assert.equal(
        verifyManagedMetroEnforcementReceipt(
          {
            platform: process.platform,
            appRoot,
            sourceRoot: appRoot,
            runtimeRoot,
            nodeExecutable: runtimeManifest.nodeExecutable as string,
            commandExecutable: runtimeManifest.executable as string,
            port: runtimeManifest.port as number,
            instanceId: 'integration-metro',
            runtimeInputs: policy.runtimeInputs as string[],
          },
          policy.runtimeEnforcementReceipt,
        ),
        true,
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
