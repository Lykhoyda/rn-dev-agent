import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalAuthorityJson } from '../../../dist/session/authority-json.js';
import {
  inspectManagedMetroLifecycle,
  startManagedMetro,
} from '../../../dist/session/managed-metro.js';
import { probeProcessBirth, readProcessBirth } from '../../../dist/session/process-birth.js';
import { MAX_STRICT_PROOF_FILE_BYTES } from '../../../dist/session/strict-proof-limits.js';

const SESSION_ID = 'session-a';
const SIGNER = 'signer';
const INSTANCE_ID = 'metro-a';
const LAUNCHER_PID = 101;
const LISTENER_PID = 202;

function runtimePolicyCapability(signerCapability: string): string {
  return createHmac('sha256', signerCapability).update('metro-runtime-policy').digest('base64url');
}

function writeSignedEvidence(
  path: string,
  capability: string,
  entries: readonly { kind: string; value: string }[],
): void {
  let previousSignature: string | null = null;
  let sequence = 0;
  const lines = entries.map((entry) => {
    const payload = {
      version: 1,
      runtimeEvidenceAuthority: 'managed-sandbox-v1',
      sessionId: SESSION_ID,
      metroInstanceId: INSTANCE_ID,
      kind: entry.kind,
      value: entry.value,
      digest: null,
      sequence: ++sequence,
      previousSignature,
    };
    const signature = createHmac('sha256', capability)
      .update(canonicalAuthorityJson(payload))
      .digest('hex');
    previousSignature = signature;
    return canonicalAuthorityJson({ ...payload, signature });
  });
  writeFileSync(path, `${lines.join('\n')}\n`);
}

async function boundManagedMetro(runtimeRoot: string) {
  return startManagedMetro(
    {
      sessionId: SESSION_ID,
      appRoot: runtimeRoot,
      sourceRoot: runtimeRoot,
      runtimeRoot,
      port: 8341,
      instanceId: INSTANCE_ID,
      buildGeneration: 1,
      signerCapability: SIGNER,
    },
    {
      readText: () => JSON.stringify({ dependencies: { expo: '1' } }),
      exists: () => true,
      spawnProcess: () => ({
        pid: LAUNCHER_PID,
        exitCode: null,
        signalCode: null,
        kill: () => true,
        unref: () => {},
      }),
      listenerPid: () => LISTENER_PID,
      listenerOwnedByLauncher: () => true,
      readBirth: (pid: number) => ({ pid, source: 'linux-proc', token: `birth-${pid}` }),
      capture: async (input: Record<string, unknown>) => ({
        ...input,
        birth: `birth-${LISTENER_PID}`,
        servingRoot: runtimeRoot,
      }),
    } as never,
  );
}

const liveBirth = (pid: number) => ({
  status: 'present' as const,
  birth: { pid, source: 'linux-proc' as const, token: `birth-${pid}` },
});

async function availablePort(): Promise<number> {
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

test('a managed Metro launcher that exits before bundle bind names its cause in the receipt', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'rn-managed-metro-launcher-exit-'));
  const binding = await boundManagedMetro(runtimeRoot);
  const policyCapability = runtimePolicyCapability(SIGNER);

  writeSignedEvidence(join(runtimeRoot, 'metro-runtime-evidence.jsonl'), policyCapability, [
    { kind: 'semantics', value: canonicalAuthorityJson({ mode: 'metro' }) },
    {
      kind: 'violation',
      value: canonicalAuthorityJson({
        code: 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION',
        stage: 'native-spawn',
        nodeVersion: '26.7.0',
        convention: 'unverified',
        arity: 8,
      }),
    },
  ]);
  writeFileSync(
    join(runtimeRoot, 'metro.log'),
    `${'x'.repeat(5_000)}\n${SESSION_ID}\n${INSTANCE_ID}\n${SIGNER}\n${policyCapability}\n` +
      `Error: RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION\nNode.js v26.7.0\nMETRO_LOG_TAIL_END\n`,
  );
  writeFileSync(
    join(runtimeRoot, 'metro-launcher-diagnostic.json'),
    JSON.stringify({
      version: 1,
      code: 'METRO_LAUNCHER_CHILD_EXITED',
      stage: 'metro-child',
      detail: 'metro-process-exited',
    }),
  );

  const inspection = inspectManagedMetroLifecycle(
    binding as unknown as Record<string, unknown>,
    { sessionId: SESSION_ID, signerCapability: SIGNER },
    {
      exists: () => true,
      probeBirth: (pid: number) => (pid === LAUNCHER_PID ? { status: 'absent' } : liveBirth(pid)),
      probeListener: () => ({ status: 'listening', pid: LISTENER_PID }),
    } as never,
  );

  assert.equal(inspection.status, 'lost');
  assert.equal(inspection.code, 'METRO_LAUNCHER_EXITED');
  assert.equal(inspection.reason, 'authenticated managed Metro launcher exited');
  assert.ok(
    inspection.attribution,
    'a launcher exit must attribute its cause instead of reporting a bare exit',
  );
  assert.match(inspection.attribution, /RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION/);
  assert.match(inspection.attribution, /Metro log causes: /);
  assert.doesNotMatch(
    inspection.attribution,
    /METRO_LOG_TAIL_END/,
    'attribution must never republish free text from metro.log',
  );
  assert.ok(
    inspection.attribution.indexOf('stage metro-child') <
      inspection.attribution.indexOf('metro-process-exited'),
  );
  assert.ok(
    inspection.attribution.indexOf('metro-process-exited') <
      inspection.attribution.indexOf('runtime violation:'),
  );
  assert.ok(
    inspection.attribution.indexOf('runtime violation:') <
      inspection.attribution.indexOf('Metro log causes:'),
  );
  assert.match(inspection.attribution, /Metro log causes: [^;]*Node\.js v26\.7\.0/);
  assert.doesNotMatch(inspection.attribution, new RegExp(SIGNER));
  assert.doesNotMatch(inspection.attribution, new RegExp(SESSION_ID));
  assert.doesNotMatch(inspection.attribution, new RegExp(INSTANCE_ID));
  assert.doesNotMatch(inspection.attribution, new RegExp(policyCapability));
  assert.ok(inspection.attribution.length <= 4_096);
});

