import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CDPClient } from '../../dist/cdp-client.js';
import { buildReplayEngineStatus, MAESTRO_RUNNER_PIN } from '../../dist/domain/engine-pin.js';
import { createAuthorityGate } from '../../dist/session/authority-gate.js';
import { SessionAuthorityError } from '../../dist/session/registry.js';
import { withRecoveredAuthoritativeRuntime } from '../../dist/session/runtime-connection-recovery.js';
import { chooseMaestroDispatch } from '../../dist/tools/maestro-dispatch.js';
import { createMaestroRunHandler } from '../../dist/tools/maestro-run.js';

const DEVICE_ID = '5C10B45B-2065-458B-B885-0F83F49747C8';
const APP_ID = 'com.rndevagent.testapp';

function dispatch() {
  const selected = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => '/usr/bin/adb',
    whichMaestro: () => '/usr/bin/maestro',
    maestroRunnerPath: () => '/fake/maestro-runner',
  });
  if ('error' in selected) throw new Error(selected.error);
  return selected;
}

function runnerOutput(): string {
  return [
    'Single device execution mode',
    `Using specified iOS device: ${DEVICE_ID}`,
    `Building WDA for device ${DEVICE_ID} (team ID: )`,
    `Starting WDA on device ${DEVICE_ID} (port: 8447)`,
    '    ✓ assertVisible (0.1s)',
  ].join('\n');
}

function authorityFixture() {
  const status = {
    available: true,
    sessionId: 'session-a',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    state: 'ready',
    claimEpoch: 4,
    authorityVersion: 9,
    leaseUntilMs: 1000,
    source: { kind: 'git', appRoot: process.cwd() },
    bindings: {
      install: {
        platform: 'ios',
        deviceId: DEVICE_ID,
        appId: APP_ID,
        artifactDigest: 'attested-digest',
        installGeneration: 'generation-1',
      },
      metro: { instanceId: 'metro', port: 8193 },
      bundle: { targetId: 'target-1', connectionGeneration: 1 },
      device: { platform: 'ios', deviceId: DEVICE_ID, appId: APP_ID },
      runner: { platform: 'ios', deviceId: DEVICE_ID, port: 8477 },
      observe: null,
      proof: null,
    } as Record<string, unknown>,
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const registry = {
    beginOperation: (_session: unknown, input: { operationId: string }) => ({
      operationId: input.operationId,
      sessionId: 'session-a',
      claimEpoch: 4,
      authorityVersion: status.authorityVersion,
    }),
    getClaim: () => null,
    verifyOperation: () => {},
    operationHasAxis: () => true,
    runWithOperation: async (_operation: unknown, callback: () => unknown) => callback(),
    commitPlatformAuthorityReceipts: () => {},
    endOperation: () => {},
    cancelOperation: () => {},
    refreshOperation: (operation: { authorityVersion: number }) => ({
      ...operation,
      authorityVersion: status.authorityVersion,
    }),
    replaceBindingsDuringOperation: (
      operation: { authorityVersion: number },
      input: { bindings: Record<string, unknown> },
    ) => {
      status.bindings = { ...status.bindings, ...input.bindings };
      status.authorityVersion += 1;
      return { ...operation, authorityVersion: status.authorityVersion };
    },
  };
  return {
    status,
    runtime: {
      requireAvailable: () => ({
        registry,
        session: { sessionId: 'session-a', claimEpoch: 4 },
      }),
      status: () => status,
    },
  };
}

function runtimeClientFixture() {
  let connected = true;
  let connectionGeneration = 1;
  let reconnects = 0;
  const client = {
    get isConnected() {
      return connected;
    },
    get reconnectState() {
      return { active: false, lastAttempt: null, attemptCount: reconnects };
    },
    get connectedTarget() {
      return connected ? { id: `target-${connectionGeneration}` } : null;
    },
    get connectionGeneration() {
      return connectionGeneration;
    },
    matchesAuthoritativeSessionPolicy: () => true,
    autoConnect: async () => {
      reconnects += 1;
      connectionGeneration += 1;
      connected = true;
      return 'connected';
    },
  } as unknown as CDPClient;
  return {
    client,
    disconnect: () => {
      connected = false;
    },
    get reconnects() {
      return reconnects;
    },
  };
}

test('public mixed maestro_run forwards only its operation-scoped authority capabilities', async () => {
  const { runtime, status } = authorityFixture();
  let reissues = 0;
  let nativeDispatches = 0;
  const gate = createAuthorityGate(runtime as never, {
    probe: async ({ axis }: { axis: string }) => ({ axis, identity: `${axis}-identity` }),
    refreshRuntimeBinding: async () => ({ targetId: 'target-1', connectionGeneration: 1 }),
    relaunchBoundRuntime: async () => undefined,
    reissueInstallBinding: (install: Record<string, unknown> | undefined) => {
      reissues += 1;
      return install ? { ...install, installGeneration: 'generation-2' } : null;
    },
  });
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partitioned-production-path',
      platform: 'ios',
      deviceId: DEVICE_ID,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => dispatch(),
    parkFlow: async (run, options) => {
      await options.completeRunnerPark?.(options.signal);
      return run();
    },
    stopFastRunner: async () => {},
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => {
      nativeDispatches += 1;
      return { stdout: runnerOutput(), stderr: '' };
    },
  });
  const wrapped = gate.wrap('maestro_run', handler);
  const result = await wrapped({
    platform: 'ios',
    deviceId: DEVICE_ID,
    appId: APP_ID,
    appFile: '/tmp/TestApp.app',
    inlineYaml: `appId: ${APP_ID}
---
- launchApp:
    clearState: true
- assertVisible: Native status
- assertVisible:
    id: react-status
`,
  });
  const envelope = JSON.parse(result.content[0]!.text);

  assert.equal(envelope.ok, true, envelope.error);
  assert.equal(envelope.data?.proofDomain, 'partitioned');
  assert.equal(nativeDispatches, 2);
  assert.equal(reissues, 1);
  assert.equal(status.bindings.runner, null);
  assert.equal(
    (status.bindings.install as { installGeneration: string }).installGeneration,
    'generation-2',
  );
});

