import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSessionHandler } from '../../../dist/tools/session.js';

test('session status returns the exact opaque session identity', async () => {
  const handler = createSessionHandler({
    status: () => ({
      available: true,
      sessionId: 'session-exact',
      sourceKey: 'source',
      worktreeKey: 'worktree',
      appRootKey: 'app',
      state: 'ready',
      claimEpoch: 1,
      authorityVersion: 1,
      leaseUntilMs: 100,
      source: { kind: 'git' },
      bindings: {},
      claims: [],
      worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
    }),
  } as never);

  const result = await handler({ action: 'status' });
  const envelope = JSON.parse(result.content[0]!.text);

  assert.equal(envelope.data.authority.sessionId, 'session-exact');
});

function cleanupRuntime(
  finish: () => void,
  includeObserve = true,
  includeRunner = true,
  includeMetro = false,
  includeRecorder = false,
) {
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
        metro: includeMetro
          ? {
              mode: 'managed',
              port: 8081,
              sourceSessionId: 'source-session',
              stopRequestedAt: null,
              completedAt: null,
            }
          : null,
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
        recorder: includeRecorder
          ? {
              platform: 'ios',
              deviceId: 'device',
              scope: 'a'.repeat(64),
              pid: 789,
              processBirth: 'record-birth',
              script: '/workspace/record_proof.sh',
              claimKey: 'ios:device',
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

test('handoff preparation forwards an explicit operator TTL', async () => {
  let observed: { targetHandle: string; ttlMs?: number } | undefined;
  const handler = createSessionHandler({
    status: () => ({ available: true, state: 'active', bindings: {} }),
    requireOperational: () => ({
      registry: {
        prepareHandoffForHandle: (
          _session: unknown,
          input: { targetHandle: string; ttlMs?: number },
        ) => {
          observed = input;
          return { handoffId: 'handoff', token: 'token' };
        },
      },
      session: { sessionId: 'source', claimEpoch: 1 },
    }),
  });

  const result = await handler({
    action: 'prepare_handoff',
    targetHandle: 'recipient',
    ttlMs: 120_000,
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(observed, { targetHandle: 'recipient', ttlMs: 120_000 });
});

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

test('handoff cleanup finalizes the session recorder before release', async () => {
  const calls: string[] = [];
  const handler = createSessionHandler(
    cleanupRuntime(() => calls.push('finish'), false, false, false, true),
    {
      stopHandoffRecorder: async () => {
        calls.push('recorder');
      },
    },
  );

  const result = await handler({
    action: 'accept_handoff',
    handoffId: 'handoff',
    token: 'token',
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ['recorder', 'finish']);
});

test('handoff cleanup unblocks only after every managed process stops', async () => {
  const calls: string[] = [];
  const handler = createSessionHandler(
    cleanupRuntime(() => calls.push('finish'), true, true, true),
    {
      stopHandoffRunner: async () => {
        calls.push('runner');
      },
      stopHandoffObserve: async () => {
        calls.push('observe');
      },
      getSignerCapability: (sessionId) => {
        assert.equal(sessionId, 'source-session');
        return 'source-signer';
      },
      stopManagedMetro: async (_binding, authority) => {
        assert.deepEqual(authority, {
          sessionId: 'source-session',
          signerCapability: 'source-signer',
        });
        calls.push('metro');
        return true;
      },
    },
  );

  const result = await handler({
    action: 'accept_handoff',
    handoffId: 'handoff',
    token: 'token',
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ['runner', 'observe', 'metro', 'finish']);
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

test('stale adoption stops every durable cleanup resource before becoming operational', async () => {
  const calls: string[] = [];
  const runnerCleanup = {
    stopRequestedAt: null as number | null,
    completedAt: null as number | null,
  };
  const observeCleanup = {
    stopRequestedAt: null as number | null,
    completedAt: null as number | null,
  };
  const metroCleanup = {
    mode: 'managed',
    port: 8193,
    sourceSessionId: 'prior-session',
    stopRequestedAt: null as number | null,
    completedAt: null as number | null,
  };
  const status = {
    sessionId: 'target',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    state: 'blocked',
    claimEpoch: 1,
    authorityVersion: 2,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings: {} as Record<string, unknown>,
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const registry = {
    getSessionStatus: () => status,
    adoptStaleWithHandle: () => {
      status.state = 'handoff_cleanup';
      status.bindings = {
        handoffCleanup: {
          runner: runnerCleanup,
          observe: observeCleanup,
          metro: metroCleanup,
        },
      };
      calls.push('adopt');
    },
    beginHandoffCleanupResource: (
      _session: unknown,
      _worker: unknown,
      resource: 'runner' | 'observe' | 'metro',
    ) => {
      const cleanup = { runner: runnerCleanup, observe: observeCleanup, metro: metroCleanup }[
        resource
      ];
      cleanup.stopRequestedAt = Date.now();
      return cleanup;
    },
    completeHandoffCleanupResource: (
      _session: unknown,
      _worker: unknown,
      resource: 'runner' | 'observe' | 'metro',
    ) => {
      const cleanup = { runner: runnerCleanup, observe: observeCleanup, metro: metroCleanup }[
        resource
      ];
      cleanup.completedAt = Date.now();
      calls.push(`complete-${resource}`);
    },
    finishHandoffCleanup: () => {
      status.state = 'source_bound';
      calls.push('finish');
    },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireRecovery: () => ({
        registry,
        session: { sessionId: 'target', claimEpoch: 1 },
      }),
      requireOperational: () => {
        throw new Error('unexpected operational access');
      },
    },
    {
      stopHandoffRunner: async () => {
        calls.push('stop-runner');
      },
      stopHandoffObserve: async () => {
        calls.push('stop-observe');
      },
      getSignerCapability: (sessionId) => {
        assert.equal(sessionId, 'prior-session');
        return 'prior-signer';
      },
      stopManagedMetro: async (_binding, authority) => {
        assert.deepEqual(authority, {
          sessionId: 'prior-session',
          signerCapability: 'prior-signer',
        });
        calls.push('stop-metro');
        return true;
      },
    },
  );

  const result = await handler({ action: 'adopt_stale', adoptionHandle: 'handle' });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    'adopt',
    'stop-runner',
    'complete-runner',
    'stop-observe',
    'complete-observe',
    'stop-metro',
    'complete-metro',
    'finish',
  ]);
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

test('device rebinding refuses to discard live runner, Observe, or proof authority', async () => {
  let replaced = false;
  const status = {
    sessionId: 'session-a',
    bindings: {
      runner: { instanceId: 'runner-a' },
      observe: { instanceId: 'observe-a' },
      proof: { runId: 'proof-a' },
    },
  };
  const handler = createSessionHandler({
    status: () => ({ available: true, ...status }),
    requireOperational: () => ({
      registry: {
        getSessionStatus: () => status,
        replaceDeviceAuthority: () => {
          replaced = true;
        },
      },
      session: { sessionId: 'session-a', claimEpoch: 1 },
    }),
  });

  const result = await handler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: 'SIM-2',
    appId: 'dev.example',
  });

  assert.equal(result.isError, true);
  assert.equal(replaced, false);
  assert.match(result.content[0].text, /runner, Observe, or proof authority/i);
});

test('device binding rejects a nonexistent exact device before claiming it', async () => {
  let replaced = false;
  const status = { sessionId: 'session-a', bindings: {} };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          replaceDeviceAuthority: () => {
            replaced = true;
          },
        },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    } as never,
    { deviceExists: () => false } as never,
  );

  const result = await handler({
    action: 'bind_device',
    platform: 'ios',
    deviceId: 'MISSING-SIMULATOR',
    appId: 'dev.example',
  });

  assert.equal(result.isError, true);
  assert.equal(replaced, false);
  assert.equal(JSON.parse(result.content[0].text).code, 'DEVICE_NOT_FOUND');
});

test('device binding preserves the registry foreign-claim refusal', async () => {
  const status = { sessionId: 'session-a', bindings: {} };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          replaceDeviceAuthority: () => {
            const error = new Error(
              'DEVICE_CLAIM_CONFLICT: exact device is claimed by another session',
            ) as Error & { code: string };
            error.name = 'SessionAuthorityError';
            error.code = 'DEVICE_CLAIM_CONFLICT';
            throw error;
          },
        },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    } as never,
    { deviceExists: () => true } as never,
  );

  const result = await handler({
    action: 'bind_device',
    platform: 'android',
    deviceId: 'emulator-5554',
    appId: 'dev.example',
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /DEVICE_CLAIM_CONFLICT/);
});

test('same-session cross-platform rebind accepts an existing unclaimed device without a receipt', async () => {
  let replacement: Record<string, unknown> | undefined;
  const status = {
    sessionId: 'session-a',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    state: 'device_claimed',
    claimEpoch: 1,
    authorityVersion: 1,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings: {
      device: { platform: 'ios', deviceId: 'SIM-1', appId: 'dev.example' },
      install: null,
    },
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          replaceDeviceAuthority: (_session: unknown, input: Record<string, unknown>) => {
            replacement = input;
          },
        },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    } as never,
    { deviceExists: () => true } as never,
  );

  const result = await handler({
    action: 'bind_device',
    platform: 'android',
    deviceId: 'emulator-5554',
    appId: 'dev.example',
  });

  assert.equal(result.isError, undefined);
  assert.ok(replacement);
  assert.deepEqual((replacement.device as Record<string, unknown>).platform, 'android');
});

