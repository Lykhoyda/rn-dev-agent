import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalAuthorityProbe } from '../../../dist/session/local-authority-probe.js';
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