test('public mixed maestro_run reconnects and completes after native segments in either order', async (t) => {
  for (const order of ['react-native', 'native-react'] as const) {
    await t.test(order, async () => {
      const { runtime, status } = authorityFixture();
      const runtimeClient = runtimeClientFixture();
      let nativeDispatches = 0;
      let droppedDuringPostNativeProof = false;
      const gate = createAuthorityGate(runtime as never, {
        probe: async ({ axis }: { axis: string }) => ({ axis, identity: `${axis}-identity` }),
        refreshRuntimeBinding: async () =>
          withRecoveredAuthoritativeRuntime(
            status as never,
            runtimeClient.client,
            async (client) => {
              if (nativeDispatches > 0 && !droppedDuringPostNativeProof) {
                droppedDuringPostNativeProof = true;
                runtimeClient.disconnect();
                throw new Error('WebSocket not connected');
              }
              assert.equal(client.isConnected, true);
              return {
                targetId: client.connectedTarget?.id,
                connectionGeneration: client.connectionGeneration,
              };
            },
            { getClient: () => runtimeClient.client },
          ),
        relaunchBoundRuntime: async () => undefined,
        reconnectBoundRuntime: async () => undefined,
      });
      const handler = createMaestroRunHandler({
        getActiveSession: () => ({
          name: `partitioned-reconnect-${order}`,
          platform: 'ios',
          deviceId: DEVICE_ID,
          appId: APP_ID,
          openedAt: new Date(0).toISOString(),
        }),
        replayDeps: () => ({
          pressByTestId: async () => {},
          typeByTestId: async () => {},
          treeFor: async (id) => {
            assert.equal(runtimeClient.client.isConnected, true);
            return { testID: id };
          },
          frontmostFor: async () => ({ visible: true }),
          launchApp: async () => {},
          settle: async () => {},
        }),
        chooseDispatch: () => dispatch(),
        parkFlow: async (run, options) => {
          await options.completeRunnerPark?.(options.signal);
          return run();
        },
        stopFastRunner: async () => {},
        resolveEngineStatus: async () =>
          buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
        execFile: async () => {
          nativeDispatches += 1;
          runtimeClient.disconnect();
          return { stdout: runnerOutput(), stderr: '' };
        },
      });
      const commands =
        order === 'react-native'
          ? `- assertVisible:\n    id: react-status\n- assertVisible: Native status`
          : `- assertVisible: Native status\n- assertVisible:\n    id: react-status`;
      const result = await gate.wrap(
        'maestro_run',
        handler,
      )({
        platform: 'ios',
        deviceId: DEVICE_ID,
        appId: APP_ID,
        appFile: '/tmp/TestApp.app',
        inlineYaml: `appId: ${APP_ID}\n---\n${commands}\n`,
      });
      const envelope = JSON.parse(result.content[0]!.text);

      assert.equal(envelope.ok, true, envelope.error);
      assert.equal(envelope.data?.passed, true);
      assert.equal(envelope.data?.proofDomain, 'partitioned');
      assert.deepEqual(
        envelope.data?.proofDomains,
        order === 'react-native'
          ? ['react-tree', 'xctest-native']
          : ['xctest-native', 'react-tree'],
      );
      assert.equal(nativeDispatches, 1);
      assert.equal(runtimeClient.reconnects, 2);
      assert.equal(runtimeClient.client.isConnected, true);
      assert.doesNotMatch(result.content[0]!.text, /METRO_ORIGIN_MISMATCH/);
    });
  }
});

