import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionHandler } from '../../../dist/tools/session.js';

function cleanupRuntime(finish: () => void, includeObserve = true, includeRunner = true) {
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
        runner: includeRunner
          ? {
              platform: 'ios',
              deviceId: 'device',
              pid: 123,
              processBirth: 'birth',
              instanceId: 'runner',
              capability: 'runner-capability',
              claimKey: 'ios:device:9100',
              port: 9100,
              stopRequestedAt: null,
              completedAt: null,
            }
          : null,
        observe: includeObserve
          ? {
              port: 7333,
              pid: 456,
              processBirth: 'observe-birth',
              instanceId: 'observe',
              cleanupCapability: 'capability',
              stopRequestedAt: null,
              completedAt: null,
            }
          : null,
      },
    },
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const registry = {
    getSessionStatus: () => status,
    getHandoffOwner: () => null,
    beginHandoffCleanupResource: (_session, _worker, resource) => {
      const binding = status.bindings.handoffCleanup[resource];
      if (!binding) return null;
      binding.stopRequestedAt ??= Date.now();
      return binding;
    },
    completeHandoffCleanupResource: (_session, _worker, resource) => {
      const binding = status.bindings.handoffCleanup[resource];
      if (binding) binding.completedAt = Date.now();
    },
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
  const handler = createSessionHandler(
    cleanupRuntime(() => (finished = true)),
    {
      stopHandoffRunner: async () => {
        throw new Error('RUNNER_ADOPTION_REQUIRED: runner still alive');
      },
    },
  );

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
  const handler = createSessionHandler(
    cleanupRuntime(() => calls.push('finish')),
    {
      stopHandoffRunner: async () => {
        calls.push('runner');
      },
      stopHandoffObserve: async () => {
        calls.push('observe');
      },
    },
  );

  const result = await handler({
    action: 'accept_handoff',
    handoffId: 'handoff',
    token: 'token',
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ['runner', 'observe', 'finish']);
});

test('handoff cleanup signals only the persisted exact runner PID', async () => {
  let alive = true;
  const signals: Array<[number, NodeJS.Signals]> = [];
  const handler = createSessionHandler(
    cleanupRuntime(() => {}, false),
    {
      probeProcessBirth: () =>
        alive
          ? {
              status: 'present',
              birth: { pid: 123, source: 'linux-proc', token: 'birth' },
            }
          : { status: 'absent' },
      signalProcess: (pid, signal) => {
        signals.push([pid, signal]);
        alive = false;
      },
    },
  );

  const result = await handler({
    action: 'accept_handoff',
    handoffId: 'handoff',
    token: 'token',
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(signals, [[123, 'SIGTERM']]);
});

test('handoff cleanup never signals a reused runner PID', async () => {
  const signals: Array<[number, NodeJS.Signals]> = [];
  const handler = createSessionHandler(
    cleanupRuntime(() => {}, false),
    {
      probeProcessBirth: () => ({
        status: 'present',
        birth: { pid: 123, source: 'linux-proc', token: 'replacement-birth' },
      }),
      signalProcess: (pid, signal) => signals.push([pid, signal]),
    },
  );

  const result = await handler({
    action: 'accept_handoff',
    handoffId: 'handoff',
    token: 'token',
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(signals, []);
});

test('handoff cleanup remains fenced when runner absence is ambiguous', async () => {
  let finished = false;
  const handler = createSessionHandler(
    cleanupRuntime(() => (finished = true), false),
    {
      probeProcessBirth: () => ({ status: 'unknown' }),
    },
  );

  const result = await handler({
    action: 'accept_handoff',
    handoffId: 'handoff',
    token: 'token',
  });

  assert.equal(result.isError, true);
  assert.equal(finished, false);
});

test('handoff cleanup accepts confirmed runner absence', async () => {
  let finished = false;
  const handler = createSessionHandler(
    cleanupRuntime(() => (finished = true), false),
    {
      probeProcessBirth: () => ({ status: 'absent' }),
    },
  );

  const result = await handler({
    action: 'accept_handoff',
    handoffId: 'handoff',
    token: 'token',
  });

  assert.equal(result.isError, undefined);
  assert.equal(finished, true);
});

test('handoff cleanup remains fenced when listener absence is ambiguous', async () => {
  let finished = false;
  const handler = createSessionHandler(
    cleanupRuntime(() => (finished = true), true, false),
    {
      probeListener: () => ({ status: 'unknown' }),
    },
  );

  const result = await handler({
    action: 'accept_handoff',
    handoffId: 'handoff',
    token: 'token',
  });

  assert.equal(result.isError, true);
  assert.equal(finished, false);
});

test('handoff cleanup accepts confirmed listener absence', async () => {
  let finished = false;
  const handler = createSessionHandler(
    cleanupRuntime(() => (finished = true), true, false),
    {
      probeListener: () => ({ status: 'absent' }),
    },
  );

  const result = await handler({
    action: 'accept_handoff',
    handoffId: 'handoff',
    token: 'token',
  });

  assert.equal(result.isError, undefined);
  assert.equal(finished, true);
});

test('handoff cleanup resumes after a later resource fails', async () => {
  let finished = 0;
  let runnerStops = 0;
  let observeStops = 0;
  const runtime = cleanupRuntime(() => {
    finished += 1;
  });
  const first = createSessionHandler(runtime, {
    stopHandoffRunner: async () => {
      runnerStops += 1;
    },
    stopHandoffObserve: async () => {
      observeStops += 1;
      throw new Error('OBSERVE_AUTHORITY_MISMATCH: still listening');
    },
  });
  const retry = createSessionHandler(runtime, {
    stopHandoffRunner: async () => {
      runnerStops += 1;
    },
    stopHandoffObserve: async () => {
      observeStops += 1;
    },
  });

  assert.equal(
    (
      await first({
        action: 'accept_handoff',
        handoffId: 'handoff',
        token: 'token',
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await retry({
        action: 'accept_handoff',
        handoffId: 'handoff',
        token: 'token',
      })
    ).isError,
    undefined,
  );
  assert.equal(runnerStops, 1);
  assert.equal(observeStops, 2);
  assert.equal(finished, 1);
});

test('Metro rebinding clears the prior bundle and releases its target claim', async () => {
  let update;
  const status = {
    sessionId: 'session-a',
    source: { contentRoot: '/project' },
    bindings: {
      metroPort: 8193,
      install: { artifactDigest: 'install' },
      bundle: { targetId: 'target-a' },
    },
  };
  const registry = {
    getSessionStatus: () => status,
    claimResources: () => {},
    updateBindings: (_session, input) => {
      update = input;
    },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry,
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    },
    {
      captureMetro: async () => ({
        port: 8193,
        pid: 123,
        processBirth: 'birth',
        instanceId: 'metro-b',
        servingRoot: '/project',
        buildGeneration: 2,
      }),
    },
  );

  const result = await handler({
    action: 'bind_metro',
    metroPort: 8193,
    metroPid: 123,
    metroInstanceId: 'metro-b',
    buildGeneration: 2,
  });

  assert.equal(result.isError, undefined);
  assert.equal(update.bindings.bundle, null);
  assert.deepEqual(update.releaseResources, [{ type: 'target', key: '8193:target-a' }]);
});
