// GH #623 — cdp_run_action integration: a ledger-qualified trailing
// verification failure stays passed:false with its existing failureKind,
// REFUSES auto-repair (no YAML rewrite for a merely-slow selector), persists
// the qualifier block on the RunRecord, and never recommends reboot/relaunch.
// Negative controls preserve today's behavior end to end.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createPinnedRunActionHandler as createRunActionHandler,
  createTmpProject,
  fixtureYaml,
} from '../helpers/tmp-project.js';

let project: ReturnType<typeof createTmpProject>;

beforeEach(() => {
  project = createTmpProject();
});

afterEach(() => {
  project.cleanup();
});

function fakeMaestroRun(envelopes: unknown[], calls: unknown[] = []) {
  let i = 0;
  return async (args: unknown) => {
    calls.push(args);
    const env = envelopes[Math.min(i, envelopes.length - 1)] as { ok?: boolean };
    i++;
    return {
      content: [{ type: 'text', text: JSON.stringify(env) }],
      ...(env.ok === false ? { isError: true } : {}),
    };
  };
}

function fakeRepairAction(envelope: unknown, calls: unknown[] = []) {
  return async (args: unknown) => {
    calls.push(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
      ...((envelope as { ok?: boolean }).ok === false ? { isError: true } : {}),
    };
  };
}

const CLEAN_TERMINATION = {
  exitCode: 1,
  signal: null,
  timedOut: false,
  outputTruncated: false,
  bootstrapFailure: false,
  transportFailure: false,
  artifactFinalized: true,
};

const RUNTIME_DEGRADED = { medianTapMs: 1800, floorMs: 1500, sampleCount: 3 };
const RUNTIME_CAVEAT =
  'RUNTIME_DEGRADED: median tapOn latency 1800ms (>= 1500ms) — runtime is slow; the goal state may have appeared after the wait — verify before rebooting.';

function qualifier(overrides: Record<string, unknown> = {}) {
  return {
    trailingVerificationOnly: true,
    mutationEvidence: 'proven',
    provenMutations: 6,
    failedVerifications: 1,
    notRunOperations: 0,
    stageTerminations: [CLEAN_TERMINATION],
    attempt: { attemptId: 'att-1', ordinal: 1, kind: 'initial' },
    ...overrides,
  };
}

// The failure envelope maestro_run emits for a trailing id-wait timeout —
// failureKind SELECTOR_NOT_FOUND per GH #580, plus the ledger qualifier and
// the verify-first (non-reboot) degraded caveat in the headline.
function trailingIdWaitEnv(trailingVerification: Record<string, unknown>) {
  return {
    ok: false,
    error:
      'Maestro flow failed at step "extendedWaitUntil: visible id=\\"home_screen\\"" (SELECTOR_NOT_FOUND: home_screen) — RUNTIME_DEGRADED: median tapOn latency 1800ms (>= 1500ms) — runtime is slow; the goal state may have appeared after the wait — verify before rebooting.',
    meta: {
      passed: false,
      output: '    ✗ extendedWaitUntil: visible id="home_screen" (30.0s)',
      terminal: {
        exitClass: 'step-failure',
        completedSteps: 6,
        failedStep: 'extendedWaitUntil: visible id="home_screen"',
        failureKind: 'SELECTOR_NOT_FOUND',
        failureSelector: 'home_screen',
      },
      trailingVerification,
      runtimeDegraded: RUNTIME_DEGRADED,
      runnerResume: { attempted: true, healthy: true },
    },
  };
}

// The real classifier binds the qualifier to the dispatched attempt, so the
// stub does the same: the qualifier's lineage is copied from args.attempt
// (never fabricated) unless a case deliberately breaks it via overrides.
function fakeTrailingMaestroRun(
  calls: Array<{ attempt?: Record<string, unknown> }>,
  overrides: Record<string, unknown> = {},
) {
  return async (args: { attempt?: Record<string, unknown> }) => {
    calls.push(args);
    const attempt = args.attempt!;
    const env = trailingIdWaitEnv(
      qualifier({
        attempt: { attemptId: attempt.attemptId, ordinal: attempt.ordinal, kind: attempt.kind },
        ...overrides,
      }),
    );
    return { content: [{ type: 'text', text: JSON.stringify(env) }], isError: true };
  };
}