test('ungated mixed replay does not acquire nested native authority', async () => {
  let nativeDispatches = 0;
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partitioned-negative-control',
      platform: 'ios',
      deviceId: DEVICE_ID,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => dispatch(),
    parkFlow: async (run, options) => {
      await options.completeRunnerPark?.(options.signal);
      return run();
    },
    stopFastRunner: async () => {},
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => {
      nativeDispatches += 1;
      return { stdout: runnerOutput(), stderr: '' };
    },
  });
  await assert.rejects(
    () =>
      handler({
        platform: 'ios',
        deviceId: DEVICE_ID,
        appId: APP_ID,
        inlineYaml: `appId: ${APP_ID}
---
- assertVisible: Native status
- assertVisible:
    id: react-status
`,
      }),
    (error: { code?: string }) => error.code === 'METRO_ORIGIN_MISMATCH',
  );
  assert.equal(nativeDispatches, 0);
});

// The live gate contract for the partitioned native leg: completing the
// deferred origin with a target expected re-proves the exact CDP session
// target, and only reproveManagedOrigin (connectExactSessionTarget with a
// readiness wait) restores it after a WDA-driven segment dropped it.
function partitionedHandoffFixture(opts: {
  reproveRestoresTarget: boolean;
  execFile?: () => Promise<{ stdout: string; stderr: string }>;
  droppedTargetError?: () => Error;
}) {
  const events: string[] = [];
  const reactSuffixRan = () => events.some((event) => event.startsWith('react:'));
  let exactTargetConnected = true;
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partitioned-handoff',
      platform: 'ios',
      deviceId: DEVICE_ID,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id: string) => ({ testID: id }),
      frontmostFor: async (id: string) => {
        assert.equal(exactTargetConnected, true, 'React replay ran on a dropped target');
        events.push(`react:${id}`);
        return { visible: true };
      },
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => dispatch(),
    parkFlow: async (run, options) => {
      events.push('park');
      assert.ok(options.completeRunnerPark, 'nested run must forward completeRunnerPark');
      await options.completeRunnerPark(options.signal);
      try {
        return await run();
      } finally {
        events.push('resume');
      }
    },
    stopFastRunner: async () => {},
    fastHealthCheck: async () => false,
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile:
      opts.execFile ??
      (async () => {
        events.push('execute');
        exactTargetConnected = false;
        return { stdout: runnerOutput(), stderr: '' };
      }),
  });
  const args = {
    platform: 'ios' as const,
    deviceId: DEVICE_ID,
    appId: APP_ID,
    inlineYaml: `appId: ${APP_ID}\n---\n- assertVisible: Native status\n- assertVisible:\n    id: react-status\n`,
    claimNativeOrigin: async () => {
      events.push('claim');
    },
    completeNativeOrigin: async (targetExpected: boolean) => {
      events.push(`complete:${targetExpected}`);
      if (targetExpected && !exactTargetConnected) {
        throw (
          opts.droppedTargetError?.() ??
          new Error(
            'CDP_TARGET_AUTHORITY_MISMATCH: runtime reset did not reconnect the exact session target',
          )
        );
      }
    },
    relaunchManagedApp: async () => {},
    reproveManagedOrigin: async () => {
      events.push('reprove');
      if (opts.reproveRestoresTarget) exactTargetConnected = true;
    },
    completeRunnerPark: async () => {
      events.push('runner-park');
    },
  };
  return { handler, args, events, reactSuffixRan };
}

