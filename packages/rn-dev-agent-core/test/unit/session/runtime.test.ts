import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import {
  createWorkerAuthorityRuntime,
  workerAuthorityFailureEnvironment,
} from '../../../dist/session/runtime.js';
import { SessionAuthorityError } from '../../../dist/session/registry.js';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test('worker runtime binds a fresh worker identity to the supervisor session', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-authority-runtime-'));
  roots.push(root);
  const registryPath = join(root, 'registry.sqlite3');
  const registry = openSessionRegistry(registryPath, { ownerStatus: () => 'match' });
  const session = registry.createSession({
    sessionId: 'session-a',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    supervisor: { pid: 101, token: 'supervisor-birth' },
  });
  registry.close();

  const runtime = createWorkerAuthorityRuntime(
    {
      RN_DEV_AGENT_SESSION_ID: session.sessionId,
      RN_DEV_AGENT_CLAIM_EPOCH: String(session.claimEpoch),
      RN_DEV_AGENT_REGISTRY_PATH: registryPath,
      RN_DEV_AGENT_WORKER_INSTANCE: 'worker-a',
    },
    {
      readBirth: () => ({ pid: process.pid, source: 'darwin-ps', token: 'worker-birth' }),
      ownerStatus: () => 'match',
    },
  );

  try {
    assert.equal(runtime.available, true);
    assert.equal(runtime.status().sessionId, 'session-a');
    assert.equal(runtime.status().worker.instanceId, 'worker-a');
  } finally {
    runtime.close();
  }
});

test('worker runtime keeps diagnostics available but refuses authority when setup failed', () => {
  const runtime = createWorkerAuthorityRuntime({
    RN_DEV_AGENT_AUTHORITY_ERROR: 'AUTHORITY_STORE_UNAVAILABLE: fixture',
  });

  assert.equal(runtime.available, false);
  assert.deepEqual(runtime.status(), {
    available: false,
    code: 'AUTHORITY_STORE_UNAVAILABLE',
    reason: 'AUTHORITY_STORE_UNAVAILABLE: fixture',
  });
  assert.throws(() => runtime.requireAvailable(), /AUTHORITY_STORE_UNAVAILABLE/);
});

test('worker runtime preserves unavailable process-birth attestation details', () => {
  const runtime = createWorkerAuthorityRuntime(
    {
      RN_DEV_AGENT_SESSION_ID: 'session-a',
      RN_DEV_AGENT_CLAIM_EPOCH: '1',
      RN_DEV_AGENT_REGISTRY_PATH: '/not-opened.sqlite3',
      RN_DEV_AGENT_WORKER_INSTANCE: 'worker-a',
    },
    {
      probeBirth: (pid) => ({
        status: 'unknown',
        cause: { pid, step: 'helper', failure: 'timeout', elapsedMs: 2000 },
      }),
    },
  );

  assert.equal(runtime.available, false);
  assert.deepEqual(runtime.status(), {
    available: false,
    code: 'PROCESS_BIRTH_UNAVAILABLE',
    reason: 'PROCESS_BIRTH_UNAVAILABLE: worker process identity could not be read on a loaded host',
    details: {
      attestation: 'unavailable',
      pid: process.pid,
      step: 'helper',
      failure: 'timeout',
      elapsedMs: 2000,
      nextAction:
        'Process identity could not be read in time on a loaded host. Reduce host process contention, then retry the original operation; do not reopen or rebind the device.',
    },
  });
  assert.throws(
    () => runtime.requireAvailable(),
    (error: { code?: string; details?: Record<string, unknown> }) =>
      error.code === 'PROCESS_BIRTH_UNAVAILABLE' && error.details?.attestation === 'unavailable',
  );
});

test('supervisor authority failure handoff preserves safe process-birth details', () => {
  const error = new SessionAuthorityError(
    'PROCESS_BIRTH_UNAVAILABLE',
    'supervisor process identity could not be read on a loaded host',
    undefined,
    {
      attestation: 'unavailable',
      pid: 4242,
      step: 'helper',
      failure: 'timeout',
      elapsedMs: 2000,
      nextAction:
        'Process identity could not be read in time on a loaded host. Reduce host process contention, then retry the original operation; do not reopen or rebind the device.',
    },
  );
  const runtime = createWorkerAuthorityRuntime(
    workerAuthorityFailureEnvironment(error.message, error.details),
  );

  assert.deepEqual(runtime.status(), {
    available: false,
    code: 'PROCESS_BIRTH_UNAVAILABLE',
    reason:
      'PROCESS_BIRTH_UNAVAILABLE: supervisor process identity could not be read on a loaded host',
    details: error.details,
  });
});

test('blocked worker runtime exposes only capability-bound recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-authority-runtime-'));
  roots.push(root);
  const registryPath = join(root, 'registry.sqlite3');
  const secretPath = join(root, 'secret.json');
  const recoveryCapability = 'recovery-capability';
  const registry = openSessionRegistry(registryPath, { ownerStatus: () => 'match' });
  const session = registry.createSession({
    sessionId: 'session-blocked',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    supervisor: { pid: 101, token: 'supervisor-birth' },
  });
  registry.updateBindings(session, {
    state: 'blocked',
    bindings: {
      recoveryCapabilityHash: createHash('sha256').update(recoveryCapability).digest('hex'),
    },
  });
  registry.close();
  writeFileSync(secretPath, JSON.stringify({ recoveryCapability }), { mode: 0o600 });

  const runtime = createWorkerAuthorityRuntime(
    {
      RN_DEV_AGENT_SESSION_ID: session.sessionId,
      RN_DEV_AGENT_CLAIM_EPOCH: String(session.claimEpoch),
      RN_DEV_AGENT_REGISTRY_PATH: registryPath,
      RN_DEV_AGENT_WORKER_INSTANCE: 'recovery-worker',
      RN_DEV_AGENT_SESSION_SECRET_PATH: secretPath,
    },
    {
      readBirth: () => ({ pid: process.pid, source: 'linux-proc', token: 'worker-birth' }),
      ownerStatus: () => 'match',
    },
  );

  try {
    assert.equal(runtime.status().state, 'blocked');
    // The refusal names the reachable diagnostic and carries the measured remedy.
    assert.throws(
      () => runtime.requireOperational(),
      /rn_session\(\{ action: "status" \}\) is the only available action/,
    );
    assert.throws(
      () => runtime.requireOperational(),
      (error: Error) => !/accept_handoff|adopt_stale/.test(error.message),
    );
    assert.equal(
      runtime.blockedContenderError().details?.nextAction,
      runtime.inspectRecoveryRequirement()?.nextAction,
    );
    assert.doesNotThrow(() => runtime.requireRecovery());
  } finally {
    runtime.close();
  }
});
