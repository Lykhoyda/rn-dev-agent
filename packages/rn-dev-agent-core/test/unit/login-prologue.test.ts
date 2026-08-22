import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ACTION_LOGIN_HELPER,
  evaluateLoginPrologueGuard,
  LOGIN_PROLOGUE_BLOCKED,
} from '../../dist/domain/login-prologue.js';
import { createLoginPrologueHandler } from '../../dist/tools/login-prologue.js';
import { failResult, okResult } from '../../dist/utils.js';
import { appendRunRecordToSidecar } from '../helpers/action-state.ts';
import {
  createPinnedRunActionHandler,
  createTmpProject,
  fixtureYaml,
} from '../helpers/tmp-project.js';

function parse(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

function deterministicClock() {
  let nowMs = Date.parse('2026-08-21T10:00:00.000Z');
  return () => {
    const value = new Date(nowMs);
    nowMs += 10;
    return value;
  };
}

function seedLoginAction(project: ReturnType<typeof createTmpProject>) {
  project.seedAction(
    'user-login',
    fixtureYaml({ id: 'user-login', intent: 'restore an authenticated fixture state' }),
    null,
  );
}

test('login prologue resolves the exact alias and requires a fresh passing RunRecord twice', async (t) => {
  const project = createTmpProject();
  t.after(() => project.cleanup());
  seedLoginAction(project);
  let runNumber = 0;
  const seenArgs: Array<Record<string, unknown>> = [];
  const handler = createLoginPrologueHandler({
    now: deterministicClock(),
    runAction: async (args) => {
      runNumber += 1;
      seenArgs.push({ ...args });
      appendRunRecordToSidecar(project.root, 'user-login', {
        runId: `login-run-${runNumber}`,
        timestamp: `2026-08-21T10:00:0${runNumber}.000Z`,
        durationMs: 125,
        status: 'pass',
        trigger: 'agent',
        timing: {
          startedAt: `2026-08-21T10:00:0${runNumber}.000Z`,
          endedAt: `2026-08-21T10:00:0${runNumber}.125Z`,
          elapsedMs: 125,
          steps: [],
        },
      });
      return okResult({
        passed: true,
        strictRunRecordId: `login-run-${runNumber}`,
        transport: 'maestro',
        transportVersion: '1.0.9',
        perStepReadback: { complete: true, steps: [] },
      });
    },
  });

  for (const expectedRunId of ['login-run-1', 'login-run-2']) {
    const envelope = parse(await handler({ projectRoot: project.root }));
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.state, 'passed');
    assert.equal(envelope.data.role, ACTION_LOGIN_HELPER);
    assert.equal(envelope.data.actionId, 'user-login');
    assert.equal(envelope.data.runRecord.runId, expectedRunId);
    assert.deepEqual(
      envelope.data.steps.map((step: { name: string }) => step.name),
      ['inventory', 'resolve', 'replay', 'verify-run-record'],
    );
    for (const step of envelope.data.steps) {
      assert.equal(step.elapsedMs, Date.parse(step.endedAt) - Date.parse(step.startedAt));
      assert.ok(step.elapsedMs >= 0);
    }
    assert.equal(
      envelope.data.elapsedMs,
      Date.parse(envelope.data.endedAt) - Date.parse(envelope.data.startedAt),
    );
  }

  assert.deepEqual(
    seenArgs.map(({ actionId, autoRepair, forceReload, proofReplay, blindProbeMode, trigger }) => ({
      actionId,
      autoRepair,
      forceReload,
      proofReplay,
      blindProbeMode,
      trigger,
    })),
    [1, 2].map(() => ({
      actionId: 'user-login',
      autoRepair: false,
      forceReload: false,
      proofReplay: false,
      blindProbeMode: 'forbid',
      trigger: 'agent',
    })),
  );
});

test('login prologue preserves non-enumerable replay authority', async (t) => {
  const project = createTmpProject();
  t.after(() => project.cleanup());
  seedLoginAction(project);
  const authority = Symbol('replay-authority');
  const args = { projectRoot: project.root };
  Object.defineProperty(args, authority, { value: 'retained' });
  const handler = createLoginPrologueHandler({
    now: deterministicClock(),
    runAction: async (replayArgs) => {
      assert.equal((replayArgs as Record<symbol, unknown>)[authority], 'retained');
      appendRunRecordToSidecar(project.root, 'user-login', {
        runId: 'login-run-authoritative',
        timestamp: '2026-08-21T10:00:01.000Z',
        durationMs: 125,
        status: 'pass',
        trigger: 'agent',
      });
      return okResult({
        passed: true,
        strictRunRecordId: 'login-run-authoritative',
        transport: 'maestro',
      });
    },
  });

  const envelope = parse(await handler(args));
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.runRecord.runId, 'login-run-authoritative');
});

