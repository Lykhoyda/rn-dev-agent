// GH #580 — three bounded replay-reliability behaviors:
//
//   1. `launchApp` maps carrying keys the CDP/JS transport cannot honor (notably
//      `clearState: true`, which needs uninstall+reinstall, not `simctl launch`)
//      are refused instead of silently normalized to a plain launch.
//   2. A reactive fallback resumes at the single source step that targets the
//      proven failed selector, so already-executed mutations are not redispatched.
//      Zero, duplicate, or sub-flow-nested matches refuse and keep start-at-zero.
//   3. The reclassified 1.1.x wait reaches auto-repair for the first time, so the
//      #631 completed-flow false negative must still end with no YAML write while
//      the #317 exact-native TRANSPORT_BLIND refusal keeps firing.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSteps,
  findResumeAnchor,
  UnsupportedStepError,
} from '../../dist/domain/cdp-flow-replay.js';
import { runCdpReplay, firstReplayTestId } from '../../dist/tools/cdp-replay-dispatch.js';
import { attemptRepair, detectTransportBlind } from '../../dist/domain/repair-engine.js';
import { loadAction } from '../../dist/domain/action-store.js';
import {
  createPinnedRunActionHandler as createRunActionHandler,
  createTmpProject,
} from '../helpers/tmp-project.js';

let project: ReturnType<typeof createTmpProject>;
beforeEach(() => {
  project = createTmpProject();
});
afterEach(() => {
  project.cleanup();
});

function actionYaml(bodyLines: string[], id = 'demo'): string {
  return [
    'appId: com.test.app',
    '---',
    `# id: ${id}`,
    '# intent: test fixture',
    '# tags: [fixture]',
    '# mutates: false',
    '# status: experimental',
    '',
    ...bodyLines,
    '',
  ].join('\n');
}

function readEnvelope(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. launchApp keys the transport cannot honor
// ─────────────────────────────────────────────────────────────────────────────

test('gh-580: launchApp { clearState: true } is refused, not silently dropped', () => {
  assert.throws(
    () => normalizeSteps([{ launchApp: { clearState: true } }], {}),
    (e: unknown) => {
      assert.ok(e instanceof UnsupportedStepError);
      assert.equal(e.stepKey, 'launchApp (unsupported keys: clearState)');
      return true;
    },
  );
  // The standalone `- clearState` form already threw; the two are now consistent.
  assert.throws(() => normalizeSteps(['clearState'], {}), UnsupportedStepError);
});

test('gh-580: every unhonorable launchApp key is refused and named; stopApp still works', () => {
  assert.throws(
    () => normalizeSteps([{ launchApp: { clearState: false } }], {}),
    UnsupportedStepError,
  );
  assert.throws(
    () => normalizeSteps([{ launchApp: { permissions: { all: 'allow' } } }], {}),
    (e: unknown) => {
      assert.equal(
        (e as UnsupportedStepError).stepKey,
        'launchApp (unsupported keys: permissions)',
      );
      return true;
    },
  );
  assert.throws(
    () => normalizeSteps([{ launchApp: { arguments: {}, clearState: true } }], {}),
    (e: unknown) => {
      assert.equal(
        (e as UnsupportedStepError).stepKey,
        'launchApp (unsupported keys: arguments, clearState)',
      );
      return true;
    },
  );

  // A non-boolean stopApp would coerce to false — the same silent lie.
  assert.throws(
    () => normalizeSteps([{ launchApp: { stopApp: 'true' } }], {}),
    (e: unknown) => {
      assert.equal((e as UnsupportedStepError).stepKey, 'launchApp (stopApp must be a boolean)');
      return true;
    },
  );
  assert.throws(() => normalizeSteps([{ launchApp: { stopApp: null } }], {}), UnsupportedStepError);

  // Supported shapes are untouched.
  assert.deepEqual(normalizeSteps([{ launchApp: { stopApp: true } }], {}), [
    { t: 'launch', stopApp: true },
  ]);
  assert.deepEqual(normalizeSteps([{ launchApp: { stopApp: false } }], {}), [
    { t: 'launch', stopApp: false },
  ]);
  assert.deepEqual(normalizeSteps([{ launchApp: null }], {}), [{ t: 'launch', stopApp: false }]);
});

test('gh-580: a clearState action yields no proactive probe anchor', () => {
  const body = '- launchApp:\n    clearState: true\n- tapOn:\n    id: "direct_login_button"\n';
  assert.equal(firstReplayTestId(body, {}), null);
});

test('gh-580: proactive at-risk path does NOT route a clearState action to CDP/JS', async () => {
  project.seedAction(
    'demo',
    actionYaml(['- launchApp:', '    clearState: true', '- tapOn:', '    id: "fab-create-task"']),
  );
  const maestro = { calls: 0 };
  const pressCalls: string[] = [];
  const handler = createRunActionHandler({
    maestroRun: async () => {
      maestro.calls++;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              data: {
                passed: true,
                output: 'Flow PASSED',
                flowFile: 'x',
                platform: 'ios',
                transport: 'maestro-runner',
                fallback: 'none',
                steps: [],
              },
            }),
          },
        ],
      };
    },
    replayDeps: () => ({
      pressByTestId: async (id: string) => {
        pressCalls.push(id);
      },
      typeByTestId: async () => {},
      treeFor: async (id: string) => ({ testID: id, children: [] }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    blindProbeContext: async () => ({ deviceId: 'UDID-1', iosRuntimeMajor: 26 }),
    probeRetry: { attempts: 1, delayMs: 0 },
  });

  const env = readEnvelope(
    await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' }),
  );
  assert.equal(env.data.transport, 'maestro-runner', 'stays maestro-first');
  assert.equal(maestro.calls, 1, 'maestro must run — CDP/JS cannot honor clearState');
  assert.deepEqual(pressCalls, [], 'nothing was replayed through the blind transport');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Selector-anchored resume
// ─────────────────────────────────────────────────────────────────────────────

const RESUME_BODY = [
  '- launchApp:',
  '    stopApp: false',
  '- tapOn:',
  '    id: "direct_login_button"',
  '- inputText: "user@example.com"',
  '- assertVisible:',
  '    id: "otp_sheet"',
  '- tapOn:',
  '    id: "otp_submit"',
].join('\n');

function spyDeps(visible: (id: string) => boolean = () => true) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      pressByTestId: async (id: string) => {
        calls.push(`press:${id}`);
      },
      typeByTestId: async (id: string, text: string) => {
        calls.push(`type:${id}:${text}`);
      },
      treeFor: async (id: string) =>
        visible(id) ? { testID: id, children: [] } : { testID: 'other', children: [] },
      launchApp: async (stopApp: boolean) => {
        calls.push(`launch:${stopApp}`);
      },
      settle: async () => {
        calls.push('settle');
      },
    },
  };
}

