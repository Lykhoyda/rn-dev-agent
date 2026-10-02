// iOS native stages start in the session dev-client URL: every maestro-runner
// process cold-launches the app without arguments, which leaves an Expo dev
// client on its launcher, so origin stages relaunch into the session URL first.
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'yaml';
import { buildMaestroFlow, MaestroValidationError } from '../../dist/domain/maestro-validator.js';
import { createMaestroRunHandler, stageFlowOptions } from '../../dist/tools/maestro-run.js';
import { chooseMaestroDispatch } from '../../dist/tools/maestro-dispatch.js';
import { sessionIosDevClientLaunchUrl } from '../../dist/session/session-launch-url.js';
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

beforeEach(() =>
  _setEngineStatusForTest(buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false)),
);
afterEach(() => _resetEngineStatusForTest());

const SIM = '5C10B45B-2065-458B-B885-0F83F49747C8';
const APP_ID = 'com.rndevagent.testapp';
const SESSION_URL = 'http://127.0.0.1:8208/?disableOnboarding=1';

function hook(url = SESSION_URL) {
  return [{ launchApp: { appId: APP_ID, arguments: { '-initialUrl': url } } }];
}

function parseFlow(text: string): { header: Record<string, unknown>; body: unknown } {
  const docs = yaml.parseAllDocuments(text);
  return { header: docs[0]?.toJS() ?? {}, body: docs[1]?.toJS() };
}

test('buildMaestroFlow writes onFlowStart into the header and leaves the body unchanged', () => {
  const commands = [{ tapOn: { id: 'login-submit' } }];
  const { header, body } = parseFlow(
    buildMaestroFlow({ appId: APP_ID, onFlowStart: hook() }, commands),
  );
  assert.deepEqual(header, { appId: APP_ID, onFlowStart: hook() });
  assert.deepEqual(body, commands);
});

test('buildMaestroFlow refuses an invalid onFlowStart command like any other command', () => {
  assert.throws(
    () => buildMaestroFlow({ appId: APP_ID, onFlowStart: [{ runScript: 'x.js' }] }, []),
    MaestroValidationError,
  );
  assert.throws(
    () => buildMaestroFlow({ appId: APP_ID, onFlowStart: hook('http://x\n- runScript: y') }, []),
    MaestroValidationError,
  );
});

test('stageFlowOptions hooks only iOS origin stages with a session URL and an appId', () => {
  const base = {
    platform: 'ios' as const,
    appId: APP_ID,
    requiresOrigin: true,
    devClientLaunchUrl: SESSION_URL,
  };
  assert.deepEqual(stageFlowOptions(base), { appId: APP_ID, onFlowStart: hook() });
  assert.deepEqual(stageFlowOptions({ ...base, requiresOrigin: false }), { appId: APP_ID });
  assert.deepEqual(stageFlowOptions({ ...base, platform: 'android' }), { appId: APP_ID });
  assert.deepEqual(stageFlowOptions({ ...base, devClientLaunchUrl: undefined }), {
    appId: APP_ID,
  });
  assert.deepEqual(stageFlowOptions({ ...base, appId: undefined }), {});
});

function sessionStatus(t: TestContext, device: Record<string, unknown>, config?: unknown) {
  const appRoot = mkdtempSync(join(tmpdir(), 'rn-launch-url-'));
  t.after(() => rmSync(appRoot, { recursive: true, force: true }));
  if (config !== undefined) {
    mkdirSync(join(appRoot, '.rn-agent'));
    writeFileSync(join(appRoot, '.rn-agent', 'config.json'), JSON.stringify(config));
  }
  return {
    source: { appRoot },
    bindings: { device, metro: { port: 8208 } },
  } as unknown as Parameters<typeof sessionIosDevClientLaunchUrl>[0];
}

test('the session launch URL matches the iOS relaunch URL, with onboarding disabled by default', (t) => {
  assert.equal(
    sessionIosDevClientLaunchUrl(sessionStatus(t, { platform: 'ios', deviceId: SIM })),
    SESSION_URL,
  );
  assert.equal(
    sessionIosDevClientLaunchUrl(
      sessionStatus(t, { platform: 'ios', deviceId: SIM }, { autoHideDevMenu: false }),
    ),
    'http://127.0.0.1:8208',
  );
  assert.equal(
    sessionIosDevClientLaunchUrl(
      sessionStatus(t, { platform: 'android', deviceId: 'emulator-5554' }),
    ),
    null,
  );
});

