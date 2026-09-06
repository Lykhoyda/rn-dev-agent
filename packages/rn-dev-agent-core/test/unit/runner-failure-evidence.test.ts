import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureRunnerFailure,
  collectRunnerFailureEvidence,
  createRunnerFailureEvidence,
} from '../../dist/domain/runner-failure-evidence.js';
import { runnerReportFingerprint } from '../../dist/domain/maestro-runner-report.js';
import { createMaestroRunHandler } from '../../dist/tools/maestro-run.js';
import { createLoginPrologueHandler } from '../../dist/tools/login-prologue.js';
import {
  _resetEngineStatusForTest,
  _setEngineStatusForTest,
  buildReplayEngineStatus,
  MAESTRO_RUNNER_PIN,
} from '../../dist/domain/engine-pin.js';
import {
  createPinnedRunActionHandler,
  createTmpProject,
  fixtureYaml,
} from '../helpers/tmp-project.js';

const SECRET = 'synthetic-login-017@example.invalid 739162';
const termination = {
  exitCode: 1,
  signal: null,
  timedOut: false,
  outputTruncated: false,
  bootstrapFailure: false,
  transportFailure: false,
};
function report(dir: string, count = 2) {
  mkdirSync(join(dir, 'flows'), { recursive: true });
  writeFileSync(
    join(dir, 'report.json'),
    JSON.stringify({
      status: 'failed',
      flows: [
        {
          status: 'failed',
          dataFile: 'flows/flow.json',
          commands: {
            total: count,
            passed: count - 1,
            failed: 1,
            skipped: 0,
            pending: 0,
            running: 0,
          },
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, 'flows/flow.json'),
    JSON.stringify({
      commands: Array.from({ length: count }, (_, index) => ({
        index,
        type: SECRET,
        status: index === count - 1 ? 'failed' : 'passed',
        error: { message: SECRET },
      })),
    }),
  );
  writeFileSync(join(dir, 'failure.png'), SECRET);
}
function capture(dir: string | null, previous = {}) {
  const evidence = createRunnerFailureEvidence();
  captureRunnerFailure(evidence, dir, previous, 0, 1, termination);
  assert.equal(JSON.stringify(evidence).includes(SECRET), false);
  return evidence;
}

beforeEach(() =>
  _setEngineStatusForTest(buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false)),
);
afterEach(() => _resetEngineStatusForTest());

test('projection bounds rows, preserves the late failed index and excludes arbitrary fields and images', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'failure-projection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  report(dir, 100);
  const original = readFileSync(join(dir, 'flows/flow.json'));
  const evidence = capture(dir);
  assert.equal(evidence.captures[0].report, 'finalized');
  assert.equal(evidence.captures[0].commands.length, 64);
  assert.deepEqual(evidence.captures[0].commands[0], {
    index: 99,
    status: 'failed',
    errorPresent: true,
  });
  assert.equal(evidence.captures[0].rowsTruncated, true);
  assert.deepEqual(readFileSync(join(dir, 'flows/flow.json')), original);
  assert.equal(capture(dir, runnerReportFingerprint(dir)).captures[0].report, 'missing');
  const merged = createRunnerFailureEvidence();
  for (let i = 0; i < 10; i++) {
    collectRunnerFailureEvidence(merged, {
      ...evidence,
      captures: [
        {
          ...evidence.captures[0],
          invocation: i,
          unsafe: SECRET,
          commands: [{ index: 1, status: SECRET, error: SECRET }],
        },
      ],
    });
  }
  assert.equal(merged.captures.length, 8);
  assert.deepEqual(
    merged.captures.map((row) => row.invocation),
    [0, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.equal(merged.capturesTruncated, true);
  assert.equal(JSON.stringify(merged).includes(SECRET), false);
});

for (const condition of ['missing', 'malformed', 'oversized', 'partial', 'symlink'] as const) {
  test(`projection discloses ${condition} report without admitting unsafe evidence`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'failure-projection-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    report(dir);
    const path = join(dir, 'report.json');
    if (condition === 'missing') rmSync(path);
    if (condition === 'malformed') writeFileSync(path, '{');
    if (condition === 'oversized') writeFileSync(path, ' '.repeat(256 * 1024 + 1));
    if (condition === 'partial') {
      rmSync(join(dir, 'flows/flow.json'));
      mkdirSync(join(dir, 'flows/flow.json'));
    }
    if (condition === 'symlink') {
      rmSync(path);
      symlinkSync(join(dir, 'failure.png'), path);
    }
    const expected = {
      missing: 'missing',
      malformed: 'unfinalized',
      oversized: 'oversized',
      partial: 'unavailable',
      symlink: 'unavailable',
    }[condition];
    const evidence = capture(dir);
    assert.equal(evidence.captures[0].report, expected);
    assert.deepEqual(evidence.captures[0].commands, []);
    assert.equal(evidence.incomplete, true);
  });
}

const SERIAL = 'emulator-5580';
const APP_ID = 'dev.example.retention';
function handler(
  execFile: NonNullable<Parameters<typeof createMaestroRunHandler>[0]>['execFile'],
  releaseAndroidSlot?: NonNullable<
    Parameters<typeof createMaestroRunHandler>[0]
  >['releaseAndroidSlot'],
) {
  return createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'retention',
      platform: 'android',
      deviceId: SERIAL,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => ({
      runner: 'maestro-runner',
      binPath: '/test/maestro-runner',
      buildArgs: (_platform, flowFile) => ['test', flowFile],
    }),
    parkFlow: async (run) => run(),
    claimNativeOrigin: async () => {},
    completeNativeOrigin: async () => {},
    relaunchManagedApp: async () => {},
    reproveManagedOrigin: async () => {},
    fastHealthCheck: async () => false,
    execFile,
    releaseAndroidSlot,
  });
}
const runArgs = { inlineYaml: '- launchApp', platform: 'android' as const, appId: APP_ID };

