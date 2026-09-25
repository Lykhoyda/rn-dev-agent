import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen, NativeCaptureError } from '../../../dist/qa/capture.js';
import type { ReactObservation } from '../../../dist/qa/capture.js';
import { bindPrivateInputs, PrivateInputCaptureError } from '../../../dist/qa/private-input.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import { ObservedPrivacy, redactEvidence } from '../../../dist/qa/privacy.js';
import { scriptedJudge } from './judgment-fixtures.ts';
import { walker } from './judgment-fixtures.ts';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { exitCodeFor, resultForWalk } from '../../../dist/qa/wire.js';
import { captureQaReact } from '../../../dist/qa/react-capture.js';

const secret = 'private-rn-only@example.test';
function observation(): ReactObservation {
  return {
    interactive: [],
    verdict: { state: 'ok', path: 'interactive', complete: true },
    hostEvidence: {
      complete: true,
      hosts: [{ role: null, roleSource: 'none', capabilities: {}, readOnly: true }],
    },
  };
}
const payload = (values = [secret], secure = false) => ({
  version: 1,
  complete: true,
  facts: [{ hostIndex: 0, values, secure }],
});

test('anonymous readonly RN values mask native echoes without becoming assertion evidence', async () => {
  const react = observation();
  const before = structuredClone(react);
  const screen = await captureScreen({
    requirePrivateInputs: true,
    native: async () => ({ nodes: [{ ref: '@echo', type: 'StaticText', label: secret }] }),
    react: async () => bindPrivateInputs(react, payload()),
  });
  assert.deepEqual(react, before);
  assert.equal(screen.elements.length, 1);
  assert.equal(screen.elements[0].value, undefined);
  const judge = scriptedJudge((questions, _, state) => {
    assert.equal(JSON.stringify({ questions, state }).includes(secret), false);
    return { check_1: { type: 'noul', noul: 0.99 } };
  });
  assert.equal(
    (
      await decideScreen(screen, judge, {
        kind: 'check',
        literal: false,
        text: 'Welcome is visible',
        line: 1,
      })
    ).check,
    'pass',
  );
  const privacy = new ObservedPrivacy();
  privacy.observe(screen);
  assert.equal(privacy.redact(secret), '•••');
});

test('hidden and uncertain private input contents are never proved by a model', async () => {
  for (const secure of [true, false]) {
    const screen = await captureScreen({
      requirePrivateInputs: true,
      native: async () => ({ nodes: [] }),
      react: async () => bindPrivateInputs(observation(), payload([secret], secure)),
    });
    assert.deepEqual(screen.elements, []);
    assert.deepEqual(screen.visibleText, []);
    const judge = scriptedJudge(() => assert.fail('private contents cannot be judged'));
    for (const text of [
      'Email field is valid',
      `Email contains ${secret}`,
      'Password is filled',
      'Welcome heading is valid',
    ]) {
      assert.equal(
        (
          await decideScreen(screen, judge, {
            kind: 'check',
            literal: false,
            text,
            line: 1,
          })
        ).check,
        'unsure',
        text,
      );
    }
  }
});

test('unknown private capture refuses content-free without judgments, mutations or screenshots', async () => {
  const judge = scriptedJudge(() => assert.fail('unknown capture must not be judged'));
  const f = walker([], judge);
  f.deps.captureScreen = () =>
    captureScreen({
      requirePrivateInputs: true,
      native: async () => ({ nodes: [{ ref: '@secret', type: 'StaticText', label: secret }] }),
      react: async () => observation(),
    });
  f.deps.screenshot = async () => assert.fail('unknown capture must not take screenshots');
  const plan = parsePlan(`✓ "${secret}"`);
  assert.ok(plan.blocks);
  const result = await runPlan(plan.blocks, f.deps);
  assert.equal(result.verdict, 'REFUSED');
  assert.equal('code' in result && result.code, 'PRIVATE_INPUT_CAPTURE_UNKNOWN');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(f.actions, []);
});