test('cross-platform rebind refuses to discard an incompatible install receipt', async () => {
  let replaced = false;
  const status = {
    sessionId: 'session-a',
    bindings: {
      device: { platform: 'ios', deviceId: 'SIM-1', appId: 'dev.example' },
      install: {
        platform: 'ios',
        deviceId: 'SIM-1',
        appId: 'dev.example',
        artifactDigest: 'ios-build',
      },
    },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          replaceDeviceAuthority: () => {
            replaced = true;
          },
        },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    } as never,
    { deviceExists: () => true } as never,
  );

  const result = await handler({
    action: 'bind_device',
    platform: 'android',
    deviceId: 'emulator-5554',
    appId: 'dev.example',
  });

  assert.equal(result.isError, true);
  assert.equal(replaced, false);
  assert.equal(JSON.parse(result.content[0].text).code, 'DEVICE_RECEIPT_INCOMPATIBLE');
});

test('public Metro binding rejects managed mode without process management proof', async () => {
  let captured = false;
  const status = {
    sessionId: 'session-a',
    source: { contentRoot: '/project' },
    bindings: { metroPort: 8193 },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: { getSessionStatus: () => status },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    },
    {
      captureMetro: async () => {
        captured = true;
        throw new Error('must not capture an unverifiable managed process');
      },
    },
  );

  const result = await handler({
    action: 'bind_metro',
    metroPort: 8193,
    metroPid: 123,
    metroInstanceId: 'metro-a',
    buildGeneration: 2,
    mode: 'managed',
  });

  assert.equal(result.isError, true);
  assert.equal(captured, false);
  assert.match(result.content[0].text, /managed Metro authority/i);
});