test('gh-580: a unique selector resumes at its source step and skips prior mutations', async () => {
  const { calls, deps } = spyDeps();
  const result = await runCdpReplay(RESUME_BODY, {}, deps, { resumeAtSelector: 'otp_sheet' });

  assert.equal(result.passed, true);
  assert.deepEqual(result.resume, { applied: true, selector: 'otp_sheet', startIndex: 3 });
  assert.deepEqual(
    result.steps.map((step) => step.sourceIndex),
    [3, 4],
  );
  assert.deepEqual(
    calls,
    ['press:otp_submit'],
    'launch, the login tap and the email inputText were NOT redispatched',
  );
});

test('gh-580: resume reports SOURCE step indices, not suffix-relative ones', async () => {
  // otp_submit is absent from the tree, so the resumed suffix fails on it.
  const { deps } = spyDeps((id) => id !== 'otp_submit');
  const result = await runCdpReplay(RESUME_BODY, {}, deps, { resumeAtSelector: 'otp_sheet' });

  assert.equal(result.passed, false);
  assert.equal(result.failedStepIndex, 4, 'source index of the tapOn, not suffix index 1');
  assert.match(result.reason ?? '', /otp_submit/);
});

test('gh-580: an unsupported PREFIX no longer blocks a resumed suffix', async () => {
  // Whole-flow normalization refuses this body (clearState); the suffix does not.
  const body = [
    '- launchApp:',
    '    clearState: true',
    '- tapOn:',
    '    id: "direct_login_button"',
    '- assertVisible:',
    '    id: "otp_sheet"',
  ].join('\n');
  await assert.rejects(() => runCdpReplay(body, {}, spyDeps().deps), UnsupportedStepError);

  const { calls, deps } = spyDeps();
  const result = await runCdpReplay(body, {}, deps, { resumeAtSelector: 'otp_sheet' });
  assert.equal(result.passed, true);
  assert.deepEqual(result.resume, { applied: true, selector: 'otp_sheet', startIndex: 2 });
  assert.deepEqual(calls, [], 'assertVisible only probes the tree; nothing was mutated');
});