for (const condition of ['failure', 'timeout', 'spawn'] as const) {
  test(`public maestro_run retains ${condition} evidence before cleanup and separates runs`, async () => {
    let reportDir = '';
    let executions = 0;
    const run = handler(async (_file, args, options) => {
      executions++;
      assert.equal(options.maxBuffer, 10 * 1024 * 1024);
      reportDir = args[args.indexOf('--output') + 1];
      if (condition !== 'spawn') report(reportDir, 100);
      throw Object.assign(new Error('runner failed'), {
        stdout: 'x'.repeat(5000),
        stderr: 'Error: Element not found',
        code: condition === 'timeout' ? 'ETIMEDOUT' : condition === 'spawn' ? 'ENOENT' : 1,
      });
    });
    for (let i = 0; i < 2; i++) {
      const body = JSON.parse((await run(runArgs)).content[0].text);
      assert.equal(body.ok, false);
      assert.equal(body.meta.runnerFailureEvidence.captures.length, 1);
      const row = body.meta.runnerFailureEvidence.captures[0];
      assert.equal(row.invocation, 1);
      assert.equal(row.timedOut, condition === 'timeout');
      assert.equal(row.report, condition === 'spawn' ? 'missing' : 'finalized');
      if (condition !== 'spawn') assert.equal(row.commands[0].index, 99);
      assert.equal(existsSync(reportDir), false);
    }
    assert.equal(executions, 2, 'diagnostic capture causes no retry');
  });
}

test('allowed Android recovery cannot overwrite the retained first failure', async () => {
  let count = 0;
  let reportDir = '';
  let releases = 0;
  const run = handler(
    async (_file, args) => {
      count++;
      reportDir = args[args.indexOf('--output') + 1];
      if (count === 1) {
        report(reportDir, 3);
        throw Object.assign(new Error('runner failed'), {
          code: 1,
          stdout: '',
          stderr:
            'Error: failed to create driver: create session: session not created: java.lang.IllegalStateException: UiAutomation not connected, UiAutomation@6baa57c[id=-1, displayId=0, flags=0]',
        });
      }
      report(reportDir, 5);
      return {
        stdout: `Connecting to Android device: ${SERIAL}\nFlow execution completed: 1 passed, 0 failed, 0 skipped`,
        stderr: '',
      };
    },
    async () => {
      releases++;
      return { warnings: [] };
    },
  );
  const body = JSON.parse((await run(runArgs)).content[0].text);
  assert.equal(body.ok, true);
  assert.equal(count, 2);
  assert.equal(releases, 1);
  assert.equal(body.meta.runnerFailureEvidence.captures[0].commands[0].index, 2);
  assert.equal(body.meta.runnerFailureEvidence.captures.length, 1);
  assert.equal(existsSync(reportDir), false);
});

test('login prologue forwards safe action evidence persisted on distinct existing RunRecords', async (t) => {
  const project = createTmpProject();
  t.after(() => project.cleanup());
  project.seedAction('user-login', fixtureYaml({ id: 'user-login' }), null);
  const evidence = capture(null);
  let repairs = 0;
  const runAction = createPinnedRunActionHandler({
    maestroRun: async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: 'runner failure',
            meta: {
              output: 'Error: Element not found',
              runnerFailureEvidence: { ...evidence, unsafe: SECRET },
            },
          }),
        },
      ],
      isError: true,
    }),
    repairAction: async () => {
      repairs++;
      throw new Error('repair forbidden');
    },
  });
  const prologue = createLoginPrologueHandler({ runAction });
  for (let i = 0; i < 2; i++) {
    const body = JSON.parse(
      (await prologue({ projectRoot: realpathSync(project.root) })).content[0].text,
    );
    assert.equal(body.ok, false);
    assert.equal(body.meta.internalError, undefined, body.error);
    assert.equal(typeof body.meta.strictRunRecordId, 'string');
    assert.deepEqual(body.meta.runnerFailureEvidence, evidence);
  }
  const runs = project.readSidecar('user-login').runHistory;
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0].runId, runs[1].runId);
  assert.deepEqual(runs[0].runnerFailureEvidence, evidence);
  assert.equal(JSON.stringify(runs).includes(SECRET), false);
  assert.equal(repairs, 0);
});