test('an exactly idempotent Metro rebind preserves bundle authority and ready state', async () => {
  let update;
  const metro = {
    port: 8193,
    pid: 123,
    birth: 'birth',
    instanceId: 'metro-a',
    servingRoot: '/project',
    buildGeneration: 2,
    mode: 'external',
  };
  const status = {
    sessionId: 'session-a',
    state: 'ready',
    source: { contentRoot: '/project' },
    bindings: {
      metroPort: 8193,
      metro,
      install: { artifactDigest: 'install' },
      bundle: { targetId: 'target-a' },
    },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          claimResources: () => {},
          updateBindings: (_session, input) => {
            update = input;
          },
        },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    },
    { captureMetro: async () => metro },
  );

  const result = await handler({
    action: 'bind_metro',
    metroPort: 8193,
    metroPid: 123,
    metroInstanceId: 'metro-a',
    buildGeneration: 2,
  });

  assert.equal(result.isError, undefined);
  assert.equal(update.state, 'ready');
  assert.equal(Object.hasOwn(update.bindings, 'bundle'), false);
  assert.deepEqual(update.releaseResources, []);
});

test('forced dev-client pin invalidates the prior target before recreating the client', async () => {
  const calls: string[] = [];
  const status = {
    sessionId: 'session-a',
    state: 'ready',
    source: { kind: 'git', appRoot: '/project' },
    bindings: {
      metroPort: 8193,
      install: { artifactDigest: 'install' },
      metro: { instanceId: 'metro-a' },
      device: { platform: 'ios', deviceId: 'SIM-1', appId: 'dev.example' },
      bundle: { targetId: 'target-a' },
    },
  };
  const bundle = {
    sessionId: 'session-a',
    metroInstanceId: 'metro-a',
    worktreeKey: 'worktree-a',
    appId: 'dev.example',
    platform: 'ios',
    buildGeneration: 1,
    deviceId: 'SIM-1',
    metroPort: 8193,
    launchMethod: 'app',
    targetId: 'target-b',
    connectionGeneration: 2,
    authorityScope: 'initial-bundle',
    sourceFidelity: 'not-proven',
  } as const;
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          releaseResources: (_session, resources) => calls.push(`release:${resources[0].key}`),
          updateBindings: (_session, update) =>
            calls.push(update.bindings.bundle === null ? 'clear-bundle' : 'bind-bundle'),
          claimResources: (_session, resources) => calls.push(`claim:${resources[0].key}`),
        },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    },
    {
      pinDevClient: async (_status, options) => {
        assert.equal(options.force, true);
        calls.push('recreate-client');
        return bundle;
      },
    },
  );

  const result = await handler({ action: 'pin_dev_client', force: true });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    'release:8193:target-a',
    'clear-bundle',
    'recreate-client',
    'claim:8193:target-b',
    'bind-bundle',
  ]);
});