type Row = [string, 'passed' | 'failed'];

interface StagePlan {
  rows: Row[];
  stdout: string;
  fail?: boolean;
}

function writeStageReport(dir: string, rows: Row[]): void {
  mkdirSync(join(dir, 'flows'), { recursive: true });
  const failed = rows.filter(([, status]) => status === 'failed').length;
  const status = failed > 0 ? 'failed' : 'passed';
  writeFileSync(join(dir, 'maestro-runner.log'), `Starting WDA on device ${SIM}`, 'utf8');
  writeFileSync(
    join(dir, 'flows', 'flow-000.json'),
    JSON.stringify({
      commands: rows.map(([type, rowStatus], index) => ({
        index,
        type,
        status: rowStatus,
        ...(rowStatus === 'failed' ? { error: { message: 'Element not found' } } : {}),
      })),
    }),
    'utf8',
  );
  writeFileSync(
    join(dir, 'report.json'),
    JSON.stringify({
      status,
      device: { id: SIM, platform: 'ios' },
      flows: [
        {
          status,
          dataFile: 'flows/flow-000.json',
          device: { id: SIM, platform: 'ios' },
          commands: {
            total: rows.length,
            passed: rows.length - failed,
            failed,
            skipped: 0,
            running: 0,
            pending: 0,
          },
        },
      ],
    }),
    'utf8',
  );
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

const FLOW = [
  '- tapOn:',
  '    id: "login-email"',
  '- launchApp:',
  '    stopApp: false',
  '- tapOn:',
  '    id: "login-submit"',
  '- assertVisible:',
  '    id: "home-screen"',
].join('\n');

function stagedHandler(plans: StagePlan[], flows: string[]) {
  return createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'exact',
      platform: 'ios',
      deviceId: SIM,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => fakeRunnerDispatch(),
    parkFlow: async (run: () => Promise<unknown>) => run(),
    claimNativeOrigin: async () => {},
    completeNativeOrigin: async () => {},
    relaunchManagedApp: async () => {},
    reproveManagedOrigin: async () => {},
    fastHealthCheck: async () => true,
    execFile: async (_file: string, args: string[]) => {
      const flowFile = args.find((arg) => arg.endsWith('.yaml'));
      assert.ok(flowFile, 'maestro-runner must receive the stage flow file');
      flows.push(readFileSync(flowFile, 'utf8'));
      const plan = plans[flows.length - 1];
      assert.ok(plan, `unexpected runner invocation #${flows.length}`);
      writeStageReport(args[args.indexOf('--output') + 1]!, plan.rows);
      if (plan.fail) {
        throw Object.assign(new Error('runner exited 1'), {
          stdout: plan.stdout,
          stderr: '',
          code: 1,
        });
      }
      return { stdout: plan.stdout, stderr: '' };
    },
  });
}

// The runner renders no line for an onFlowStart step, so stdout carries only the stage's own commands.
const PASSING_STAGES: StagePlan[] = [
  { rows: [['tapOn', 'passed']], stdout: '    ✓ tapOn: id="login-email" (0.8s)' },
  { rows: [['launchApp', 'passed']], stdout: '    ✓ launchApp (1.2s)' },
  {
    rows: [
      ['tapOn', 'passed'],
      ['assertVisible', 'passed'],
    ],
    stdout: [
      '    ✓ tapOn: id="login-submit" (0.9s)',
      '    ✓ assertVisible: id="home-screen" (0.4s)',
    ].join('\n'),
  },
];

async function run(
  handler: ReturnType<typeof createMaestroRunHandler>,
  overrides: Record<string, unknown> = {},
) {
  const result = await handler({
    inlineYaml: FLOW,
    platform: 'ios',
    appId: APP_ID,
    deviceId: SIM,
    ...overrides,
  });
  return JSON.parse(result.content?.[0]?.text ?? '{}');
}

