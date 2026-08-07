// GH #708: a mid-flow `launchApp` relaunch used to abort the whole run when the
// relaunched dev-client had not re-registered yet — the flow's own post-launch
// steps (dev-server picker) never got to run, and a passing flow was reported as
// a CDP_TARGET_AUTHORITY_MISMATCH failure. The origin is now re-proven at flow
// end instead, and a genuine mismatch still fails the run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createMaestroRunHandler,
  executeMaestroAuthorityStages,
  MaestroStageExecutionError,
} from '../../dist/tools/maestro-run.js';
import { chooseMaestroDispatch } from '../../dist/tools/maestro-dispatch.js';
import { SessionAuthorityError } from '../../dist/session/registry.js';

const EXACT = '5C10B45B-2065-458B-B885-0F83F49747C8';
const APP_ID = 'com.rndevagent.testapp';

const RELAUNCH_FLOW = [
  '- tapOn:',
  '    id: "before"',
  '- launchApp:',
  '    stopApp: true',
  '- tapOn:',
  '    id: "after"',
].join('\n');

const AUTHORITY_ERROR = new Error(
  'CDP_TARGET_AUTHORITY_MISMATCH: exact managed-Metro target did not re-register after launch',
);

interface StageTrace {
  stages: unknown[][];
  claims: number;
  completed: boolean[];
  relaunches: number;
  reproves: number;
}

function newTrace(): StageTrace {
  return { stages: [], claims: 0, completed: [], relaunches: 0, reproves: 0 };
}

function runStages(
  trace: StageTrace,
  relaunch: () => Promise<void>,
  reprove: () => Promise<void>,
): Promise<string[]> {
  return executeMaestroAuthorityStages(
    [{ tapOn: { id: 'before' } }, { launchApp: { stopApp: true } }, { tapOn: { id: 'after' } }],
    async (commands: readonly unknown[]) => {
      trace.stages.push([...commands]);
      return `stage-${trace.stages.length}`;
    },
    async () => {
      trace.claims += 1;
    },
    async (targetExpected: boolean) => {
      trace.completed.push(targetExpected);
    },
    async () => {
      trace.relaunches += 1;
      await relaunch();
    },
    async () => {
      trace.reproves += 1;
      await reprove();
    },
  );
}

test('GH#708: a mid-flow relaunch that re-registers late still runs the rest of the flow', async () => {
  const trace = newTrace();
  const results = await runStages(
    trace,
    async () => {
      throw AUTHORITY_ERROR;
    },
    async () => {},
  );

  assert.deepEqual(results, ['stage-1', 'stage-2', 'stage-3']);
  assert.equal(trace.stages.length, 3, 'the post-launch stage must still execute');
  assert.deepEqual(trace.stages[2], [{ tapOn: { id: 'after' } }]);
  assert.equal(trace.reproves, 1, 'the origin is re-proven once, at flow end');
  assert.deepEqual(trace.completed, [true], 'the run completes with the target expected');
});

test('GH#708: the deferred re-prove never relaunches a second time', async () => {
  const trace = newTrace();
  await runStages(
    trace,
    async () => {
      throw AUTHORITY_ERROR;
    },
    async () => {},
  );

  assert.equal(trace.relaunches, 1, 'flow-end recovery must not cold-start the app again');
  assert.equal(trace.claims, 1, 'the post-launch stage claim is deferred, not doubled');
});

test('GH#708: a genuine authority mismatch still fails the run', async () => {
  const trace = newTrace();
  const mismatch = new Error('CDP_TARGET_AUTHORITY_MISMATCH: wrong target on the exact device');
  await assert.rejects(
    runStages(
      trace,
      async () => {
        throw mismatch;
      },
      async () => {
        throw new Error('reconnect refused');
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof MaestroStageExecutionError);
      assert.equal(error.stageError, mismatch, 'the original authority failure is preserved');
      assert.deepEqual(error.completedResults, ['stage-1', 'stage-2', 'stage-3']);
      return true;
    },
  );
  assert.deepEqual(trace.completed, [false], 'the origin is completed without a target');
});

test('GH#708: a relaunch failure with no re-prove authority still aborts', async () => {
  const stages: unknown[][] = [];
  await assert.rejects(
    executeMaestroAuthorityStages(
      [{ launchApp: { stopApp: true } }, { tapOn: { id: 'after' } }],
      async (commands: readonly unknown[]) => {
        stages.push([...commands]);
        return 'stage';
      },
      async () => {},
      async () => {},
      async () => {
        throw AUTHORITY_ERROR;
      },
    ),
    /did not re-register after launch/,
  );
  assert.equal(stages.length, 1);
});

test('GH#708: a revoked session claim aborts immediately instead of deferring', async () => {
  const trace = newTrace();
  const revoked = new SessionAuthorityError(
    'AUTHORITY_LOST_DURING_OPERATION',
    'the session claim was revoked',
  );
  await assert.rejects(
    runStages(
      trace,
      async () => {
        throw revoked;
      },
      async () => {},
    ),
    (error: unknown) => {
      assert.ok(error instanceof MaestroStageExecutionError);
      assert.equal(error.stageError, revoked);
      return true;
    },
  );
  assert.equal(trace.stages.length, 2, 'no further stage may drive the device');
  assert.equal(trace.reproves, 0);
  assert.deepEqual(trace.completed, [false]);
});

function runnerLog(): string {
  return [
    'Single device execution mode',
    `Building WDA for device ${EXACT} (team ID: )`,
    `Starting WDA on device ${EXACT} (port: 8447)`,
    'Flow execution completed: 1 passed, 0 failed, 0 skipped',
  ].join('\n');
}

function fakeRunnerDispatch() {
  const dispatch = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => '/usr/bin/adb',
    whichMaestro: () => '/usr/bin/maestro',
    maestroRunnerPath: () => '/fake/maestro-runner',
  });
  if ('error' in dispatch) throw new Error(dispatch.error);
  return dispatch;
}

test('GH#708: maestro_run reports a passing relaunch flow as passing', async () => {
  let reproves = 0;
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'exact',
      platform: 'ios',
      deviceId: EXACT,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => fakeRunnerDispatch(),
    parkFlow: async (run: () => Promise<unknown>) => run(),
    claimNativeOrigin: async () => {},
    completeNativeOrigin: async () => {},
    relaunchManagedApp: async () => {
      throw AUTHORITY_ERROR;
    },
    reproveManagedOrigin: async () => {
      reproves += 1;
    },
    execFile: async (_file: string, args: string[]) => {
      const dir = args[args.indexOf('--output') + 1]!;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'maestro-runner.log'), runnerLog(), 'utf8');
      writeFileSync(
        join(dir, 'report.json'),
        JSON.stringify({
          device: { id: EXACT, platform: 'ios' },
          flows: [{ device: { id: EXACT, platform: 'ios' } }],
        }),
        'utf8',
      );
      return { stdout: runnerLog(), stderr: '' };
    },
  });

  const result = await handler({
    inlineYaml: RELAUNCH_FLOW,
    platform: 'ios',
    appId: APP_ID,
    deviceId: EXACT,
  });
  const envelope = JSON.parse(result.content?.[0]?.text ?? '{}');

  assert.equal(envelope.ok, true, `expected a passing run, got: ${JSON.stringify(envelope)}`);
  assert.equal(envelope.data.passed, true);
  assert.equal(reproves, 1);
});