test('gh-580: a selector absent from the body refuses to resume and replays from zero', async () => {
  const { calls, deps } = spyDeps();
  const result = await runCdpReplay(RESUME_BODY, {}, deps, { resumeAtSelector: 'never_here' });

  assert.deepEqual(result.resume, { applied: false, reason: 'no-match' });
  assert.deepEqual(calls, [
    'launch:false',
    'press:direct_login_button',
    'type:direct_login_button:user@example.com',
    'press:otp_submit',
  ]);
});

test('gh-580: a duplicated selector refuses to resume — never guess which one failed', async () => {
  const body = [
    '- tapOn:',
    '    id: "retry_button"',
    '- assertVisible:',
    '    id: "otp_sheet"',
    '- tapOn:',
    '    id: "retry_button"',
  ].join('\n');
  const { calls, deps } = spyDeps();
  const result = await runCdpReplay(body, {}, deps, { resumeAtSelector: 'retry_button' });

  assert.deepEqual(result.resume, { applied: false, reason: 'ambiguous' });
  assert.deepEqual(calls, ['press:retry_button', 'press:retry_button'], 'start-at-zero preserved');
});

test('gh-580: a match nested inside a sub-flow refuses — the wrapper would replay siblings', () => {
  const body = [
    { launchApp: { stopApp: false } },
    {
      runFlow: {
        when: { visible: { id: 'onboarding' } },
        commands: [{ tapOn: { id: 'accept_terms' } }, { tapOn: { id: 'otp_sheet' } }],
      },
    },
  ];
  assert.deepEqual(findResumeAnchor(body, {}, 'otp_sheet'), {
    found: false,
    reason: 'nested-match',
  });
  // Two occurrences inside ONE wrapper stay detectably ambiguous, not "one match".
  const twice = [
    {
      runFlow: {
        when: { visible: { id: 'g' } },
        commands: [{ tapOn: { id: 'dup' } }, { assertVisible: { id: 'dup' } }],
      },
    },
  ];
  assert.deepEqual(findResumeAnchor(twice, {}, 'dup'), { found: false, reason: 'ambiguous' });
});

test('gh-580: a body too deep to scan completely refuses rather than claim uniqueness', () => {
  // A shallow hit plus a duplicate buried below the depth bound must never read
  // as "exactly one match" — the walk cannot prove the deeper one is absent.
  let deep: Record<string, unknown> = { tapOn: { id: 'buried' } };
  for (let i = 0; i < 30; i++) deep = { wrapper: deep };
  assert.deepEqual(findResumeAnchor([{ tapOn: { id: 'buried' } }, deep], {}, 'buried'), {
    found: false,
    reason: 'too-deep',
  });
});

test('gh-580: the anchor honors ${PARAM} interpolation and an empty selector never matches', () => {
  const body = [{ tapOn: { id: 'row-${ROW}' } }, { assertVisible: { id: 'done' } }];
  assert.deepEqual(findResumeAnchor(body, { ROW: '7' }, 'row-7'), { found: true, index: 0 });
  assert.deepEqual(findResumeAnchor(body, { ROW: '7' }, 'row-9'), {
    found: false,
    reason: 'no-match',
  });
  assert.deepEqual(findResumeAnchor(body, {}, ''), { found: false, reason: 'no-match' });
});

test('gh-580: a resumed inputText with no focus target still fails loudly', async () => {
  const body = [
    '- tapOn:',
    '    id: "login"',
    '- assertVisible:',
    '    id: "otp_form"',
    '- inputText: "123456"',
  ].join('\n');
  const { calls, deps } = spyDeps();
  const result = await runCdpReplay(body, {}, deps, { resumeAtSelector: 'otp_form' });

  assert.equal(result.passed, false);
  assert.equal(result.reason, 'inputText before any tapOn — no focus target');
  assert.equal(result.failedStepIndex, 2, 'source index of the inputText');
  assert.deepEqual(calls, [], 'nothing was typed into an unknown field');
});

