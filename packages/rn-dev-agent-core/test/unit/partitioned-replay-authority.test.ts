import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReplayEngineStatus, MAESTRO_RUNNER_PIN } from '../../dist/domain/engine-pin.js';
import { createAuthorityGate } from '../../dist/session/authority-gate.js';
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