test('session release stops its managed Metro before releasing claims', async () => {
  const calls: string[] = [];
  const status = {
    sessionId: 'session-a',
    bindings: {
      metro: {
        mode: 'managed',
        launcherPid: 123,
        launcherBirth: 'birth',
        instanceId: 'metro-a',
        managementProof: 'proof',
      },
    },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          releaseSession: () => calls.push('release'),
        },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    },
    {
      getSignerCapability: () => 'signer',
      stopManagedMetro: async (_binding, authority) => {
        assert.deepEqual(authority, {
          sessionId: 'session-a',
          signerCapability: 'signer',
        });
        calls.push('stop-metro');
        return true;
      },
    },
  );

  const result = await handler({ action: 'release' });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ['stop-metro', 'release']);
});

test('session release tears down its runner and Observe server before Metro and claims', async () => {
  const calls: string[] = [];
  const status = {
    sessionId: 'session-a',
    bindings: {
      observePort: 7333,
      runner: {
        platform: 'ios',
        deviceId: 'SIM-1',
        port: 9100,
        pid: 123,
        processBirth: 'runner-birth',
        instanceId: 'runner-a',
        capability: 'runner-capability',
      },
      observe: {
        port: 7333,
        pid: 456,
        processBirth: 'observe-birth',
        instanceId: 'observe-a',
        cleanupCapability: 'observe-capability',
      },
      metro: { mode: 'managed' },
    },
    claims: [
      {
        type: 'runner',
        key: 'ios:SIM-1:9100',
        sessionId: 'session-a',
        claimEpoch: 1,
      },
      {
        type: 'observe-port',
        key: '7333',
        sessionId: 'session-a',
        claimEpoch: 1,
      },
    ],
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          releaseSession: () => calls.push('release'),
        },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    },
    {
      getSignerCapability: () => 'signer',
      stopHandoffRunner: async () => {
        calls.push('stop-runner');
      },
      stopHandoffObserve: async () => {
        calls.push('stop-observe');
      },
      stopManagedMetro: async () => {
        calls.push('stop-metro');
        return true;
      },
    },
  );

  const result = await handler({ action: 'release' });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ['stop-runner', 'stop-observe', 'stop-metro', 'release']);
});