test('a partitioned native prefix survives park/resume and the React suffix completes', async () => {
  const { handler, args, events } = partitionedHandoffFixture({
    reproveRestoresTarget: true,
  });
  const envelope = JSON.parse((await handler(args)).content[0]!.text);

  assert.equal(envelope.ok, true, envelope.error);
  assert.equal(envelope.data?.passed, true);
  assert.equal(envelope.data?.proofDomain, 'partitioned');
  assert.deepEqual(envelope.data?.proofDomains, ['xctest-native', 'react-tree']);
  assert.match(envelope.data?.output, /assertVisible/);
  assert.deepEqual(
    envelope.data?.steps.map((step: { index: number; status: string }) => [
      step.index,
      step.status,
    ]),
    [
      [0, 'pass'],
      [1, 'pass'],
    ],
  );
  assert.deepEqual(events, [
    'claim',
    'park',
    'runner-park',
    'execute',
    'resume',
    'reprove',
    'complete:true',
    'claim',
    'react:react-status',
    'complete:true',
  ]);
});

test('a residual handoff failure keeps the nested cause instead of the generic mask', async () => {
  const { handler, args, events, reactSuffixRan } = partitionedHandoffFixture({
    reproveRestoresTarget: false,
  });
  const envelope = JSON.parse((await handler(args)).content[0]!.text);

  assert.equal(envelope.ok, false);
  assert.match(envelope.error, /CDP_TARGET_AUTHORITY_MISMATCH/);
  assert.equal(reactSuffixRan(), false);
  assert.ok(events.includes('reprove'));
});

test('a session authority loss during the handoff escapes as a typed throw', async () => {
  const authorityError = new SessionAuthorityError(
    'CDP_TARGET_AUTHORITY_MISMATCH',
    'session authority was lost during the handoff',
  );
  const { handler, args, reactSuffixRan } = partitionedHandoffFixture({
    reproveRestoresTarget: false,
    droppedTargetError: () => authorityError,
  });
  await assert.rejects(
    () => handler(args),
    (error: unknown) => error === authorityError && error instanceof SessionAuthorityError,
  );
  assert.equal(reactSuffixRan(), false);
});

test('a native prefix that genuinely fails before its first step is not rewritten', async () => {
  const { handler, args, events, reactSuffixRan } = partitionedHandoffFixture({
    reproveRestoresTarget: true,
    execFile: async () => {
      const error = new Error('maestro-runner exited 1 before any step output');
      Object.assign(error, { code: 1, stdout: '', stderr: '' });
      throw error;
    },
  });
  const envelope = JSON.parse((await handler(args)).content[0]!.text);

  assert.equal(envelope.ok, false);
  assert.match(envelope.error, /exited 1 before any step output/);
  assert.equal(envelope.meta?.terminal?.exitClass, 'before-first-step');
  assert.equal(envelope.meta?.terminal?.completedSteps, 0);
  assert.equal(reactSuffixRan(), false);
  assert.deepEqual(events, ['claim', 'park', 'runner-park', 'complete:false', 'resume']);
});