test('gh-580: the proactive path never resumes — it replays the whole flow from zero', async () => {
  const { calls, deps } = spyDeps();
  const result = await runCdpReplay(RESUME_BODY, {}, deps);

  assert.deepEqual(result.resume, { applied: false, reason: 'not-requested' });
  assert.equal(calls[0], 'launch:false', 'launch is still executed');
  assert.equal(calls.length, 4);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Auto-repair safety for the newly reclassified wait
// ─────────────────────────────────────────────────────────────────────────────

const OTP_SELECTOR = 'EmailOtpFormContent_email-pressable';

// #631 shape: registration actually completed, so the live screen is the push
// prompt and the OTP selector is absent from the native snapshot entirely.
const PUSH_PROMPT_CANDIDATES = ['PushPrimer_title', 'PushPrimer_allow-button', 'PushPrimer_skip'];

test('gh-631: the repair engine refuses a reclassified wait whose selector is absent', () => {
  project.seedAction('register', actionYaml(['- tapOn:', `    id: "${OTP_SELECTOR}"`], 'register'));
  const action = loadAction(project.root, 'register');

  assert.equal(
    detectTransportBlind(OTP_SELECTOR, PUSH_PROMPT_CANDIDATES),
    false,
    'the #317 guard cannot fire — the selector is genuinely absent',
  );
  const result = attemptRepair(action, OTP_SELECTOR, PUSH_PROMPT_CANDIDATES);
  assert.equal(result.kind, 'no-match', 'the fuzzy matcher must refuse, not patch');
  assert.ok(!('newSelector' in result), 'no replacement selector was produced');
});

test('gh-317: the exact-native oracle still flags a snapshot-visible selector as blind', () => {
  assert.equal(detectTransportBlind(OTP_SELECTOR, ['Header_title', OTP_SELECTOR]), true);
  assert.equal(detectTransportBlind(OTP_SELECTOR, PUSH_PROMPT_CANDIDATES), false);
});

/** A maestro_run envelope carrying the 1.1.x ID-wait wording for `selector`. */
function waitFailureEnvelope(selector: string, shape: 'throw' | 'warn' = 'throw') {
  const step = `extendedWaitUntil: visible id="${selector}"`;
  const terminal = {
    completedSteps: 1,
    failedStep: step,
    exitClass: 'step-failure',
    failureKind: 'SELECTOR_NOT_FOUND',
    failureSelector: selector,
  };
  const output = `${'x'.repeat(600)}\n  ╰─ Element '#${selector}' not visible within 15s`;
  const envelope =
    shape === 'throw'
      ? {
          ok: false,
          error: `Maestro flow failed at step "${step}" (SELECTOR_NOT_FOUND: ${selector})`,
          data: { passed: false, output, flowFile: 'x', platform: 'ios', terminal },
        }
      : {
          ok: true,
          data: {
            passed: false,
            output,
            flowFile: 'x',
            platform: 'ios',
            failedStep: { name: step, verb: 'extendedWaitUntil' },
            terminal,
          },
          meta: { warning: 'Flow completed with warnings or failures' },
        };
  return async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    ...(shape === 'throw' ? { isError: true as const } : {}),
  });
}

function fakeRepair(envelope: Record<string, unknown>, seen: { failedSelector?: string }) {
  return async (args: { failedSelector?: string }) => {
    seen.failedSelector = args.failedSelector;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
      isError: true as const,
    };
  };
}