test('session release retains every claim when bound process cleanup is unproven', async () => {
  let released = false;
  const status = {
    sessionId: 'session-a',
    bindings: {
      observePort: 7333,
      runner: {
        platform: 'ios',
        deviceId: 'SIM-1',
        port: 9100,
      },
      observe: { port: 7333 },
    },
    claims: [
      {
        type: 'runner',
        key: 'ios:SIM-1:9100',
        sessionId: 'session-a',
        claimEpoch: 1,
      },
      {
        type: 'observe-port',
        key: '7333',
        sessionId: 'session-a',
        claimEpoch: 1,
      },
    ],
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          releaseSession: () => {
            released = true;
          },
        },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    },
    {
      stopHandoffRunner: async () => {
        throw new Error('RUNNER_ADOPTION_REQUIRED: still running');
      },
    },
  );

  const result = await handler({ action: 'release' });

  assert.equal(result.isError, true);
  assert.equal(released, false);
  assert.match(result.content[0].text, /RUNNER_ADOPTION_REQUIRED/);
});

test('session release retains claims when managed Metro shutdown is not proven', async () => {
  let released = false;
  const status = {
    sessionId: 'session-a',
    bindings: { metro: { mode: 'managed' } },
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          releaseSession: () => {
            released = true;
          },
        },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    },
    {
      getSignerCapability: () => 'signer',
      stopManagedMetro: async () => false,
    },
  );

  const result = await handler({ action: 'release' });

  assert.equal(result.isError, true);
  assert.equal(released, false);
  assert.match(result.content[0].text, /METRO_AUTHORITY_MISMATCH/);
});

test('arbiter recovery requires operational session authority and explicit confirmation', async () => {
  const calls: string[] = [];
  const status = {
    sessionId: 'session-a',
    source: { kind: 'git' },
    bindings: {},
  };
  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => {
        calls.push('authority');
        return {
          registry: {},
          session: { sessionId: 'session-a', claimEpoch: 1 },
        };
      },
    },
    {
      resetArbiter: (reason) => {
        calls.push(`reset:${reason}`);
        return { clearedOps: 1, hadFlow: true, reason };
      },
    },
  );

  const refused = await handler({ action: 'recover_arbiter' });
  const recovered = await handler({ action: 'recover_arbiter', confirmed: true });

  assert.equal(refused.isError, true);
  assert.equal(recovered.isError, undefined);
  assert.deepEqual(calls, ['authority', 'authority', 'reset:manual via fenced rn_session']);
});

