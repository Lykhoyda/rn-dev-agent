import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLoginPrologueHandler } from '../../dist/tools/login-prologue.js';
import { failResult, okResult } from '../../dist/utils.js';
import { appendRunRecordToSidecar } from '../helpers/action-state.ts';
import { createTmpProject, fixtureYaml } from '../helpers/tmp-project.js';

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
        return failResult(`injected ${failure.name}`, failure.code as 'ENGINE_PIN_MISMATCH');
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