test('gh-631: absent selector → repair gets the exact selector, refuses, and writes no YAML', async () => {
  project.seedAction('register', actionYaml(['- tapOn:', `    id: "${OTP_SELECTOR}"`], 'register'));
  const before = project.readYaml('register');
  const seen: { failedSelector?: string } = {};

  const handler = createRunActionHandler({
    maestroRun: waitFailureEnvelope(OTP_SELECTOR),
    // CDP agrees the selector is gone, so the fallback is skipped and the run
    // reaches the YAML-writing repair path.
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () => ({ testID: 'PushPrimer_title', children: [] }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    probeRetry: { attempts: 1, delayMs: 0 },
    repairAction: fakeRepair(
      {
        ok: false,
        error: `cdp_repair_action: no confident replacement for "${OTP_SELECTOR}"`,
        code: 'TESTID_NOT_FOUND',
      },
      seen,
    ),
  });

  const env = readEnvelope(await handler({ actionId: 'register', projectRoot: project.root }));
  assert.equal(seen.failedSelector, OTP_SELECTOR, 'repair received the parsed exact selector');
  assert.equal(env.ok, false);
  assert.equal(env.meta.autoRepair.outcome, 'refused');
  assert.equal(env.meta.autoRepair.refusedReason, 'NO_MATCH');
  assert.equal(project.readYaml('register'), before, 'the saved action is byte-identical');
});

test('gh-317: a TRANSPORT_BLIND repair refusal is preserved verbatim and writes no YAML', async () => {
  project.seedAction('register', actionYaml(['- tapOn:', `    id: "${OTP_SELECTOR}"`], 'register'));
  const before = project.readYaml('register');
  const seen: { failedSelector?: string } = {};
  let maestroCalls = 0;

  const handler = createRunActionHandler({
    maestroRun: async (...a: unknown[]) => {
      maestroCalls++;
      return waitFailureEnvelope(OTP_SELECTOR)(...(a as []));
    },
    repairAction: fakeRepair(
      {
        ok: false,
        error: 'cdp_repair_action: Maestro/WDA reported it not visible, but rn-fast-runner sees it',
        code: 'TRANSPORT_BLIND',
      },
      seen,
    ),
  });

  const env = readEnvelope(await handler({ actionId: 'register', projectRoot: project.root }));
  assert.equal(env.code, 'TRANSPORT_BLIND', 'the honest transport verdict survives');
  assert.equal(env.meta.autoRepair.refusedReason, 'TRANSPORT_BLIND');
  assert.equal(maestroCalls, 1, 'no retry after a refused repair');
  assert.equal(project.readYaml('register'), before);
});

test('gh-580: the handler resumes reactive replay at the parsed selector', async () => {
  project.seedAction(
    'register',
    actionYaml(
      [
        '- launchApp:',
        '    stopApp: false',
        '- tapOn:',
        '    id: "direct_login_button"',
        '- inputText: "user@example.com"',
        '- assertVisible:',
        '    id: "otp_sheet"',
        '- tapOn:',
        '    id: "otp_submit"',
      ],
      'register',
    ),
  );
  const { calls, deps } = spyDeps();

  const handler = createRunActionHandler({
    maestroRun: waitFailureEnvelope('otp_sheet'),
    replayDeps: () => deps,
    probeRetry: { attempts: 1, delayMs: 0 },
  });

  const env = readEnvelope(await handler({ actionId: 'register', projectRoot: project.root }));
  assert.equal(env.ok, true);
  assert.equal(env.data.transport, 'cdp-js');
  assert.deepEqual(env.data.resume, { applied: true, selector: 'otp_sheet', startIndex: 3 });
  assert.deepEqual(
    calls,
    ['press:otp_submit'],
    'the login tap and email inputText were NOT redispatched through the fallback',
  );
});

test('gh-580: repair refusal surfaces the exact selector instead of a raw stdout dump', async () => {
  project.seedAction('register', actionYaml(['- tapOn:', `    id: "${OTP_SELECTOR}"`], 'register'));
  const before = project.readYaml('register');
  const handler = createRunActionHandler({
    maestroRun: async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            error: `Maestro flow failed at step "extendedWaitUntil: visible id=\\"${OTP_SELECTOR}\\"" (SELECTOR_NOT_FOUND: ${OTP_SELECTOR})`,
            data: {
              passed: false,
              output: `x`.repeat(600) + `\n  ╰─ Element '#${OTP_SELECTOR}' not visible within 15s`,
              flowFile: 'x',
              platform: 'ios',
              terminal: {
                completedSteps: 1,
                failedStep: `extendedWaitUntil: visible id="${OTP_SELECTOR}"`,
                exitClass: 'step-failure',
                failureKind: 'SELECTOR_NOT_FOUND',
                failureSelector: OTP_SELECTOR,
              },
            },
          }),
        },
      ],
      isError: true as const,
    }),
    repairAction: async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            error: `cdp_repair_action: no confident replacement for "${OTP_SELECTOR}"`,
            code: 'TESTID_NOT_FOUND',
          }),
        },
      ],
      isError: true as const,
    }),
  });

  const env = readEnvelope(await handler({ actionId: 'register', projectRoot: project.root }));
  assert.equal(env.ok, false);
  assert.equal(env.meta.failureKind, 'SELECTOR_NOT_FOUND');
  assert.equal(env.meta.failureSelector, OTP_SELECTOR);
  assert.equal(env.meta.terminal.failureSelector, OTP_SELECTOR);
  assert.match(env.error, new RegExp(OTP_SELECTOR));
  assert.ok(
    env.meta.firstAttemptOutput.includes("Element '#" + OTP_SELECTOR + "' not visible within 15s"),
    'the head+tail bound keeps the terminal line that a head-only slice dropped',
  );
  assert.equal(project.readYaml('register'), before, 'a refused repair writes nothing');
});