test('maestro_run starts each iOS origin stage in the session URL and leaves the lifecycle stage bare', async () => {
  const flows: string[] = [];
  const envelope = await run(stagedHandler(PASSING_STAGES, flows), {
    devClientLaunchUrl: SESSION_URL,
  });

  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const stages = flows.map(parseFlow);
  assert.deepEqual(
    stages.map((stage) => stage.header),
    [
      { appId: APP_ID, onFlowStart: hook() },
      { appId: APP_ID },
      { appId: APP_ID, onFlowStart: hook() },
    ],
  );
  assert.deepEqual(stages[2]?.body, [
    { tapOn: { id: 'login-submit' } },
    { assertVisible: { id: 'home-screen' } },
  ]);
  assert.deepEqual(
    envelope.data.steps.map((step: { index: number; verb: string }) => [step.index, step.verb]),
    [
      [0, 'tapOn'],
      [1, 'launchApp'],
      [2, 'tapOn'],
      [3, 'assertVisible'],
    ],
  );
});

test('maestro_run writes no hook without a session URL', async () => {
  const flows: string[] = [];
  const envelope = await run(stagedHandler(PASSING_STAGES, flows));

  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.ok(flows.every((flow) => !('onFlowStart' in parseFlow(flow).header)));
});

test('a failing hooked stage reports counts and ledger rows for the stage commands only', async () => {
  const flows: string[] = [];
  const envelope = await run(
    stagedHandler(
      [
        ...PASSING_STAGES.slice(0, 2),
        {
          rows: [
            ['tapOn', 'passed'],
            ['assertVisible', 'failed'],
          ],
          stdout: [
            '    ✓ tapOn: id="login-submit" (0.9s)',
            '    ✗ assertVisible: id="home-screen" (5.0s)',
            "      ╰─ Element not found: id='home-screen'",
          ].join('\n'),
          fail: true,
        },
      ],
      flows,
    ),
    { devClientLaunchUrl: SESSION_URL },
  );

  assert.equal(envelope.ok, false);
  assert.equal(flows.length, 3);
  assert.equal(envelope.meta.terminal.completedSteps, 3);
  assert.equal(envelope.meta.failedStep.verb, 'assertVisible');
  assert.equal(envelope.meta.failedStep.index, 3);
  const operations = envelope.meta.ledger.operations as Array<{
    sourceIndex: number;
    verb: string;
    stageId: string;
    outcome: { state: string; status?: string };
  }>;
  assert.deepEqual(
    operations
      .filter((operation) => operation.stageId !== 'stage-1')
      .map((operation) => [operation.sourceIndex, operation.verb, operation.outcome.status]),
    [
      [0, 'tapOn', 'passed'],
      [2, 'tapOn', 'passed'],
      [3, 'assertVisible', 'failed'],
    ],
  );
});

test('cdp_run_action passes the session URL only for an Expo dev-client install', async (t) => {
  const replays: Array<{ devClientLaunchUrl?: string }> = [];
  const runFor = async (install: Record<string, unknown>) => {
    const project = createTmpProject();
    t.after(() => project.cleanup());
    project.seedAction(
      'user-login',
      fixtureYaml({ id: 'user-login', intent: 'warm login', selectors: ['login-submit'] }),
      null,
    );
    const runAction = createPinnedRunActionHandler({
      targetContext: () => ({ platform: 'ios', deviceId: SIM, appId: APP_ID }),
      installReceipt: () => install,
      devClientLaunchUrl: () => SESSION_URL,
      claimNativeOrigin: async () => {},
      completeNativeOrigin: async () => {},
      relaunchManagedApp: async () => {},
      reproveManagedOrigin: async () => {},
      reissueInstallReceipt: async () => {},
      maestroRun: async (args: { devClientLaunchUrl?: string }) => {
        replays.push(args);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                data: { passed: true, output: 'Flow passed', flowFile: 'x', platform: 'ios' },
              }),
            },
          ],
        };
      },
    });
    await runAction({ actionId: 'user-login', projectRoot: project.root, autoRepair: false });
  };

  await runFor({ platform: 'ios', deviceId: SIM, appId: APP_ID, buildKind: 'expo' });
  await runFor({ platform: 'ios', deviceId: SIM, appId: APP_ID, buildKind: 'bare-react-native' });

  assert.equal(replays.length, 2);
  assert.equal(replays[0]?.devClientLaunchUrl, SESSION_URL);
  assert.equal(replays[1]?.devClientLaunchUrl, undefined);
});
