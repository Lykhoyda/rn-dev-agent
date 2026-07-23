import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionHandler } from '../../../dist/tools/session.js';

function cleanupRuntime(finish: () => void) {
  const status = {
    sessionId: 'target',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    state: 'handoff_cleanup',
    claimEpoch: 1,
    authorityVersion: 2,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings: {
      handoffCleanup: {
        runner: {
          platform: 'ios',
          deviceId: 'device',
          pid: 123,
          processBirth: 'birth',
        },
        observe: {
          port: 7333,
          instanceId: 'observe',
          cleanupCapability: 'capability',
        },
      },
    },
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const registry = {
    getSessionStatus: () => status,
    getHandoffOwner: () => null,
    finishHandoffCleanup: finish,
  };
  return {
    status: () => ({ available: true, ...status }),
    requireRecovery: () => ({
      registry,
      session: { sessionId: 'target', claimEpoch: 1 },
    }),
    requireOperational: () => {
      throw new Error('unexpected operational access');
    },
  };
}

test('handoff cleanup remains fenced when exact shutdown is not proven', async () => {
  let finished = false;
  const handler = createSessionHandler(cleanupRuntime(() => (finished = true)), {
    stopHandoffRunner: async () => {
      throw new Error('RUNNER_ADOPTION_REQUIRED: runner still alive');
    },
  });

  const result = await handler({
    action: 'accept_handoff',
    handoffId: 'handoff',
    token: 'token',
  });

  assert.equal(finished, false);
  assert.equal(result.isError, true);
});

test('handoff cleanup unblocks only after runner and Observe shutdown complete', async () => {
  const calls: string[] = [];
  const handler = createSessionHandler(cleanupRuntime(() => calls.push('finish')), {
    stopHandoffRunner: async () => {
      calls.push('runner');
    },
    stopHandoffObserve: async () => {
      calls.push('observe');
    },
  });

  const result = await handler({
    action: 'accept_handoff',
    handoffId: 'handoff',
    token: 'token',
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ['runner', 'observe', 'finish']);
});