test('login prologue seals selector replay against every CDP fallback', async (t) => {
  const project = createTmpProject();
  t.after(() => project.cleanup());
  seedLoginAction(project);
  let replayDepsCalled = false;
  const runAction = createPinnedRunActionHandler({
    maestroRun: async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            data: {
              passed: false,
              output: "Element with id 'fab-create-task' not found",
              flowFile: 'user-login.yaml',
              platform: 'ios',
            },
          }),
        },
      ],
      isError: true,
    }),
    replayDeps: () => {
      replayDepsCalled = true;
      return {
        treeFor: async () => ({ testID: 'fab-create-task', children: [] }),
        pressByTestId: async () => {},
        typeByTestId: async () => {},
        launchApp: async () => {},
        settle: async () => {},
      };
    },
  });
  const handler = createLoginPrologueHandler({ now: deterministicClock(), runAction });

  const envelope = parse(await handler({ projectRoot: project.root }));

  assert.equal(envelope.code, 'LOGIN_PROLOGUE_BLOCKED');
  assert.equal(envelope.meta.loginPrologue.failure.code, 'TESTID_NOT_FOUND');
  assert.equal(replayDepsCalled, false);
});

test('login prologue rejects a passing result from a divergent runner pin', async (t) => {
  const project = createTmpProject();
  t.after(() => project.cleanup());
  seedLoginAction(project);
  const runAction = createPinnedRunActionHandler({
    maestroRun: async () =>
      okResult({
        passed: true,
        enginePin: { pinned: '1.0.9', status: 'checksum-mismatch' },
        transport: 'maestro-runner',
      }),
  });
  const handler = createLoginPrologueHandler({ now: deterministicClock(), runAction });

  const envelope = parse(await handler({ projectRoot: project.root }));

  assert.equal(envelope.code, 'LOGIN_PROLOGUE_BLOCKED');
  assert.equal(envelope.meta.loginPrologue.failure.code, 'ENGINE_PIN_MISMATCH');
  assert.equal(project.readSidecar('user-login').runHistory.at(-1).status, 'fail');
});

test('login prologue requires the strict executor persisted run identity', async (t) => {
  const project = createTmpProject();
  t.after(() => project.cleanup());
  seedLoginAction(project);
  const handler = createLoginPrologueHandler({
    now: deterministicClock(),
    runAction: async () => {
      appendRunRecordToSidecar(project.root, 'user-login', {
        runId: 'concurrent-login-run',
        timestamp: '2026-08-21T10:00:01.000Z',
        durationMs: 125,
        status: 'pass',
        trigger: 'agent',
      });
      return okResult({
        passed: true,
        strictRunRecordId: 'uncommitted-attempt-run',
        transport: 'maestro',
      });
    },
  });

  const envelope = parse(await handler({ projectRoot: project.root }));

  assert.equal(envelope.code, 'LOGIN_PROLOGUE_BLOCKED');
  assert.equal(envelope.meta.loginPrologue.failure.code, 'AUTHORITATIVE_RUN_RECORD_MISSING');
});

test('strict replay refuses success when RunRecord persistence is not committed', async (t) => {
  const project = createTmpProject();
  t.after(() => project.cleanup());
  seedLoginAction(project);
  const runAction = createPinnedRunActionHandler({
    maestroRun: async () => {
      writeFileSync(project.sidecarPath('user-login'), '{invalid-sidecar', 'utf8');
      return okResult({ passed: true, transport: 'maestro-runner' });
    },
  });
  const handler = createLoginPrologueHandler({ now: deterministicClock(), runAction });

  const envelope = parse(await handler({ projectRoot: project.root }));

  assert.equal(envelope.code, 'LOGIN_PROLOGUE_BLOCKED');
  assert.equal(envelope.meta.loginPrologue.failure.code, 'LOAD_FAILED');
});