test('a signed violation survives a valid evidence journal larger than two MiB', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'rn-managed-metro-large-evidence-'));
  const binding = await boundManagedMetro(runtimeRoot);
  const policyCapability = runtimePolicyCapability(SIGNER);
  const evidencePath = join(runtimeRoot, 'metro-runtime-evidence.jsonl');
  const observations = Array.from({ length: 5_000 }, (_, index) => ({
    kind: 'observation',
    value: canonicalAuthorityJson({ index, padding: 'x'.repeat(256) }),
  }));

  writeSignedEvidence(evidencePath, policyCapability, [
    ...observations,
    {
      kind: 'violation',
      value: canonicalAuthorityJson({
        code: 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION',
        stage: 'native-spawn',
      }),
    },
  ]);

  const evidenceBytes = statSync(evidencePath).size;
  assert.ok(evidenceBytes > 2 * 1024 * 1024);
  assert.ok(evidenceBytes <= MAX_STRICT_PROOF_FILE_BYTES);

  const inspection = inspectManagedMetroLifecycle(
    binding as unknown as Record<string, unknown>,
    { sessionId: SESSION_ID, signerCapability: SIGNER },
    {
      exists: () => true,
      probeBirth: (pid: number) => (pid === LAUNCHER_PID ? { status: 'absent' } : liveBirth(pid)),
      probeListener: () => ({ status: 'listening', pid: LISTENER_PID }),
    } as never,
  );

  assert.equal(inspection.status, 'lost');
  assert.equal(inspection.code, 'METRO_LAUNCHER_EXITED');
  assert.match(inspection.attribution ?? '', /RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION/);
});

test('a launcher exit with no recorded evidence still reports a truthful bare refusal', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'rn-managed-metro-launcher-silent-'));
  const binding = await boundManagedMetro(runtimeRoot);

  const inspection = inspectManagedMetroLifecycle(
    binding as unknown as Record<string, unknown>,
    { sessionId: SESSION_ID, signerCapability: SIGNER },
    {
      exists: () => true,
      probeBirth: (pid: number) => (pid === LAUNCHER_PID ? { status: 'absent' } : liveBirth(pid)),
      probeListener: () => ({ status: 'listening', pid: LISTENER_PID }),
    } as never,
  );

  assert.deepEqual(inspection, {
    status: 'lost',
    code: 'METRO_LAUNCHER_EXITED',
    reason: 'authenticated managed Metro launcher exited',
  });
});

test('a silent Metro generation does not inherit an earlier generation log cause', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'rn-managed-metro-generation-log-'));
  await boundManagedMetro(runtimeRoot);
  writeFileSync(join(runtimeRoot, 'metro.log'), 'Error: listen EADDRINUSE\n');

  const binding = await boundManagedMetro(runtimeRoot);
  const inspection = inspectManagedMetroLifecycle(
    binding as unknown as Record<string, unknown>,
    { sessionId: SESSION_ID, signerCapability: SIGNER },
    {
      exists: () => true,
      probeBirth: (pid: number) => (pid === LAUNCHER_PID ? { status: 'absent' } : liveBirth(pid)),
      probeListener: () => ({ status: 'listening', pid: LISTENER_PID }),
    } as never,
  );

  assert.deepEqual(inspection, {
    status: 'lost',
    code: 'METRO_LAUNCHER_EXITED',
    reason: 'authenticated managed Metro launcher exited',
  });
});