test('integration preview rejects a symlinked .rn-agent before reading its manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-preview-symlink-'));
  const external = mkdtempSync(join(tmpdir(), 'rn-session-preview-external-'));
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: { ios: 'expo run:ios', android: 'expo run:android' },
      }),
    );
    writeFileSync(join(root, 'metro.config.js'), 'module.exports = {};\n');
    mkdirSync(join(external, 'integration'));
    writeFileSync(
      join(external, 'integration', 'rn-session-integration.json'),
      JSON.stringify({
        version: 1,
        adapter: '.rn-agent/integration/rn-session-adapter.cjs',
        originalScripts: { ios: ['external'], android: ['external'] },
      }),
    );
    symlinkSync(external, join(root, '.rn-agent'));
    const status = {
      sessionId: 'session-a',
      source: { appRoot: root },
      bindings: {},
    };
    const handler = createSessionHandler({
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: { getSessionStatus: () => status },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    });

    const result = await handler({ action: 'preview_integration' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /SESSION_INTEGRATION_PATH_UNSAFE/);
    assert.doesNotMatch(result.content[0].text, /external/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('integration restoration rejects active handoff cleanup authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-restore-active-'));
  try {
    const integration = join(root, '.rn-agent', 'integration');
    mkdirSync(integration, { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { ios: 'integrated', android: 'integrated' } }),
    );
    writeFileSync(join(root, 'metro.config.js'), 'module.exports = {};\n');
    const manifestPath = join(integration, 'rn-session-integration.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        adapter: '.rn-agent/integration/rn-session-adapter.cjs',
        originalScripts: { ios: ['expo', 'run:ios'], android: ['expo', 'run:android'] },
      }),
    );
    const status = {
      sessionId: 'session-a',
      source: { appRoot: root },
      bindings: { handoffCleanup: { metro: { mode: 'managed' } } },
    };
    const handler = createSessionHandler({
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          updateBindings: () => assert.fail('active authority must not be changed'),
        },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    });

    const result = await handler({ action: 'restore_integration', confirmed: true });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /releasing active handoffCleanup authority/);
    assert.equal(existsSync(manifestPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('handoff recipient restores donor-installed integration with transferred authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-restore-transferred-'));
  try {
    const packagePath = join(root, 'package.json');
    const originalPackage = {
      scripts: { ios: 'expo run:ios', android: 'expo run:android' },
    };
    writeFileSync(packagePath, `${JSON.stringify(originalPackage)}\n`);
    const metroPath = join(root, 'metro.config.js');
    const originalMetro = 'module.exports = {};\n';
    writeFileSync(metroPath, originalMetro);
    let activeSessionId = 'donor';
    const status = {
      sessionId: activeSessionId,
      source: { appRoot: root },
      bindings: {} as Record<string, unknown>,
    };
    const registry = {
      getSessionStatus: () => ({ ...status, sessionId: activeSessionId }),
      updateBindings: (_session: unknown, update: { bindings: Record<string, unknown> }) => {
        status.bindings = { ...status.bindings, ...update.bindings };
      },
    };
    const handler = createSessionHandler({
      status: () => ({ available: true, ...status, sessionId: activeSessionId }),
      requireOperational: () => ({
        registry,
        session: { sessionId: activeSessionId, claimEpoch: 1 },
      }),
    });

    const applied = await handler({ action: 'apply_integration', confirmed: true });
    assert.equal(applied.isError, undefined);
    assert.equal(
      (status.bindings.packageIntegration as { installedBySessionId?: string })
        .installedBySessionId,
      'donor',
    );

    activeSessionId = 'recipient';
    const restored = await handler({ action: 'restore_integration', confirmed: true });

    assert.equal(restored.isError, undefined);
    assert.deepEqual(JSON.parse(readFileSync(packagePath, 'utf8')), originalPackage);
    assert.equal(readFileSync(metroPath, 'utf8'), originalMetro);
    assert.equal(status.bindings.packageIntegration, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration application rejects active runtime authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-apply-active-'));
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: { ios: 'expo run:ios', android: 'expo run:android' },
      }),
    );
    const metroPath = join(root, 'metro.config.js');
    const metroBefore = 'module.exports = {};\n';
    writeFileSync(metroPath, metroBefore);
    const status = {
      sessionId: 'session-a',
      source: { appRoot: root },
      bindings: { runner: { platform: 'ios' } },
    };
    const handler = createSessionHandler({
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          updateBindings: () => assert.fail('active authority must not be changed'),
        },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    });

    const result = await handler({ action: 'apply_integration', confirmed: true });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /releasing active runner authority/);
    assert.equal(existsSync(join(root, '.rn-agent')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration application rolls back files when its authority binding fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-apply-binding-failure-'));
  try {
    const packagePath = join(root, 'package.json');
    const packageBefore = `${JSON.stringify({
      scripts: { ios: 'expo run:ios', android: 'expo run:android' },
    })}\n`;
    const metroPath = join(root, 'metro.config.js');
    const metroBefore = 'module.exports = {};\n';
    writeFileSync(packagePath, packageBefore);
    writeFileSync(metroPath, metroBefore);
    const status = {
      sessionId: 'session-a',
      source: { appRoot: root },
      bindings: {},
    };
    const handler = createSessionHandler({
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          updateBindings: () => {
            throw new Error('binding commit failed');
          },
        },
        session: { sessionId: 'session-a', claimEpoch: 1 },
      }),
    });

    const result = await handler({ action: 'apply_integration', confirmed: true });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /binding commit failed/);
    assert.deepEqual(JSON.parse(readFileSync(packagePath, 'utf8')), JSON.parse(packageBefore));
    assert.equal(readFileSync(metroPath, 'utf8'), metroBefore);
    assert.equal(
      existsSync(join(root, '.rn-agent', 'integration', 'rn-session-integration.json')),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
