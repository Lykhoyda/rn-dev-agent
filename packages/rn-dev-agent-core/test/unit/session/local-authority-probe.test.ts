import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalAuthorityProbe } from '../../../dist/session/local-authority-probe.js';
import { readProcessBirth } from '../../../dist/session/process-birth.js';
import { SessionAuthorityError } from '../../../dist/session/registry.js';

function statusWith(bindings) {
  return {
    sessionId: 'session-a',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    state: 'ready',
    claimEpoch: 4,
    authorityVersion: 9,
    leaseUntilMs: 1000,
    source: {},
    bindings,
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
}

function dependencies(overrides = {}) {
  return {
    runtime: {
      requireAvailable: () => {
        throw new Error('not used');
      },
    },
    getClient: () => ({ isConnected: false, connectedTarget: null }),
    getSecret: () => null,
    ...overrides,
  };
}

test('runner authority rejects a dead or PID-reused bound process before health probing', async () => {
  let healthProbed = false;
  const probe = createLocalAuthorityProbe(
    dependencies({
      inspectOwner: () => 'mismatch',
      fetchJson: async () => {
        healthProbed = true;
        return {};
      },
    }),
  );
  const status = statusWith({
    runner: {
      port: 9100,
      pid: 123,
      processBirth: 'runner-birth',
      capability: 'runner-capability',
    },
  });

  await assert.rejects(
    () => probe({ axis: 'R', status }),
    (error) => error instanceof SessionAuthorityError && error.code === 'RUNNER_OWNERSHIP_MISMATCH',
  );
  assert.equal(healthProbed, false);
});

test('bundle probe normalizes CDP transport failure to optional bundle unavailability', async () => {
  const probe = createLocalAuthorityProbe(
    dependencies({
      getClient: () => ({
        isConnected: true,
        connectedTarget: { id: 'target-a' },
        connectionGeneration: 1,
        evaluate: async () => {
          throw new Error('WebSocket closed');
        },
      }),
    }),
  );
  const status = statusWith({
    bundle: {
      targetId: 'target-a',
      connectionGeneration: 1,
    },
  });

  await assert.rejects(
    () => probe({ axis: 'B', status }),
    (error) => error instanceof SessionAuthorityError && error.code === 'BUNDLE_HANDSHAKE_UNAVAILABLE',
  );
});

test('controller probe uses the handoff-only lookup solely for cancellation', async () => {
  const processBirth = readProcessBirth(process.pid);
  assert.ok(processBirth);
  const calls = [];
  const controller = {
    sessionId: 'session-a',
    claimEpoch: 4,
    authorityVersion: 9,
    supervisor: { pid: process.pid, token: processBirth.token },
    worker: { instanceId: 'worker', pid: process.pid, token: processBirth.token },
  };
  const registry = {
    getControllerBinding: () => {
      calls.push('operational');
      throw new SessionAuthorityError('SESSION_OWNER_LOST', 'handoff is not operational');
    },
    getHandoffCancellationControllerBinding: () => {
      calls.push('handoff-cancellation');
      return controller;
    },
  };
  const probe = createLocalAuthorityProbe(
    dependencies({
      runtime: {
        requireAvailable: () => ({
          registry,
          session: { sessionId: 'session-a', claimEpoch: 4 },
        }),
      },
      inspectOwner: () => 'match',
    }),
  );
  const status = statusWith({});
  status.state = 'handoff';

  await probe({
    axis: 'C',
    status,
    tool: 'rn_session',
    args: { action: 'cancel_handoff' },
  });
  await assert.rejects(
    () => probe({ axis: 'C', status, tool: 'rn_session', args: { action: 'bind_metro' } }),
    (error) => error instanceof SessionAuthorityError && error.code === 'SESSION_OWNER_LOST',
  );
  assert.deepEqual(calls, ['handoff-cancellation', 'operational']);
});