const REPAIR_CALLS_FORBIDDEN = () => {
  throw new Error('cdp_repair_action must NOT be called for a trailing verification failure');
};

test('gh-623: trailing verification failure refuses repair, keeps kind, persists qualifier, no reboot advice', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo' }), null);
  const maestroCalls: Array<{ attempt?: Record<string, unknown> }> = [];
  const handler = createRunActionHandler({
    maestroRun: fakeTrailingMaestroRun(maestroCalls),
    repairAction: REPAIR_CALLS_FORBIDDEN,
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });
  const body = JSON.parse(result.content[0].text);

  assert.equal(body.ok, false, 'the goal state is unproven — never a pass');
  assert.equal(body.code, 'TESTID_NOT_FOUND', 'existing failing-step tool code preserved');
  assert.equal(body.meta.failureKind, 'SELECTOR_NOT_FOUND', 'existing failureKind preserved');
  assert.equal(body.meta.trailingVerification.trailingVerificationOnly, true);
  assert.equal(body.meta.trailingVerification.mutationEvidence, 'proven');
  assert.deepEqual(body.meta.runtimeDegraded, RUNTIME_DEGRADED);
  assert.equal(body.meta.autoRepair.attempted, false);
  assert.equal(body.meta.autoRepair.outcome, 'refused');
  assert.equal(body.meta.autoRepair.refusedReason, 'NOT_REPAIRABLE_KIND');
  assert.match(body.error, /trailing verification only/);
  assert.match(body.error, /UNPROVEN/);
  assert.match(body.error, /verify the live state/i);
  assert.ok(body.error.includes(RUNTIME_CAVEAT), body.error);
  assert.equal(body.error.split(RUNTIME_CAVEAT).length - 1, 1);
  assert.ok(!/reboot it \(xcrun simctl/.test(body.error), body.error);
  assert.ok(!/relaunch the app/.test(body.error), body.error);

  const sidecar = JSON.parse(readFileSync(project.sidecarPath('demo'), 'utf8'));
  const run = sidecar.runHistory.at(-1);
  assert.equal(run.status, 'fail');
  assert.equal(run.failureCode, 'SELECTOR_NOT_FOUND');
  // The COMPLETE qualifier block — lineage bound to the DISPATCHED attempt and
  // full termination provenance — must survive result AND persisted RunRecord.
  const dispatched = maestroCalls[0].attempt!;
  const expectedQualifier = qualifier({
    attempt: { attemptId: dispatched.attemptId, ordinal: 1, kind: 'initial' },
  });
  assert.deepEqual(run.trailingVerification, expectedQualifier);
  assert.deepEqual(body.meta.trailingVerification, expectedQualifier);
  assert.equal(run.autoRepair.outcome, 'refused');
});

test('gh-623: explicit repair opt-out keeps USER_DISABLED telemetry on a qualified failure', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo' }), null);
  const handler = createRunActionHandler({
    maestroRun: fakeTrailingMaestroRun([]),
    repairAction: REPAIR_CALLS_FORBIDDEN,
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, autoRepair: false });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.meta.autoRepair.refusedReason, 'USER_DISABLED');
  assert.equal(body.meta.trailingVerification.trailingVerificationOnly, true);
});

test('gh-623: a qualifier from an unrelated attempt is rejected — repair path runs as today', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['home_screen'] }), null);
  const repairCalls: unknown[] = [];
  const handler = createRunActionHandler({
    maestroRun: fakeTrailingMaestroRun([], {
      attempt: { attemptId: 'not-the-dispatched-attempt', ordinal: 1, kind: 'initial' },
    }),
    repairAction: fakeRepairAction(
      { ok: false, error: 'no confident replacement', code: 'TESTID_NOT_FOUND' },
      repairCalls,
    ),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.meta.trailingVerification, undefined);
  assert.equal(repairCalls.length, 1);
});