test('an unsigned runtime violation is never attributed to a launcher exit', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'rn-managed-metro-launcher-forged-'));
  const binding = await boundManagedMetro(runtimeRoot);

  writeSignedEvidence(
    join(runtimeRoot, 'metro-runtime-evidence.jsonl'),
    runtimePolicyCapability('not-the-session-signer'),
    [{ kind: 'violation', value: 'FORGED_VIOLATION' }],
  );

  const inspection = inspectManagedMetroLifecycle(
    binding as unknown as Record<string, unknown>,
    { sessionId: SESSION_ID, signerCapability: SIGNER },
    {
      exists: () => true,
      probeBirth: (pid: number) => (pid === LAUNCHER_PID ? { status: 'absent' } : liveBirth(pid)),
      probeListener: () => ({ status: 'listening', pid: LISTENER_PID }),
    } as never,
  );

  assert.equal(inspection.code, 'METRO_LAUNCHER_EXITED');
  assert.ok(!String(inspection.attribution ?? '').includes('FORGED_VIOLATION'));
});

test('a signed managed transform stall retains its concrete exit attribution', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'rn-managed-metro-transform-stall-'));
  const binding = await boundManagedMetro(runtimeRoot);

  writeSignedEvidence(
    join(runtimeRoot, 'metro-runtime-evidence.jsonl'),
    runtimePolicyCapability(SIGNER),
    [
      {
        kind: 'violation',
        value: canonicalAuthorityJson({
          cleanup: 'signal-accepted',
          code: 'MANAGED_TRANSFORM_CHANNEL_STALLED',
          pid: 4242,
          reason: 'timeout',
          recipient: 'b'.repeat(32),
        }),
      },
    ],
  );

  const inspection = inspectManagedMetroLifecycle(
    binding as unknown as Record<string, unknown>,
    { sessionId: SESSION_ID, signerCapability: SIGNER },
    {
      exists: () => true,
      probeBirth: () => ({ status: 'absent' }),
      probeListener: () => ({ status: 'absent' }),
    },
  );

  assert.equal(inspection.status, 'lost');
  assert.match(String(inspection.attribution ?? ''), /MANAGED_TRANSFORM_CHANNEL_STALLED/);
  assert.match(String(inspection.attribution ?? ''), /signal-accepted/);
});