test('login prologue preserves timeout classification from replay metadata', async (t) => {
  const project = createTmpProject();
  t.after(() => project.cleanup());
  seedLoginAction(project);
  const handler = createLoginPrologueHandler({
    now: deterministicClock(),
    runAction: async () => failResult('timed out', { failureKind: 'TIMEOUT' }),
  });

  const envelope = parse(await handler({ projectRoot: project.root }));

  assert.equal(envelope.code, 'LOGIN_PROLOGUE_BLOCKED');
  assert.equal(envelope.meta.loginPrologue.failure.code, 'TIMEOUT');
});

test('login prologue blocks when the exact user-login action is missing', async (t) => {
  const project = createTmpProject();
  t.after(() => project.cleanup());
  project.seedAction('similar-login', fixtureYaml({ id: 'similar-login', tags: ['auth'] }), null);
  let dispatched = false;
  const handler = createLoginPrologueHandler({
    now: deterministicClock(),
    runAction: async () => {
      dispatched = true;
      return okResult({ passed: true });
    },
  });

  const envelope = parse(await handler({ projectRoot: project.root }));
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'LOGIN_PROLOGUE_BLOCKED');
  assert.equal(envelope.meta.loginPrologue.failure.code, 'LOGIN_ACTION_MISSING');
  assert.equal(dispatched, false);
});

test('login prologue rejects a filename and metadata id mismatch', async (t) => {
  const project = createTmpProject();
  t.after(() => project.cleanup());
  project.seedAction(
    'user-login',
    fixtureYaml({ id: 'other-login', intent: 'wrong action identity' }),
    null,
  );
  project.seedAction(
    'decoy-login',
    fixtureYaml({ id: 'user-login', intent: 'inventory identity decoy' }),
    null,
  );
  let dispatched = false;
  const handler = createLoginPrologueHandler({
    now: deterministicClock(),
    runAction: async () => {
      dispatched = true;
      return okResult({ passed: true });
    },
  });

  const envelope = parse(await handler({ projectRoot: project.root }));
  assert.equal(envelope.code, 'LOGIN_PROLOGUE_BLOCKED');
  assert.equal(envelope.meta.loginPrologue.failure.code, 'LOGIN_ACTION_ID_MISMATCH');
  assert.equal(dispatched, false);
});

for (const failure of [
  { name: 'runner drift', code: 'ENGINE_PIN_MISMATCH' },
  { name: 'selector failure', code: 'TESTID_NOT_FOUND' },
  { name: 'timeout', code: 'RECONNECT_TIMEOUT' },
]) {
  test(`login prologue terminally blocks on ${failure.name}`, async (t) => {
    const project = createTmpProject();
    t.after(() => project.cleanup());
    seedLoginAction(project);
    const handler = createLoginPrologueHandler({
      now: deterministicClock(),
      runAction: async (args) => {
        appendRunRecordToSidecar(project.root, 'user-login', {
          runId: `failed-${failure.code}`,
          timestamp: '2026-08-21T10:00:01.000Z',
          durationMs: 25,
          status: 'fail',
          failureCode: failure.code === 'TESTID_NOT_FOUND' ? 'SELECTOR_NOT_FOUND' : 'TIMEOUT',
          trigger: args.trigger ?? 'agent',
        });
        return failResult(`injected ${failure.name}`, failure.code as 'ENGINE_PIN_MISMATCH', {
          strictRunRecordId: `failed-${failure.code}`,
        });
      },
    });

    const envelope = parse(await handler({ projectRoot: project.root }));
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'LOGIN_PROLOGUE_BLOCKED');
    assert.equal(envelope.meta.loginPrologue.state, 'LOGIN_PROLOGUE_BLOCKED');
    assert.equal(envelope.meta.loginPrologue.failure.code, failure.code);
    assert.equal(envelope.meta.loginPrologue.runRecord.status, 'fail');
    assert.ok(envelope.meta.loginPrologue.elapsedMs < 1_000);
  });
}

test('login prologue rejects transport success without a fresh passing RunRecord', async (t) => {
  const project = createTmpProject();
  t.after(() => project.cleanup());
  seedLoginAction(project);
  const handler = createLoginPrologueHandler({
    now: deterministicClock(),
    runAction: async () => okResult({ passed: true, transport: 'maestro' }),
  });

  const envelope = parse(await handler({ projectRoot: project.root }));
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'LOGIN_PROLOGUE_BLOCKED');
  assert.equal(envelope.meta.loginPrologue.failure.code, 'AUTHORITATIVE_RUN_RECORD_MISSING');
});

