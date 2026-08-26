import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildReplayEngineStatus, MAESTRO_RUNNER_PIN } from '../../dist/domain/engine-pin.js';
import { createMaestroRunHandler } from '../../dist/tools/maestro-run.js';
import { createMaestroTestAllHandler } from '../../dist/tools/maestro-test-all.js';

const session = {
  name: 'suite-proof',
  platform: 'ios' as const,
  deviceId: '00000000-0000-0000-0000-000000000627',
  appId: 'com.example.proof',
  openedAt: new Date(0).toISOString(),
};

const engineStatus = () =>
  buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false, {
    selectedPath: '/pin-cache/maestro-runner/1.1.24/bin/maestro-runner',
    provenance: 'pin-cache',
  });

test('maestro_test_all routes owned iOS actions through the shared proof planner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-suite-proof-planner-'));
  const flowDir = join(root, '.rn-agent', 'actions');
  mkdirSync(flowDir, { recursive: true });
  writeFileSync(
    join(flowDir, 'react-ready.yaml'),
    [
      `appId: ${session.appId}`,
      '---',
      '# id: react-ready',
      '# intent: prove suite routing',
      '# status: active',
      `# enginePin: maestro-runner@${MAESTRO_RUNNER_PIN.version}`,
      '- assertVisible: Native status',
      '- assertVisible:',
      '    id: ready',
      '',
    ].join('\n'),
  );

  let nativeExecutions = 0;
  let nativeDispatchSelections = 0;
  const treeReads: string[] = [];
  const sharedRun = createMaestroRunHandler({
    getActiveSession: () => session,
    chooseDispatch: () => {
      nativeDispatchSelections += 1;
      return {
        runner: 'maestro-runner',
        binPath: '/fake/maestro-runner',
        buildArgs: () => ['test', '/tmp/flow.yaml'],
      };
    },
    parkFlow: async (run) => run(),
    execFile: async () => {
      nativeExecutions += 1;
      return {
        stdout: [
          'Single device execution mode',
          `Using specified iOS device: ${session.deviceId}`,
          `Building WDA for device ${session.deviceId} (team ID: )`,
          `Starting WDA on device ${session.deviceId} (port: 8447)`,
        ].join('\n'),
        stderr: '',
      };
    },
    resolveEngineStatus: async () => engineStatus(),
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => {
        treeReads.push(id);
        return { testID: id, children: [] };
      },
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
  });
  const handler = createMaestroTestAllHandler({
    getActiveSession: () => session,
    chooseDispatch: () => {
      throw new Error('owned iOS suite must not preselect the native runner');
    },
    resolveEngineStatus: async () => engineStatus(),
    runFlow: sharedRun,
    now: () => 100,
    execFile: async () => {
      throw new Error('suite must delegate instead of executing the native runner directly');
    },
    claimNativeOrigin: async () => {},
    completeNativeOrigin: async () => {},
    relaunchManagedApp: async () => {},
    reproveManagedOrigin: async () => {},
    completeRunnerPark: async () => {},
  });

  try {
    const result = await handler({ platform: 'ios', flowDir });
    const envelope = JSON.parse(result.content[0]!.text) as {
      ok?: boolean;
      data?: { passed?: number; results?: Array<Record<string, unknown>> };
    };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data?.passed, 1);
    assert.deepEqual(treeReads, ['ready']);
    assert.equal(nativeDispatchSelections, 1);
    assert.equal(nativeExecutions, 1);
    assert.deepEqual(envelope.data?.results?.[0], {
      name: 'react-ready.yaml',
      passed: true,
      durationMs: 0,
      proofDomain: 'partitioned',
      proofDomains: ['xctest-native', 'react-tree'],
      runner: 'partitioned',
      transport: 'partitioned',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