test(
  'child violations preserve fixed schemas without publishing attacker-controlled details',
  { skip: process.platform === 'win32', timeout: 15_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'rn-managed-metro-child-violation-'));
    const runtimeRoot = join(root, 'runtime');
    const integrationRoot = join(root, '.rn-agent', 'integration');
    const binRoot = join(root, 'node_modules', '.bin');
    const listenerPidPath = join(runtimeRoot, 'listener.pid');
    const syntheticValue = 'obviously-synthetic-private-value-for-fd9-test';
    const syntheticBasename = `obviously-synthetic-sensitive-basename-${process.pid}.node`;
    const outsideAddonPath = join(root, '..', syntheticBasename);
    const outsideAddonBytes = Buffer.from('obviously synthetic native addon bytes');
    const genuineViolation = canonicalAuthorityJson({
      code: 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION',
      stage: 'native-spawn',
      nodeVersion: process.versions.node,
      convention: 'positional',
      arity: 8,
    });
    const stalledViolation = canonicalAuthorityJson({
      cleanup: 'signal-accepted',
      code: 'MANAGED_TRANSFORM_CHANNEL_STALLED',
      pid: 4242,
      reason: 'timeout',
      recipient: 'b'.repeat(32),
    });
    const nativeAddonRequest = canonicalAuthorityJson({
      requestId: 'c'.repeat(32),
      path: outsideAddonPath,
      digest: createHash('sha256').update(outsideAddonBytes).digest('hex'),
    });
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(integrationRoot, { recursive: true });
    mkdirSync(binRoot, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '1' } }));
    writeFileSync(join(integrationRoot, 'rn-session-metro.cjs'), '');
    writeFileSync(outsideAddonPath, outsideAddonBytes);
    const executable = join(binRoot, 'expo');
    writeFileSync(
      executable,
      `#!/usr/bin/env node
const { writeFileSync, writeSync } = require('node:fs');
const { createServer } = require('node:net');
if (process.argv.includes('--version')) process.exit(0);
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
for (const [kind, value] of [
  ['violation', ${JSON.stringify(syntheticValue)}],
  ['violation', ${JSON.stringify(genuineViolation)}],
  ['violation', ${JSON.stringify(stalledViolation)}],
  ['native-addon-request', ${JSON.stringify(nativeAddonRequest)}],
]) {
  writeSync(9, JSON.stringify({
    version: 1,
    runtimeEvidenceAuthority: 'reported-v1',
    sessionId: process.env.RN_DEV_AGENT_SESSION_ID,
    metroInstanceId: process.env.RN_DEV_AGENT_METRO_INSTANCE_ID,
    kind,
    value,
    digest: null,
  }) + '\\n');
}
writeFileSync(${JSON.stringify(listenerPidPath)}, String(process.pid));
createServer(() => {}).listen(port, '127.0.0.1');
setInterval(() => {}, 1 << 30);
`,
    );
    chmodSync(executable, 0o755);
    const port = await availablePort();
    let binding: Awaited<ReturnType<typeof startManagedMetro>> | undefined;
    try {
      binding = await startManagedMetro(
        {
          sessionId: SESSION_ID,
          appRoot: root,
          sourceRoot: root,
          runtimeRoot,
          port,
          instanceId: INSTANCE_ID,
          buildGeneration: 1,
          signerCapability: SIGNER,
        },
        {
          prepareEnforcement: () => ({
            status: 'unsupported',
            reason: 'host-enforcement-unavailable',
          }),
          listenerPid: () => {
            try {
              return Number(readFileSync(listenerPidPath, 'utf8')) || null;
            } catch {
              return null;
            }
          },
          listenerOwnedByLauncher: () => true,
          capture: async (input) => ({
            ...input,
            birth: readProcessBirth(input.pid)?.token ?? 'listener-birth-unavailable',
            servingRoot: root,
          }),
        },
      );
      process.kill(binding.pid, 'SIGTERM');
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && probeProcessBirth(binding.launcherPid).status !== 'absent') {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(probeProcessBirth(binding.launcherPid).status, 'absent');

      const inspection = inspectManagedMetroLifecycle(
        binding as unknown as Record<string, unknown>,
        { sessionId: SESSION_ID, signerCapability: SIGNER },
        {
          exists: () => true,
          probeBirth: () => ({ status: 'absent' }),
          probeListener: () => ({ status: 'absent' }),
        },
      );
      assert.equal(inspection.status, 'lost');
      assert.doesNotMatch(String(inspection.attribution ?? ''), new RegExp(syntheticValue));
      assert.match(String(inspection.attribution ?? ''), /RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON/);
      assert.doesNotMatch(String(inspection.attribution ?? ''), new RegExp(syntheticBasename));
      const evidence = readFileSync(join(runtimeRoot, 'metro-runtime-evidence.jsonl'), 'utf8');
      assert.doesNotMatch(evidence, new RegExp(syntheticValue));
      assert.doesNotMatch(evidence, new RegExp(syntheticBasename));
      assert.match(evidence, /RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON/);
      assert.match(evidence, /MANAGED_TRANSFORM_CHANNEL_STALLED/);
    } finally {
      if (binding && probeProcessBirth(binding.launcherPid).status !== 'absent') {
        process.kill(-binding.launcherPid, 'SIGKILL');
      }
      rmSync(outsideAddonPath, { force: true });
    }
  },
);

test('a bare credential value printed into metro.log never reaches exit attribution', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'rn-managed-metro-launcher-credential-'));
  const binding = await boundManagedMetro(runtimeRoot);
  const policyCapability = runtimePolicyCapability(SIGNER);
  const bareCredential = 'synthetic-credential-for-redaction-test-only';

  writeSignedEvidence(join(runtimeRoot, 'metro-runtime-evidence.jsonl'), policyCapability, [
    {
      kind: 'violation',
      value: canonicalAuthorityJson({ code: 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION' }),
    },
  ]);
  // The operator's credential reaches metro.log without its key name — exactly the case the
  // sibling startup path covers with credentialRedactions, which exit attribution cannot see.
  writeFileSync(
    join(runtimeRoot, 'metro.log'),
    `env dump\n${bareCredential}\nAUTH_TOKEN=${bareCredential}\nhttps://user:${bareCredential}@example.test/x\nDone\n`,
  );

  const inspection = inspectManagedMetroLifecycle(
    binding as unknown as Record<string, unknown>,
    { sessionId: SESSION_ID, signerCapability: SIGNER },
    {
      exists: () => true,
      probeBirth: (pid: number) => (pid === LAUNCHER_PID ? { status: 'absent' } : liveBirth(pid)),
      probeListener: () => ({ status: 'listening', pid: LISTENER_PID }),
    } as never,
  );

  assert.equal(inspection.code, 'METRO_LAUNCHER_EXITED');
  assert.ok(inspection.attribution, 'the signed violation must still attribute the exit');
  assert.doesNotMatch(
    inspection.attribution,
    new RegExp(bareCredential),
    'exit attribution must not copy credential values out of metro.log',
  );
  assert.doesNotMatch(inspection.attribution, /env dump|Done/);
  assert.match(inspection.attribution, /RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION/);
});