function blockedBinding() {
  return {
    schemaVersion: 1,
    state: LOGIN_PROLOGUE_BLOCKED,
    role: ACTION_LOGIN_HELPER,
    alias: 'user-login',
    startedAt: '2026-08-21T10:00:00.000Z',
    endedAt: '2026-08-21T10:00:00.100Z',
    elapsedMs: 100,
    steps: [],
    inventory: { count: 1, actionIds: ['user-login'] },
    failure: { code: 'ENGINE_PIN_MISMATCH', detail: 'runner drift' },
  };
}

test('blocked helper still allows locked e2e proof without a supervisor override', () => {
  const binding = blockedBinding();
  for (const [tool, args] of [
    ['cdp_lock_e2e_test', { actionId: 'user-login' }],
    ['cdp_run_e2e_suite', { pattern: '.*' }],
  ] as const) {
    const decision = evaluateLoginPrologueGuard({
      binding,
      tool,
      args,
      mutation: true,
      ...(tool === 'cdp_run_e2e_suite' ? { resolvedLockedTestIds: ['user-login'] } : {}),
    });
    assert.deepEqual(decision, { allowed: true, override: false }, tool);
  }
});

test('blocked helper refuses locked e2e requests outside the exact login candidate', () => {
  const binding = blockedBinding();
  for (const [tool, args] of [
    ['cdp_lock_e2e_test', { actionId: 'other-login' }],
    ['cdp_run_e2e_suite', {}],
    ['cdp_run_e2e_suite', { pattern: 'user-login' }],
    ['cdp_run_e2e_suite', { pattern: '^user-login$|^other-login$' }],
  ] as const) {
    const decision = evaluateLoginPrologueGuard({
      binding,
      tool,
      args,
      mutation: true,
    });
    assert.deepEqual(decision, { allowed: false, suppliedOverride: false }, tool);
  }
});

test('blocked helper requires case-sensitive exact resolved locked e2e ids', () => {
  const binding = blockedBinding();
  for (const resolvedLockedTestIds of [
    [],
    ['USER-LOGIN'],
    ['user-login', 'USER-LOGIN'],
    ['user-login', 'other-login'],
  ]) {
    const decision = evaluateLoginPrologueGuard({
      binding,
      tool: 'cdp_run_e2e_suite',
      args: { pattern: '^user-login$' },
      mutation: true,
      resolvedLockedTestIds,
    });
    assert.deepEqual(decision, { allowed: false, suppliedOverride: false });
  }
});

test('blocked helper still refuses credential and ad-hoc login mutations', () => {
  const binding = blockedBinding();
  for (const [tool, args] of [
    ['device_fill', { text: 'secret' }],
    ['cdp_evaluate', { expression: 'credential()' }],
    ['cdp_interact', { action: 'press', testID: 'submit' }],
    ['maestro_run', { yaml: '- tapOn: Login' }],
  ]) {
    const decision = evaluateLoginPrologueGuard({
      binding,
      tool,
      args,
      mutation: true,
    });
    assert.deepEqual(decision, { allowed: false, suppliedOverride: false }, tool);
  }
});

test('login prologue does not freeze or rewrite locked e2e artifacts', async (t) => {
  const project = createTmpProject();
  t.after(() => project.cleanup());
  seedLoginAction(project);
  const e2eDir = join(project.root, '.rn-agent', 'e2e');
  mkdirSync(e2eDir, { recursive: true });
  const frozenPath = join(e2eDir, 'user-login.yaml');
  writeFileSync(frozenPath, 'frozen-login-proof: true\n', 'utf8');
  const handler = createLoginPrologueHandler({
    now: deterministicClock(),
    runAction: async () => {
      appendRunRecordToSidecar(project.root, 'user-login', {
        runId: 'login-run-helper',
        timestamp: '2026-08-21T10:00:01.000Z',
        durationMs: 125,
        status: 'pass',
        trigger: 'agent',
      });
      return okResult({
        passed: true,
        strictRunRecordId: 'login-run-helper',
        transport: 'maestro',
      });
    },
  });

  const envelope = parse(await handler({ projectRoot: project.root }));
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.role, ACTION_LOGIN_HELPER);
  assert.equal(readFileSync(frozenPath, 'utf8'), 'frozen-login-proof: true\n');
});