test('gh-623: a malformed qualifier never softens the failure — repair path runs as today', async () => {
  // The attempt lineage stays bound to the dispatched attempt in every case,
  // so exactly ONE broken field is what rejects each qualifier. Missing and
  // wrongly typed termination flags must read as dirty, never clean-by-absence.
  const { timedOut: _drop, ...terminationWithoutTimedOut } = CLEAN_TERMINATION;
  const malformedOverrides: Array<Record<string, unknown>> = [
    { stageTerminations: [] },
    { stageTerminations: [{ ...CLEAN_TERMINATION, artifactFinalized: false }] },
    { stageTerminations: [{ ...CLEAN_TERMINATION, outputTruncated: true }] },
    { stageTerminations: [{ ...CLEAN_TERMINATION, signal: 'SIGTERM' }] },
    { stageTerminations: [{ ...CLEAN_TERMINATION, timedOut: true }] },
    { stageTerminations: [{ ...CLEAN_TERMINATION, bootstrapFailure: true }] },
    { stageTerminations: [{ ...CLEAN_TERMINATION, transportFailure: true }] },
    { stageTerminations: [terminationWithoutTimedOut] },
    { stageTerminations: [{ ...CLEAN_TERMINATION, outputTruncated: 0 }] },
    { stageTerminations: [{ ...CLEAN_TERMINATION, artifactFinalized: 'true' }] },
    { stageTerminations: [{ ...CLEAN_TERMINATION, exitCode: 'one' }] },
    { stageTerminations: [{ ...CLEAN_TERMINATION, exitCode: null }] },
    { provenMutations: 0 },
    { mutationEvidence: 'partial' },
  ];
  for (const [caseIndex, overrides] of malformedOverrides.entries()) {
    project.cleanup();
    project = createTmpProject();
    project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['home_screen'] }), null);
    const repairCalls: unknown[] = [];
    const handler = createRunActionHandler({
      maestroRun: fakeTrailingMaestroRun([], overrides),
      repairAction: fakeRepairAction(
        { ok: false, error: 'no confident replacement', code: 'TESTID_NOT_FOUND' },
        repairCalls,
      ),
    });
    const result = await handler({ actionId: 'demo', projectRoot: project.root });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.ok, false, `case ${caseIndex}`);
    assert.equal(body.meta.trailingVerification, undefined, `case ${caseIndex}`);
    assert.equal(repairCalls.length, 1, `case ${caseIndex}: repair path must run unchanged`);
  }
});

test('gh-623: attempt lineage — the post-repair retry names the initial attempt as parent', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }), null);
  const maestroCalls: Array<{ attempt?: Record<string, unknown> }> = [];
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(
      [
        {
          ok: false,
          data: {
            passed: false,
            output: "Element with id 'fab-create-task' not found",
            flowFile: 'x',
            platform: 'ios',
          },
        },
        { ok: true, data: { passed: true, output: 'Flow passed', flowFile: 'x', platform: 'ios' } },
      ],
      maestroCalls,
    ),
    repairAction: fakeRepairAction({
      ok: true,
      data: {
        patched: true,
        actionId: 'demo',
        oldSelector: 'fab-create-task',
        newSelector: 'fab-create-task-btn',
        score: 0.91,
        replacements: 1,
      },
    }),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, true, JSON.stringify(body).slice(0, 300));
  assert.equal(maestroCalls.length, 2);
  const first = maestroCalls[0].attempt!;
  const retry = maestroCalls[1].attempt!;
  assert.equal(first.kind, 'initial');
  assert.equal(first.ordinal, 1);
  assert.equal(first.maxAttempts, 2);
  assert.equal(retry.kind, 'repaired');
  assert.equal(retry.ordinal, 2);
  assert.equal(retry.parentAttemptId, first.attemptId);
});

