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
    (error) =>
      error instanceof SessionAuthorityError && error.code === 'BUNDLE_HANDSHAKE_UNAVAILABLE',
  );
});

test('native app origin accepts a matching app target on the exact claimed device', async () => {
  const probe = createLocalAuthorityProbe(
    dependencies({
      fetchTargets: async (port) => {
        assert.equal(port, 8082);
        return [
          {
            id: 'foreign',
            title: 'com.example.app (iPhone 16)',
            appId: 'com.example.app',
            vm: 'Hermes',
            webSocketDebuggerUrl: 'ws://127.0.0.1:8082/foreign',
            deviceName: 'iPhone 16',
          },
          {
            id: 'claimed',
            title: 'com.example.app (Issue582)',
            appId: 'com.example.app',
            vm: 'Hermes',
            webSocketDebuggerUrl: 'ws://127.0.0.1:8082/claimed',
            deviceName: 'Issue582',
          },
        ];
      },
      proveTargetDevices: async ({ deviceId, targetDeviceNames }) => {
        assert.deepEqual(targetDeviceNames, ['iPhone 16', 'Issue582']);
        if (deviceId !== 'SIM-A' || !targetDeviceNames.includes('Issue582')) {
          throw new Error('foreign device');
        }
      },
    }),
  );
  const observation = await probe({
    axis: 'A',
    status: statusWith({
      metro: { port: 8082 },
      device: { platform: 'ios', deviceId: 'SIM-A', appId: 'com.example.app' },
    }),
  });

  assert.equal(observation.axis, 'A');
  assert.deepEqual(observation.detail, { authorityScope: 'live-metro-target-device' });
});

test('native app origin rejects when only a sibling device is attached to the Metro', async () => {
  const probe = createLocalAuthorityProbe(
    dependencies({
      fetchTargets: async () => [
        {
          id: 'foreign',
          title: 'com.example.app (Sibling)',
          appId: 'com.example.app',
          vm: 'Hermes',
          webSocketDebuggerUrl: 'ws://127.0.0.1:8082/foreign',
          deviceName: 'Sibling',
        },
      ],
      proveTargetDevices: async () => {
        throw new Error('foreign device');
      },
    }),
  );

  await assert.rejects(
    () =>
      probe({
        axis: 'A',
        status: statusWith({
          metro: { port: 8082 },
          device: { platform: 'ios', deviceId: 'SIM-A', appId: 'com.example.app' },
        }),
      }),
    (error) => error instanceof SessionAuthorityError && error.code === 'METRO_ORIGIN_MISMATCH',
  );
});

test('native app origin identity ignores ephemeral target replacement', async () => {
  let targetId = 'target-before';
  const probe = createLocalAuthorityProbe(
    dependencies({
      fetchTargets: async () => [
        {
          id: targetId,
          title: 'com.example.app (Issue582)',
          appId: 'com.example.app',
          vm: 'Hermes',
          webSocketDebuggerUrl: `ws://127.0.0.1:8082/${targetId}`,
          deviceName: 'Issue582',
        },
      ],
      proveTargetDevices: async () => {},
    }),
  );
  const status = statusWith({
    metro: { port: 8082 },
    device: { platform: 'ios', deviceId: 'SIM-A', appId: 'com.example.app' },
  });

  const before = await probe({ axis: 'A', phase: 'preflight', status });
  targetId = 'target-after';
  const after = await probe({ axis: 'A', phase: 'postflight', status });

  assert.equal(before.identity, after.identity);
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
  let operationalAvailable = false;
  const registry = {
    getControllerBinding: () => {
      calls.push('operational');
      if (!operationalAvailable) {
        throw new SessionAuthorityError('SESSION_OWNER_LOST', 'handoff is not operational');
      }
      return controller;
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
    phase: 'preflight',
    status,
    tool: 'rn_session',
    args: { action: 'cancel_handoff' },
  });
  operationalAvailable = true;
  status.state = 'ready';
  await probe({
    axis: 'C',
    phase: 'postflight',
    status,
    tool: 'rn_session',
    args: { action: 'cancel_handoff' },
  });
  operationalAvailable = false;
  status.state = 'handoff';
  await assert.rejects(
    () =>
      probe({
        axis: 'C',
        phase: 'preflight',
        status,
        tool: 'rn_session',
        args: { action: 'bind_metro' },
      }),
    (error) => error instanceof SessionAuthorityError && error.code === 'SESSION_OWNER_LOST',
  );
  assert.deepEqual(calls, ['handoff-cancellation', 'operational', 'operational']);
});