test('gh-580: the warn path (runner exit 0 with failures) reports kind + selector too', async () => {
  project.seedAction('register', actionYaml(['- tapOn:', `    id: "${OTP_SELECTOR}"`], 'register'));
  const handler = createRunActionHandler({
    // maestro_run's warnResult shape: ok:true, no `error`, step summary in DATA.
    maestroRun: async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            data: {
              passed: false,
              output: "maestro-runner 1.1.20\n  ╰─ Element '#otp' not visible within 15s",
              flowFile: 'x',
              platform: 'ios',
              failedStep: {
                name: 'extendedWaitUntil: visible id="otp"',
                verb: 'extendedWaitUntil',
              },
              terminal: {
                completedSteps: 1,
                failedStep: 'extendedWaitUntil: visible id="otp"',
                exitClass: 'step-failure',
                failureKind: 'SELECTOR_NOT_FOUND',
                failureSelector: 'otp',
              },
            },
            meta: { warning: 'Flow completed with warnings or failures' },
          }),
        },
      ],
    }),
  });

  const env = readEnvelope(
    await handler({ actionId: 'register', projectRoot: project.root, autoRepair: false }),
  );
  assert.equal(env.ok, false);
  // Structurally, exactly what the throw path exposes.
  assert.equal(env.meta.failureKind, 'SELECTOR_NOT_FOUND');
  assert.equal(env.meta.failureSelector, 'otp');
  assert.equal(env.meta.terminal.failureSelector, 'otp');
  assert.match(env.meta.underlyingFailure, /extendedWaitUntil: visible id="otp"/);
  assert.match(
    env.meta.underlyingFailure,
    /\(SELECTOR_NOT_FOUND: otp\)/,
    'the warn path used to degrade to a bare stdout slice',
  );
});

for (const retryShape of ['warn', 'throw'] as const) {
  test(`gh-580: a ${retryShape} post-repair failure keeps structural terminal evidence`, async () => {
    project.seedAction('register', actionYaml(['- tapOn:', '    id: "otp"'], 'register'));
    let maestroCalls = 0;
    const handler = createRunActionHandler({
      maestroRun: async (...args: unknown[]) => {
        maestroCalls++;
        return maestroCalls === 1
          ? waitFailureEnvelope('otp')(...(args as []))
          : waitFailureEnvelope('otp_retry', retryShape)(...(args as []));
      },
      repairAction: async () => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              data: {
                patched: true,
                oldSelector: 'otp',
                newSelector: 'otp_retry',
                score: 0.9,
              },
            }),
          },
        ],
      }),
    });

    const env = readEnvelope(await handler({ actionId: 'register', projectRoot: project.root }));
    assert.equal(env.ok, false);
    assert.equal(env.meta.failureKind, 'SELECTOR_NOT_FOUND');
    assert.equal(env.meta.failureSelector, 'otp_retry');
    assert.equal(env.meta.terminal.failureKind, 'SELECTOR_NOT_FOUND');
    assert.equal(env.meta.terminal.failureSelector, 'otp_retry');
  });
}

test('gh-580: a killed post-repair retry persists and returns TIMEOUT', async () => {
  project.seedAction('register', actionYaml(['- tapOn:', '    id: "otp"'], 'register'));
  let maestroCalls = 0;
  const handler = createRunActionHandler({
    maestroRun: async (...args: unknown[]) => {
      maestroCalls++;
      if (maestroCalls === 1) return waitFailureEnvelope('otp')(...(args as []));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'Maestro flow timed out after step "extendedWaitUntil"',
              data: {
                passed: false,
                output: "Element '#otp_retry' not visible within 15s",
                terminal: {
                  completedSteps: 1,
                  exitClass: 'timed-out',
                  failureKind: 'SELECTOR_NOT_FOUND',
                  failureSelector: 'otp_retry',
                },
              },
            }),
          },
        ],
        isError: true as const,
      };
    },
    repairAction: async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            data: {
              patched: true,
              oldSelector: 'otp',
              newSelector: 'otp_retry',
              score: 0.9,
            },
          }),
        },
      ],
    }),
  });

  const env = readEnvelope(await handler({ actionId: 'register', projectRoot: project.root }));
  assert.equal(env.ok, false);
  assert.equal(env.code, undefined);
  assert.equal(env.meta.failureKind, 'TIMEOUT');
  assert.equal(env.meta.failureSelector, 'otp_retry');
  assert.equal(env.meta.terminal.exitClass, 'timed-out');
  const sidecar = project.readSidecar('register');
  assert.equal(sidecar.runHistory.at(-1)?.failureCode, 'TIMEOUT');
});