test('gh-623: a repaired retry that fails only trailing verification carries the qualifier', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }), null);
  // The retry qualifier is built from the attempt lineage the handler actually
  // passed — a fabricated, unrelated lineage must never be what this pins.
  const maestroCalls: Array<{ attempt?: Record<string, unknown> }> = [];
  const maestroRunStub = async (args: { attempt?: Record<string, unknown> }) => {
    maestroCalls.push(args);
    if (maestroCalls.length === 1) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              data: {
                passed: false,
                output: "Element with id 'fab-create-task' not found",
                flowFile: 'x',
                platform: 'ios',
              },
            }),
          },
        ],
        isError: true,
      };
    }
    const retryEnv = trailingIdWaitEnv(
      qualifier({
        attempt: {
          attemptId: args.attempt!.attemptId,
          ordinal: args.attempt!.ordinal,
          kind: args.attempt!.kind,
          parentAttemptId: args.attempt!.parentAttemptId,
        },
      }),
    );
    return { content: [{ type: 'text', text: JSON.stringify(retryEnv) }], isError: true };
  };
  const handler = createRunActionHandler({
    maestroRun: maestroRunStub,
    repairAction: fakeRepairAction({
      ok: true,
      data: {
        patched: true,
        actionId: 'demo',
        oldSelector: 'fab-create-task',
        newSelector: 'fab-create-task-btn',
        score: 0.91,
        replacements: 1,
      },
    }),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(maestroCalls.length, 2);
  const initialAttempt = maestroCalls[0].attempt!;
  const retryAttempt = maestroCalls[1].attempt!;
  assert.deepEqual(body.meta.trailingVerification.attempt, {
    attemptId: retryAttempt.attemptId,
    ordinal: 2,
    kind: 'repaired',
    parentAttemptId: initialAttempt.attemptId,
  });
  assert.deepEqual(body.meta.runtimeDegraded, RUNTIME_DEGRADED);
  assert.ok(body.error.includes(RUNTIME_CAVEAT), body.error);
  assert.equal(body.error.split(RUNTIME_CAVEAT).length - 1, 1);
  assert.match(body.error, /trailing verification only/);
  assert.ok(!/reboot it \(xcrun simctl/.test(body.error), body.error);
  assert.ok(!/relaunch the app/.test(body.error), body.error);
  const sidecar = JSON.parse(readFileSync(project.sidecarPath('demo'), 'utf8'));
  const run = sidecar.runHistory.at(-1);
  assert.equal(run.status, 'fail');
  assert.deepEqual(run.trailingVerification.attempt, body.meta.trailingVerification.attempt);
  assert.equal(run.autoRepair.outcome, 'failed');
});

test('gh-623: a repaired qualifier with the wrong parent lineage is rejected', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }), null);
  let invocation = 0;
  const handler = createRunActionHandler({
    maestroRun: async (args: { attempt?: Record<string, unknown> }) => {
      invocation++;
      if (invocation === 1) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                data: {
                  passed: false,
                  output: "Element with id 'fab-create-task' not found",
                  flowFile: 'x',
                  platform: 'ios',
                },
              }),
            },
          ],
          isError: true,
        };
      }
      const retryEnv = trailingIdWaitEnv(
        qualifier({
          attempt: {
            attemptId: args.attempt!.attemptId,
            ordinal: args.attempt!.ordinal,
            kind: args.attempt!.kind,
            parentAttemptId: 'different-parent-attempt',
          },
        }),
      );
      return { content: [{ type: 'text', text: JSON.stringify(retryEnv) }], isError: true };
    },
    repairAction: fakeRepairAction({
      ok: true,
      data: {
        patched: true,
        actionId: 'demo',
        oldSelector: 'fab-create-task',
        newSelector: 'fab-create-task-btn',
        score: 0.91,
        replacements: 1,
      },
    }),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.meta.trailingVerification, undefined);
  assert.doesNotMatch(body.error, /trailing verification only/);
  const sidecar = JSON.parse(readFileSync(project.sidecarPath('demo'), 'utf8'));
  assert.equal(sidecar.runHistory.at(-1).trailingVerification, undefined);
});

test('gh-623 negative control: an unqualified early selector failure still repairs as today', async () => {
  project.seedAction('demo', fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }), null);
  const repairCalls: unknown[] = [];
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([
      {
        ok: false,
        data: {
          passed: false,
          output: "Element with id 'fab-create-task' not found",
          flowFile: 'x',
          platform: 'ios',
        },
      },
      { ok: true, data: { passed: true, output: 'Flow passed', flowFile: 'x', platform: 'ios' } },
    ]),
    repairAction: fakeRepairAction(
      {
        ok: true,
        data: {
          patched: true,
          actionId: 'demo',
          oldSelector: 'fab-create-task',
          newSelector: 'fab-create-task-btn',
          score: 0.91,
          replacements: 1,
        },
      },
      repairCalls,
    ),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(repairCalls.length, 1);
});
