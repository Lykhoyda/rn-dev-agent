import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalAuthorityJson } from '../../../dist/session/authority-json.js';
import {
  inspectManagedMetroLifecycle,
  startManagedMetro,
} from '../../../dist/session/managed-metro.js';

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