test('private input values and screenshot restrictions persist into later screens and blocks', async () => {
  const first = await captureScreen({
    native: async () => ({ nodes: [{ ref: '@welcome', type: 'StaticText', label: 'Welcome' }] }),
    react: async () => bindPrivateInputs(observation(), payload()),
  });
  const later = await captureScreen({
    native: async () => ({ nodes: [{ ref: '@echo', type: 'StaticText', label: secret }] }),
    react: async () => bindPrivateInputs(observation(), { version: 1, complete: true, facts: [] }),
  });
  const judge = scriptedJudge(() => assert.fail('literal checks are local'));
  const f = walker([first, later], judge);
  f.deps.screenshot = async () => assert.fail('text masking does not redact pixels');
  const plan = parsePlan(`## First\n✓ "Welcome"\n## Second\n✓ "${secret}"`);
  assert.ok(plan.blocks);
  const result = await runPlan(plan.blocks, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('strict bounded binding and acquisition failures all refuse without payloads or warnings', async () => {
  const malformed: unknown[] = [
    null,
    {},
    { ...payload(), complete: false },
    { ...payload(), version: 2 },
    { ...payload(), extra: secret },
    payload([secret.repeat(4096)]),
    payload(Array.from({ length: 5 }, () => 'x'.repeat(4096))),
    { ...payload(), facts: [{ hostIndex: 0, secure: 'true', values: [secret] }] },
    { ...payload(), facts: [{ hostIndex: 0, secure: false, values: [123] }] },
    { ...payload(), facts: [{ hostIndex: 0, secure: false, values: [], extra: secret }] },
    { ...payload(), facts: [payload().facts[0], payload().facts[0]] },
    { ...payload(), facts: Array.from({ length: 200 }, () => payload().facts[0]) },
    ...[-1, 1, 0.5, NaN].map((hostIndex) => ({
      ...payload(),
      facts: [{ hostIndex, secure: false, values: [secret] }],
    })),
  ];
  const cases = [
    ...malformed.map((data) => () => bindPrivateInputs(observation(), data)),
    () => observation(),
    () => {
      throw new Error(secret);
    },
    () =>
      bindPrivateInputs(
        { ...observation(), hostEvidence: { complete: false, hosts: [] } },
        payload(),
      ),
    () => {
      const react = bindPrivateInputs(observation(), payload());
      react.hostEvidence = { complete: true, hosts: [] };
      return react;
    },
  ];
  for (const react of cases) {
    const judge = scriptedJudge(() => assert.fail('no judgments after unknown acquisition'));
    const f = walker([], judge);
    f.deps.captureScreen = () =>
      captureScreen({
        requirePrivateInputs: true,
        native: async () => ({ nodes: [] }),
        react: async () => react(),
        warn: () => assert.fail('no acquisition logs'),
      });
    f.deps.screenshot = async () => assert.fail('no screenshots');
    const plan = parsePlan(`1. Tap "${secret}"`);
    assert.ok(plan.blocks);
    const result = await runPlan(plan.blocks, f.deps);
    assert.equal(result.verdict, 'REFUSED');
    assert.equal(result.failure?.seen, 'Private input capture could not be established safely.');
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.deepEqual(f.actions, []);
  }
  await assert.rejects(
    captureScreen({
      requirePrivateInputs: true,
      native: async () => {
        throw new Error(secret);
      },
      react: async () => assert.fail('native acquisition failed'),
    }),
    (error) =>
      error instanceof NativeCaptureError &&
      error.code === 'NATIVE_CAPTURE_UNAVAILABLE' &&
      error.message === 'Native capture is unavailable.' &&
      !('cause' in error),
  );
  await assert.rejects(
    captureScreen({
      native: async () => ({ nodes: [] }),
      react: async () => bindPrivateInputs(observation(), null),
      warn: () => assert.fail('typed private failures cannot become legacy fallback'),
    }),
    PrivateInputCaptureError,
  );
});

test('the adapter rejects domain-invalid private facts before polling public completion', async () => {
  for (const facts of [
    ...[-1, 0.5, 200, NaN].map((hostIndex) => [{ hostIndex, values: [secret], secure: false }]),
    [payload().facts[0], payload().facts[0]],
  ]) {
    let calls = 0;
    await assert.rejects(
      captureQaReact({
        async withPrivateHelperWorld(operation) {
          return operation(async () => {
            if (++calls > 1) throw new Error(secret);
            return {
              v: 1,
              id: 'abc',
              state: 'pending',
              inputs: { version: 1, complete: true, facts },
            };
          });
        },
      }),
      PrivateInputCaptureError,
    );
    assert.equal(calls, 1, 'invalid private facts must refuse before any completion poll');
  }
});

test('native acquisition failures refuse at their own boundary without inspecting private diagnostics', async () => {
  const raw = new Error(secret);
  Object.defineProperty(raw, 'cause', {
    get: () => assert.fail('raw cause must not be inspected'),
  });
  raw.toString = () => assert.fail('raw failure must not be stringified');
  for (const afterSafeCapture of [false, true]) {
    const judge = scriptedJudge(() => assert.fail('native failure must not reach the judge'));
    const f = walker([], judge);
    let captures = 0;
    let privateCalls = 0;
    f.deps.captureScreen = () =>
      captureScreen({
        requirePrivateInputs: true,
        native: async () => {
          if (afterSafeCapture && captures++ === 0)
            return {
              nodes: [
                { ref: '@safe', type: 'StaticText', label: 'Welcome' },
                { ref: '@echo', type: 'StaticText', label: secret },
              ],
            };
          throw raw;
        },
        react: async () => {
          privateCalls++;
          return bindPrivateInputs(observation(), payload());
        },
        warn: () => assert.fail('no raw acquisition logs'),
      });
    f.deps.screenshot = async () => assert.fail('no screenshots');
    const plan = parsePlan(
      `${afterSafeCapture ? '## Safe\n✓ "Welcome"\n' : ''}## ${secret}\n1. Tap "${secret}"`,
    );
    assert.ok(plan.blocks);
    const result = await runPlan(plan.blocks, f.deps);
    assert.equal(result.verdict, 'REFUSED');
    assert.equal('code' in result && result.code, 'NATIVE_CAPTURE_UNAVAILABLE');
    assert.equal('message' in result && result.message, 'Native capture is unavailable.');
    assert.equal(result.failure?.seen, 'Native capture is unavailable.');
    assert.equal(result.steps.at(-1)?.block, 'native-capture');
    assert.equal(result.steps.at(-1)?.text, 'Native capture is unavailable.');
    assert.equal(result.steps.at(-1)?.reason, 'NATIVE_CAPTURE_UNAVAILABLE');
    assert.equal(result.steps.length, afterSafeCapture ? 2 : 1);
    assert.equal(JSON.stringify({ result, rows: f.rows }).includes(secret), false);
    assert.equal(privateCalls, afterSafeCapture ? 1 : 0);
    assert.deepEqual(f.actions, []);
    assert.equal(exitCodeFor(resultForWalk(result, 'test-lease')), 4);
  }
  await assert.rejects(
    captureScreen({
      native: async () => {
        throw raw;
      },
      react: async () => assert.fail('legacy native failure must not read React'),
    }),
    (error) => error === raw,
  );
});

test('acquisition refusals use fresh safe errors and classify by acquisition boundary', async () => {
  for (const ErrorClass of [NativeCaptureError, PrivateInputCaptureError]) {
    const safe = new ErrorClass();
    const contaminated = new ErrorClass();
    contaminated.message = secret;
    Reflect.set(contaminated, 'code', secret);
    Object.defineProperty(contaminated, 'cause', { get: () => assert.fail('never inspect cause') });
    const judge = scriptedJudge(() => assert.fail('no judgments after acquisition refusal'));
    const f = walker([], judge);
    f.deps.captureScreen = async () => {
      throw contaminated;
    };
    f.deps.screenshot = async () => assert.fail('no screenshots');
    const plan = parsePlan(`## ${secret}\n✓ "${secret}"`);
    assert.ok(plan.blocks);
    const result = await runPlan(plan.blocks, f.deps);
    assert.equal(result.verdict, 'REFUSED');
    assert.equal('code' in result && result.code, safe.code);
    assert.equal('message' in result && result.message, safe.message);
    assert.equal(JSON.stringify({ result, rows: f.rows }).includes(secret), false);
    assert.equal(exitCodeFor(resultForWalk(result, 'test-lease')), 4);
  }
  await assert.rejects(
    captureScreen({
      requirePrivateInputs: true,
      native: async () => ({ nodes: [] }),
      react: async () => {
        throw new NativeCaptureError();
      },
    }),
    PrivateInputCaptureError,
  );
  await assert.rejects(
    captureScreen({
      requirePrivateInputs: true,
      native: async () => {
        throw new PrivateInputCaptureError();
      },
      react: async () => assert.fail('native failed before private acquisition'),
    }),
    NativeCaptureError,
  );
});

test('bound observations are revalidated even without required mode and copy exact values', async () => {
  const react = bindPrivateInputs(observation(), payload());
  react.hostEvidence = { complete: false, hosts: [] };
  await assert.rejects(
    captureScreen({
      native: async () => ({ nodes: [] }),
      react: async () => react,
    }),
    PrivateInputCaptureError,
  );
  const data = payload([`  ${secret}  `]);
  const bound = bindPrivateInputs(Object.freeze(observation()), data);
  data.facts[0].values[0] = 'changed-after-binding';
  const screen = await captureScreen({
    native: async () => ({ nodes: [] }),
    react: async () => bound,
  });
  assert.equal(JSON.stringify(screen).includes(secret), false);
  const privacy = new ObservedPrivacy();
  privacy.observe(screen);
  assert.equal(privacy.redact(`  ${secret}  `), '•••');
  assert.equal(privacy.redact(secret), '•••');
  const judge = scriptedJudge(() => assert.fail('literals must be local'));
  for (const text of [secret, '•••', '[QAREN_VALUE_1]']) {
    assert.equal(
      (
        await decideScreen(screen, judge, {
          kind: 'check',
          text,
          literal: true,
          line: 1,
        })
      ).check,
      'fail',
    );
  }
});

test('RN secure facts taint generic native values without granting input capabilities', async () => {
  for (const duplicate of [false, true]) {
    const react = observation();
    react.hostEvidence = {
      complete: true,
      hosts: [{ testID: 'password', role: null, roleSource: 'none', capabilities: {} }],
    };
    const nativeSecret = 'different-native-password';
    const node = {
      ref: '@password',
      identifier: 'password',
      type: 'Other',
      label: 'Password',
      value: nativeSecret,
    };
    const screen = await captureScreen({
      native: async () => ({ nodes: duplicate ? [node, { ...node, ref: '@duplicate' }] : [node] }),
      react: async () => bindPrivateInputs(react, payload([], true)),
    });
    assert.ok(screen.elements.every((e) => e.kind === 'other' && e.semantic?.fill !== 'supported'));
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(privacy.redact(nativeSecret), '•••');
    assert.equal(privacy.canScreenshot(), false);
    const judge = scriptedJudge(() => assert.fail('uncertain secret contents must not be judged'));
    for (const text of [
      'Password is valid',
      'Password field is filled',
      'Password contains other',
    ]) {
      assert.equal(
        (
          await decideScreen(screen, judge, {
            kind: 'check',
            literal: false,
            text,
            line: 1,
          })
        ).check,
        'unsure',
      );
    }
    const unrelated = scriptedJudge(() => ({ check_1: { type: 'noul', noul: 0.99 } }));
    for (const text of ['Welcome is visible', 'Welcome heading is valid']) {
      assert.equal(
        (
          await decideScreen(screen, unrelated, {
            kind: 'check',
            literal: false,
            text,
            line: 1,
          })
        ).check,
        'pass',
      );
    }
    assert.equal(JSON.stringify(unrelated.requests).includes(nativeSecret), false);
  }
});

test('anonymous secure empty captures still withhold pixels and conceal uncertain native input values', async () => {
  const screen = await captureScreen({
    native: async () => ({ nodes: [{ ref: '@unknown', type: 'Other', value: secret }] }),
    react: async () => bindPrivateInputs(observation(), payload([], true)),
  });
  const privacy = new ObservedPrivacy();
  privacy.observe(screen);
  assert.equal(privacy.redact(secret), '•••');
  assert.equal(privacy.canScreenshot(), false);
  const empty = await captureScreen({
    native: async () => ({ nodes: [] }),
    react: async () => bindPrivateInputs(observation(), payload([], true)),
  });
  const emptyPrivacy = new ObservedPrivacy();
  emptyPrivacy.observe(empty);
  assert.equal(emptyPrivacy.canScreenshot(), false);
});

test('nonsecure native equality remains authoritative without treating a static label as another input', async () => {
  const react = observation();
  react.hostEvidence = {
    complete: true,
    hosts: [{ testID: 'email', role: null, roleSource: 'none', capabilities: {} }],
  };
  const screen = await captureScreen({
    native: async () => ({
      nodes: [
        { ref: '@label', type: 'StaticText', label: 'Email' },
        { ref: '@email', identifier: 'email', type: 'TextField', label: 'Email', value: secret },
      ],
    }),
    react: async () => bindPrivateInputs(react, payload()),
  });
  const judge = scriptedJudge(() => ({ check_1: { type: 'noul', noul: 0.99 } }));
  assert.equal(
    (
      await decideScreen(screen, judge, {
        kind: 'check',
        literal: false,
        text: `Email field contains ${secret}`,
        line: 1,
      })
    ).check,
    'pass',
  );
  assert.equal(judge.requests.length, 1);
  assert.equal(JSON.stringify(judge.requests).includes(secret), false);
  for (const [text, expected] of [
    [secret, 'pass'],
    ['•••', 'fail'],
    ['[QAREN_VALUE_1]', 'fail'],
  ] as const) {
    assert.equal(
      (
        await decideScreen(
          screen,
          judge,
          {
            kind: 'check',
            literal: true,
            text,
            line: 1,
          },
          { kind: 'fill', target: { quoted: 'Email', phrase: 'Email' }, text: 'new', line: 2 },
        )
      ).check,
      expected,
    );
  }
});

test('ambiguous secure associations without native names cannot delegate content claims', async () => {
  const react = observation();
  react.hostEvidence = {
    complete: true,
    hosts: [{ testID: 'opaque-id', role: null, roleSource: 'none', capabilities: {} }],
  };
  const screen = await captureScreen({
    native: async () => ({
      nodes: [
        { ref: '@one', type: 'Other', identifier: 'opaque-id' },
        { ref: '@two', type: 'Other', identifier: 'opaque-id' },
      ],
    }),
    react: async () => bindPrivateInputs(react, payload([], true)),
  });
  const judge = scriptedJudge(() =>
    assert.fail('unknown associations cannot prove input contents'),
  );
  assert.equal(
    (
      await decideScreen(screen, judge, {
        kind: 'check',
        literal: false,
        text: 'Password is valid',
        line: 1,
      })
    ).check,
    'unsure',
  );
});

test('duplicate React input identities cannot collapse into one authoritative native subject', async () => {
  const react = observation();
  const host = { testID: 'email', role: null, roleSource: 'none', capabilities: {} };
  react.hostEvidence = { complete: true, hosts: [host, host] };
  const screen = await captureScreen({
    native: async () => ({
      nodes: [
        { ref: '@email', identifier: 'email', type: 'TextField', label: 'Email', value: secret },
      ],
    }),
    react: async () =>
      bindPrivateInputs(react, {
        ...payload(),
        facts: [payload().facts[0], { ...payload().facts[0], hostIndex: 1 }],
      }),
  });
  const judge = scriptedJudge(() => assert.fail('duplicate host identities remain uncertain'));
  assert.equal(
    (
      await decideScreen(screen, judge, {
        kind: 'check',
        literal: false,
        text: `Email contains ${secret}`,
        line: 1,
      })
    ).check,
    'unsure',
  );
});

test('a bound capture with private native input evidence withholds pixels even with no React input facts', async () => {
  const screen = await captureScreen({
    native: async () => ({ nodes: [{ ref: '@native', type: 'SecureTextField', value: secret }] }),
    react: async () => bindPrivateInputs(observation(), { version: 1, complete: true, facts: [] }),
  });
  const privacy = new ObservedPrivacy();
  privacy.observe(screen);
  assert.equal(privacy.canScreenshot(), false);
});

test('secure generic native accessibility labels may be values even without native input metadata', async () => {
  for (const identifier of ['password', undefined]) {
    const react = observation();
    react.hostEvidence = {
      complete: true,
      hosts: [{ testID: 'password', role: null, roleSource: 'none', capabilities: {} }],
    };
    const screen = await captureScreen({
      native: async () => ({
        nodes: [{ ref: '@password', type: 'Other', identifier, label: secret }],
      }),
      react: async () => bindPrivateInputs(react, payload([], true)),
    });
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(privacy.redact(secret), '•••');
  }
});

test('private binding rejects more than three values per fact and more than 600 overall', async () => {
  const host = { role: null, roleSource: 'none', capabilities: {} };
  for (const facts of [
    [{ hostIndex: 0, values: ['a', 'b', 'c', 'd'], secure: false }],
    [
      {
        hostIndex: 0,
        values: ['a'.repeat(4096), 'b'.repeat(4096), 'c'.repeat(4096)],
        secure: false,
      },
      { hostIndex: 1, values: ['d'.repeat(4096), 'e'], secure: false },
    ],
    Array.from({ length: 199 }, (_, hostIndex) => ({
      hostIndex,
      values: Array.from({ length: hostIndex === 0 ? 7 : 3 }, () => ''),
      secure: false,
    })),
  ]) {
    await assert.rejects(
      captureScreen({
        requirePrivateInputs: true,
        native: async () => ({ nodes: [] }),
        react: async () =>
          bindPrivateInputs(
            {
              ...observation(),
              hostEvidence: { complete: true, hosts: Array.from({ length: 199 }, () => host) },
            },
            { version: 1, complete: true, facts },
          ),
      }),
      PrivateInputCaptureError,
    );
  }
  const screen = await captureScreen({
    native: async () => ({ nodes: [] }),
    react: async () => bindPrivateInputs(observation(), payload([' 7 ', 'é', 'x\ny'])),
  });
  const privacy = new ObservedPrivacy();
  privacy.observe(screen);
  assert.equal(privacy.redact(' 7 |é|x\ny'), '•••|•••|•••');
  assert.deepEqual(screen.visibleText, []);
});

test('private-capture short values mask concatenated echoes but never become local assertion evidence', async () => {
  for (const value of ['7', 'ab', '.']) {
    const echo = `code=${value} x${value}x`;
    const screen = await captureScreen({
      requirePrivateInputs: true,
      native: async () => ({ nodes: [{ ref: '@echo', type: 'StaticText', label: echo }] }),
      react: async () => bindPrivateInputs(observation(), payload([value])),
    });
    const judge = scriptedJudge((_, __, state) => {
      assert.deepEqual(state, {
        front: 'app',
        visibleText: ['code=[QAREN_VALUE_1] x[QAREN_VALUE_1]x'],
      });
      return { check_1: { type: 'noul', noul: 0.99 } };
    });
    await decideScreen(screen, judge, {
      kind: 'check',
      text: 'Welcome is visible',
      literal: false,
      line: 1,
    });
    assert.equal(judge.requests.length, 1);
    assert.equal(redactEvidence(screen, echo), 'code=••• x•••x');
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(privacy.redact(echo), 'code=••• x•••x');
    const local = scriptedJudge(() => assert.fail('quoted checks must not ask the model'));
    for (const [text, expected] of [
      [echo, 'pass'],
      ['•••', 'fail'],
      ['[QAREN_VALUE_1]', 'fail'],
    ] as const) {
      assert.equal(
        (
          await decideScreen(screen, local, {
            kind: 'check',
            text,
            literal: true,
            line: 1,
          })
        ).check,
        expected,
      );
    }
  }
});

test('short-value private provenance survives later captures without widening typed-only masking', async () => {
  const first = await captureScreen({
    native: async () => ({ nodes: [{ ref: '@welcome', type: 'StaticText', label: 'Welcome' }] }),
    react: async () => bindPrivateInputs(observation(), payload(['7'])),
  });
  const echo = 'code=7 x7x code=z xzx';
  const later = await captureScreen({
    native: async () => ({ nodes: [{ ref: '@echo', type: 'StaticText', label: echo }] }),
    react: async () => bindPrivateInputs(observation(), { version: 1, complete: true, facts: [] }),
  });
  const judge = scriptedJudge((_, __, state) => {
    assert.deepEqual(state, {
      front: 'app',
      visibleText: ['code=[QAREN_VALUE_2] x[QAREN_VALUE_2]x code=[QAREN_VALUE_1] xzx'],
    });
    return { check_4: { type: 'noul', noul: 0.99 } };
  });
  const f = walker([first, later], judge);
  const plan = parsePlan(
    `## First\n✓ "Welcome"\n## Second\n✓ Welcome is visible\n✓ "${echo}"\n1. Fill "Missing" with "z"`,
  );
  assert.ok(plan.blocks);
  const result = await runPlan(plan.blocks, f.deps);
  assert.equal(judge.requests.length, 1);
  assert.ok(result.steps.some((row) => row.text.includes('code=••• x•••x code=z xzx')));
  assert.equal(JSON.stringify(result).includes('x7x'), false);
  const typedOnly = new ObservedPrivacy(['7', 'z']);
  typedOnly.observe(later);
  assert.equal(typedOnly.redact(echo), echo);
});
