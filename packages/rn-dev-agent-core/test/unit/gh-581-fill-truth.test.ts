// GH #581: device_fill truth matrix — exact binding, single-operation native
// dispatch, final-verification arbitration, mutation-safe descent, and secret
// scrubbing, driven through the runNative seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _setActiveSessionForTest, _setRunAgentDeviceForTest, markSnapshotDirty } =
  await import('../../dist/agent-device-wrapper.js');
const { performExactFill, extractTypingMeta } = await import('../../dist/tools/device-interact.js');
const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
const { okResult, failResult } = await import('../../dist/utils.js');

const NODES = [
  {
    ref: '@e1',
    identifier: 'first-name-pressable',
    type: 'Other',
    rect: { x: 20, y: 100, width: 360, height: 60 },
  },
  {
    ref: '@e2',
    identifier: 'first-name',
    type: 'TextField',
    rect: { x: 40, y: 110, width: 320, height: 40 },
  },
  {
    ref: '@e3',
    identifier: 'last-name',
    type: 'TextField',
    rect: { x: 40, y: 180, width: 320, height: 40 },
  },
  {
    ref: '@e4',
    identifier: 'password',
    type: 'SecureTextField',
    rect: { x: 40, y: 250, width: 320, height: 40 },
  },
  {
    ref: '@e5',
    identifier: 'submit',
    type: 'Button',
    rect: { x: 40, y: 320, width: 320, height: 40 },
  },
];

interface Call {
  cliArgs: string[];
  opts: Record<string, unknown>;
}

interface SeamConfig {
  platform?: 'ios' | 'android';
  nodes?: typeof NODES;
  snapshot?: (count: number) => typeof NODES;
  fill?: (call: Call, fillCount: number) => ReturnType<typeof okResult>;
  verify?: (call: Call, verifyCount: number) => ReturnType<typeof okResult>;
}

async function withFillSeam<T>(
  config: SeamConfig,
  run: () => Promise<T>,
): Promise<{ result: T; calls: Call[] }> {
  const platform = config.platform ?? 'ios';
  _setActiveSessionForTest({ platform, deviceId: 'TEST-DEVICE', appId: 'com.test' });
  clearRefMap();
  markSnapshotDirty();
  const nodes = config.nodes ?? NODES;
  updateRefMapFromFlat(nodes as never, { snapshotGeneration: 7, keyboardVisible: false });
  const calls: Call[] = [];
  let fillCount = 0;
  let verifyCount = 0;
  let snapshotCount = 0;
  let lastFill: { target: string; text: string } | null = null;
  _setRunAgentDeviceForTest(async (cliArgs: string[], opts: Record<string, unknown>) => {
    const call = { cliArgs, opts };
    calls.push(call);
    if (cliArgs[0] === 'snapshot') {
      snapshotCount += 1;
      const snapshotNodes = config.snapshot?.(snapshotCount) ?? nodes;
      updateRefMapFromFlat(snapshotNodes as never, {
        snapshotGeneration: 6 + snapshotCount,
        keyboardVisible: false,
      });
      return okResult({ nodes: snapshotNodes });
    }
    if (cliArgs[0] === 'fill') {
      fillCount += 1;
      lastFill = { target: cliArgs[1], text: cliArgs[2] };
      return config.fill
        ? config.fill(call, fillCount)
        : okResult({ typed: true, focusTap: 'performed', inputResolution: 'descriptor' });
    }
    if (cliArgs[0] === 'verify-input') {
      verifyCount += 1;
      if (config.verify) return config.verify(call, verifyCount);
      // The default oracle only reports exact for the value/target the fill
      // actually dispatched — a wrong-value verification can never pass it.
      const matchesFill =
        lastFill !== null && cliArgs[1] === lastFill.target && cliArgs[2] === lastFill.text;
      return matchesFill
        ? okResult({ verifyVerdict: 'exact', verifyStable: true })
        : okResult({ verifyVerdict: 'mismatch', verifyStable: true });
    }
    return okResult({});
  });
  try {
    const result = await run();
    return { result, calls };
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
    clearRefMap();
  }
}

function envelope(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

const NATIVE_ONLY = { js: false, maestro: false };

function fakeClient(handlers: {
  read?: () => { value?: string | null; controlled?: boolean } | null;
  typeText?: () => Record<string, unknown>;
}) {
  return {
    isConnected: true,
    evaluate: async (expr: string) => {
      if (expr.includes('readInputValue')) {
        const read = handlers.read?.();
        if (!read) return { error: 'unreadable' };
        return {
          value: JSON.stringify({ value: read.value ?? null, controlled: read.controlled ?? true }),
        };
      }
      if (expr.includes('typeText')) {
        return { value: JSON.stringify(handlers.typeText?.() ?? { error: 'no handler' }) };
      }
      return { value: JSON.stringify({}) };
    },
  } as never;
}

test('gh-581: wrapper binds its inner input and dispatches one exact native operation', async () => {
  const { result, calls } = await withFillSeam({}, () =>
    performExactFill({ ref: '@e1', text: 'Anna' }, null, NATIVE_ONLY),
  );
  assert.ok(!(result as { isError?: boolean }).isError, envelope(result as never).error);
  const env = envelope(result as never);
  assert.deepEqual(env.data, { filled: true, method: 'native', length: 4 });
  assert.equal(env.meta.verify, 'exact');
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'press'), 'no separate pre-tap press');
  const fill = calls.find((c) => c.cliArgs[0] === 'fill')!;
  assert.equal(fill.cliArgs[1], '@e2', 'fill targets the inner input, not the wrapper');
  const exactTarget = fill.opts.exactTarget as Record<string, number | string>;
  assert.equal(exactTarget.inputRef, '@e2');
  assert.equal(exactTarget.focusX, 200, 'focus tap is the wrapper center');
  assert.equal(exactTarget.focusY, 130);
  const verify = calls.find((c) => c.cliArgs[0] === 'verify-input')!;
  assert.equal(verify.cliArgs[1], '@e2');
});

test('gh-581: direct testID ref binds without a wrapper', async () => {
  const { result, calls } = await withFillSeam({}, () =>
    performExactFill({ ref: 'last-name', text: 'Ng' }, null, NATIVE_ONLY),
  );
  assert.ok(!(result as { isError?: boolean }).isError);
  const fill = calls.find((c) => c.cliArgs[0] === 'fill')!;
  assert.equal(fill.cliArgs[1], '@e3');
  assert.equal((fill.opts.exactTarget as { focusX: number }).focusX, 200);
});

test('gh-581: final verification uses the fill operation token after ref recycling', async () => {
  const replacement = NODES.map((node) =>
    node.identifier === 'last-name'
      ? { ...node, ref: '@e8', identifier: 'replacement-name' }
      : node,
  );
  const { result, calls } = await withFillSeam(
    {
      fill: (call) => {
        updateRefMapFromFlat(replacement as never, {
          snapshotGeneration: 8,
          keyboardVisible: false,
        });
        return okResult({ typed: true, operationToken: call.opts.exactTarget });
      },
      verify: () => okResult({ verifyVerdict: 'exact', verifyStable: true }),
    },
    () => performExactFill({ ref: '@e3', text: 'Ng' }, null, NATIVE_ONLY),
  );
  assert.ok(!(result as { isError?: boolean }).isError, envelope(result as never).error);
  const fill = calls.find((call) => call.cliArgs[0] === 'fill')!;
  const verify = calls.find((call) => call.cliArgs[0] === 'verify-input')!;
  const fillTarget = fill.opts.exactTarget as { inputRef: string; operationToken: string };
  const verifyTarget = verify.opts.exactTarget as { inputRef: string; operationToken: string };
  assert.equal(verify.cliArgs[1], '@e3');
  assert.equal(verifyTarget.inputRef, '@e3');
  assert.ok(fillTarget.operationToken.length > 0);
  assert.equal(verifyTarget.operationToken, fillTarget.operationToken);
});

test('gh-581: duplicate wrapper mapping rejects without mutation', async () => {
  const nodes = [
    ...NODES,
    {
      ref: '@e9',
      identifier: 'first-name',
      type: 'TextField',
      rect: { x: 40, y: 400, width: 320, height: 40 },
    },
  ];
  const { result, calls } = await withFillSeam({ nodes }, () =>
    performExactFill({ ref: '@e1', text: 'Anna' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'), 'no mutation dispatched');
});

test('gh-581: duplicate direct testIDs reject without mutation', async () => {
  const nodes = [
    ...NODES,
    {
      ref: '@e9',
      identifier: 'last-name',
      type: 'TextField',
      rect: { x: 40, y: 400, width: 320, height: 40 },
    },
  ];
  const { result, calls } = await withFillSeam({ nodes }, () =>
    performExactFill({ ref: 'last-name', text: 'x' }, null, NATIVE_ONLY),
  );
  assert.equal(envelope(result as never).code, 'NO_TEXT_INPUT_TARGET');
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'));
});

test('gh-581: a non-input ref rejects instead of typing into ambient focus', async () => {
  const { result, calls } = await withFillSeam({}, () =>
    performExactFill({ ref: '@e5', text: 'x' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'));
});

test('gh-581: unverifiable outcome is an error, never filled:true', async () => {
  const { result, calls } = await withFillSeam(
    { verify: () => okResult({ verifyVerdict: 'unreadable', verifyStable: false }) },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'possible');
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1, 'no blind retype');
});

test('gh-581: unstable native exact never promotes to success', async () => {
  const { result } = await withFillSeam(
    { verify: () => okResult({ verifyVerdict: 'exact', verifyStable: false }) },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  assert.equal(envelope(result as never).code, 'TEXT_ENTRY_UNVERIFIED');
});

test('gh-581: stable mismatch retypes clear-first against the same target, then succeeds', async () => {
  const { result, calls } = await withFillSeam(
    {
      verify: (_call, verifyCount) =>
        verifyCount === 1
          ? okResult({ verifyVerdict: 'mismatch', verifyStable: true })
          : okResult({ verifyVerdict: 'exact', verifyStable: true }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  assert.ok(!(result as { isError?: boolean }).isError);
  const fills = calls.filter((c) => c.cliArgs[0] === 'fill');
  assert.equal(fills.length, 2);
  assert.ok(!fills[0].cliArgs.includes('--clear-first'));
  assert.ok(fills[1].cliArgs.includes('--clear-first'), 'correction is clear-first');
  assert.equal(fills[1].cliArgs[1], '@e3', 'correction stays on the same target');
  const env = envelope(result as never);
  assert.equal(env.meta.textEntryPath, 'native-retype');
  assert.equal(env.meta.verify, 'exact');
});

test('gh-581: corrective refusal cannot erase an earlier mutation', async () => {
  const { result, calls } = await withFillSeam(
    {
      fill: (_call, fillCount) =>
        fillCount === 1
          ? okResult({ typed: true })
          : failResult('target moved', 'FOCUS_TARGET_OCCLUDED', { mutation: 'none' }),
      verify: () => okResult({ verifyVerdict: 'mismatch', verifyStable: true }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'possible');
  assert.equal(calls.filter((call) => call.cliArgs[0] === 'fill').length, 2);
});

test('gh-581: secure uncontrolled masked value hard-fails and is not retried', async () => {
  const { result, calls } = await withFillSeam(
    { verify: () => okResult({ verifyVerdict: 'secure-masked', verifyStable: true }) },
    () => performExactFill({ ref: '@e4', text: 'value-a' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1);
  const verify = calls.find((c) => c.cliArgs[0] === 'verify-input')!;
  assert.equal((verify.opts.exactTarget as { secure?: boolean }).secure, true);
});

test('gh-581: ambiguous and target-lost verdicts hard-fail without retype', async () => {
  for (const verdict of ['ambiguous', 'target-lost']) {
    const { result, calls } = await withFillSeam(
      { verify: () => okResult({ verifyVerdict: verdict, verifyStable: true }) },
      () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
    );
    assert.equal(envelope(result as never).code, 'TEXT_ENTRY_UNVERIFIED', verdict);
    assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1, verdict);
  }
});

test('gh-581: runner refusal with mutation none maps to NO_TEXT_INPUT_TARGET', async () => {
  const { result } = await withFillSeam(
    {
      fill: () =>
        failResult('NO_TEXT_INPUT_TARGET: gone', 'NO_TEXT_INPUT_TARGET', { mutation: 'none' }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
});

test('gh-581: occluded focus preserves its mutation-free refusal code', async () => {
  const { result } = await withFillSeam(
    {
      fill: () =>
        failResult('focus point is occluded', 'FOCUS_TARGET_OCCLUDED', { mutation: 'none' }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'FOCUS_TARGET_OCCLUDED');
  assert.equal(env.meta.mutation, 'none');
});

test('gh-581: possibly-mutating runner failure recovers ONLY via exact read-back', async () => {
  const recovered = await withFillSeam(
    {
      fill: () => failResult('timeout', 'RUNNER_TIMEOUT', { mutation: 'possible' }),
      verify: () => okResult({ verifyVerdict: 'exact', verifyStable: true }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const recoveredEnv = envelope(recovered.result as never);
  assert.equal(recoveredEnv.data.filled, true);
  assert.equal(recoveredEnv.meta.recovered, 'post-error-exact-readback');
  assert.equal(recovered.calls.filter((c) => c.cliArgs[0] === 'fill').length, 1, 'never resent');

  const unproven = await withFillSeam(
    {
      fill: () => failResult('timeout', 'RUNNER_TIMEOUT', { mutation: 'possible' }),
      verify: () => okResult({ verifyVerdict: 'unreadable', verifyStable: false }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const unprovenEnv = envelope(unproven.result as never);
  assert.equal(unprovenEnv.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(unprovenEnv.meta.mutation, 'possible');
  assert.equal(unproven.calls.filter((c) => c.cliArgs[0] === 'fill').length, 1, 'never resent');
});

test('gh-581: unlabeled runner failure defaults to possible mutation (no blind descent)', async () => {
  const { result, calls } = await withFillSeam(
    {
      fill: () => failResult('mystery failure'),
      verify: () => okResult({ verifyVerdict: 'unreadable', verifyStable: false }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  assert.equal(envelope(result as never).code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1);
});

test('gh-581: empty text is a verified clear (clear-first dispatch + exact empty read-back)', async () => {
  const { result, calls } = await withFillSeam({}, () =>
    performExactFill({ ref: '@e3', text: '' }, null, NATIVE_ONLY),
  );
  assert.ok(!(result as { isError?: boolean }).isError);
  const fill = calls.find((c) => c.cliArgs[0] === 'fill')!;
  assert.ok(fill.cliArgs.includes('--clear-first'));
  const env = envelope(result as never);
  assert.deepEqual(env.data, { filled: true, method: 'native', length: 0 });
  const verify = calls.find((c) => c.cliArgs[0] === 'verify-input')!;
  assert.equal(verify.cliArgs[2], '');
});

test('gh-581: SET_TEXT_REJECTED without a Maestro tier fails truthfully', async () => {
  const { result } = await withFillSeam(
    { fill: () => failResult('rejected', 'SET_TEXT_REJECTED', { mutation: 'none' }) },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  assert.equal(envelope(result as never).code, 'TEXT_ENTRY_UNVERIFIED');
});

test('gh-581: Maestro verification rebinds by testID after runner parking', async () => {
  const { result, calls } = await withFillSeam(
    {
      fill: () => failResult('rejected', 'SET_TEXT_REJECTED', { mutation: 'none' }),
      verify: () => okResult({ verifyVerdict: 'exact', verifyStable: true }),
    },
    () =>
      performExactFill(
        { ref: '@e3', text: 'value' },
        null,
        { js: false, maestro: true },
        { maestroFillAttempt: async () => ({ attempted: true }) },
      ),
  );
  assert.equal(envelope(result as never).data.method, 'maestro');
  const fill = calls.find((call) => call.cliArgs[0] === 'fill')!;
  const verify = calls.find((call) => call.cliArgs[0] === 'verify-input')!;
  assert.ok((fill.opts.exactTarget as { operationToken?: string }).operationToken);
  assert.equal(
    (verify.opts.exactTarget as { operationToken?: string }).operationToken,
    undefined,
  );
});

test('gh-581: possible SET_TEXT_REJECTED hard-fails without verification', async () => {
  const { result, calls } = await withFillSeam(
    {
      fill: () => failResult('rejected', 'SET_TEXT_REJECTED', { mutation: 'possible' }),
      verify: () => okResult({ verifyVerdict: 'exact', verifyStable: true }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'possible');
  assert.equal(calls.filter((call) => call.cliArgs[0] === 'verify-input').length, 0);
});

test('gh-581: observed SET_TEXT_REJECTED requires independent verification', async () => {
  const exact = await withFillSeam(
    {
      fill: () => failResult('rejected', 'SET_TEXT_REJECTED', { mutation: 'observed' }),
      verify: () => okResult({ verifyVerdict: 'exact', verifyStable: true }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  assert.equal(envelope(exact.result as never).data.filled, true);
  assert.equal(exact.calls.filter((call) => call.cliArgs[0] === 'verify-input').length, 1);

  const mismatch = await withFillSeam(
    {
      fill: () => failResult('rejected', 'SET_TEXT_REJECTED', { mutation: 'observed' }),
      verify: () => okResult({ verifyVerdict: 'mismatch', verifyStable: true }),
    },
    () => performExactFill({ ref: '@e3', text: 'value' }, null, NATIVE_ONLY),
  );
  const mismatchEnv = envelope(mismatch.result as never);
  assert.equal(mismatchEnv.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(mismatchEnv.meta.mutation, 'observed');
  assert.equal(mismatch.calls.filter((call) => call.cliArgs[0] === 'verify-input').length, 1);
});

test('gh-581: android parity — EditText fixtures, same arbiter, same success rule', async () => {
  const androidNodes = [
    {
      ref: '@e1',
      identifier: 'first-name-pressable',
      type: 'android.view.ViewGroup',
      rect: { x: 20, y: 100, width: 360, height: 60 },
    },
    {
      ref: '@e2',
      identifier: 'first-name',
      type: 'android.widget.EditText',
      rect: { x: 40, y: 110, width: 320, height: 40 },
    },
  ];
  const { result, calls } = await withFillSeam(
    { platform: 'android', nodes: androidNodes as never },
    () => performExactFill({ ref: '@e1', text: 'Anna' }, null, NATIVE_ONLY),
  );
  assert.ok(!(result as { isError?: boolean }).isError, envelope(result as never).error);
  assert.equal(envelope(result as never).meta.verify, 'exact');
  const fill = calls.find((c) => c.cliArgs[0] === 'fill')!;
  assert.equal(fill.cliArgs[1], '@e2', 'binds the EditText, not the ViewGroup wrapper');
  assert.ok(calls.some((c) => c.cliArgs[0] === 'verify-input'));
});

test('gh-581: bare "EditText" snapshot type never binds on Android', async () => {
  const bareNodes = [
    {
      ref: '@e2',
      identifier: 'first-name',
      type: 'EditText',
      rect: { x: 40, y: 110, width: 320, height: 40 },
    },
  ];
  const { result } = await withFillSeam({ platform: 'android', nodes: bareNodes as never }, () =>
    performExactFill({ ref: '@e2', text: 'Anna' }, null, NATIVE_ONLY),
  );
  assert.equal(envelope(result as never).code, 'NO_TEXT_INPUT_TARGET');
});

test('gh-581: readable fiber/native disagreement hard-fails without retype', async () => {
  const client = fakeClient({ read: () => ({ value: 'value', controlled: true }) });
  const { result, calls } = await withFillSeam(
    { verify: () => okResult({ verifyVerdict: 'mismatch', verifyStable: true }) },
    () => performExactFill({ ref: '@e3', text: 'value' }, client, NATIVE_ONLY),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(
    calls.filter((c) => c.cliArgs[0] === 'fill').length,
    1,
    'disagreement never retypes',
  );
});

test('gh-581: device_batch fill uses the same arbiter and cannot soft-accept', async () => {
  const { createDeviceBatchHandler } = await import('../../dist/tools/device-batch.js');
  const { result, calls } = await withFillSeam(
    { verify: () => okResult({ verifyVerdict: 'unreadable', verifyStable: false }) },
    async () => {
      const handler = createDeviceBatchHandler();
      return handler({
        steps: [
          { action: 'fill', ref: '@e3', text: 'value', optional: true },
          { action: 'fill', ref: '@e3', text: 'later' },
        ],
        continueOnError: true,
        finalSnapshot: 'none',
        delayMs: 0,
      });
    },
  );
  const env = envelope(result as never);
  const stepResults = (env.data?.steps ?? env.data?.results ?? []) as Array<
    Record<string, unknown>
  >;
  const serialized = JSON.stringify(env);
  assert.ok(!serialized.includes('"filled":true'), 'batch must not soft-accept an unverified fill');
  assert.ok(stepResults.length > 0 || env.ok === false, 'batch surfaced the step outcome');
  assert.equal(env.meta.failed_step.meta.mutation, 'possible');
  assert.match(env.meta.failed_step.meta.hint, /do not blindly/);
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1);
});

test('gh-581: controlled input fills via the fiber and verifies exact without native typing', async () => {
  let value = '';
  const client = fakeClient({
    read: () => ({ value, controlled: true }),
    typeText: () => {
      value = 'Anna';
      return { controlled: true, handlerCalled: 'onChangeText', valueBefore: '' };
    },
  });
  const { result, calls } = await withFillSeam(
    { verify: () => okResult({ verifyVerdict: 'exact', verifyStable: true }) },
    () => performExactFill({ ref: '@e2', text: 'Anna' }, client, { js: true, maestro: false }),
  );
  assert.ok(!(result as { isError?: boolean }).isError);
  const env = envelope(result as never);
  assert.deepEqual(env.data, { filled: true, method: 'js-onChangeText', length: 4 });
  assert.equal(env.meta.verify, 'exact');
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'), 'no native typing after fiber success');
});

test('gh-581: native target loss vetoes controlled fiber success', async () => {
  let value = '';
  const client = fakeClient({
    read: () => ({ value, controlled: true }),
    typeText: () => {
      value = 'Anna';
      return { controlled: true, handlerCalled: 'onChangeText', valueBefore: '' };
    },
  });
  const { result, calls } = await withFillSeam(
    { verify: () => okResult({ verifyVerdict: 'target-lost', verifyStable: false }) },
    () => performExactFill({ ref: '@e2', text: 'Anna' }, client, { js: true, maestro: false }),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'possible');
  assert.ok(calls.some((c) => c.cliArgs[0] === 'verify-input'));
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'));
});

test('gh-581: conflicting explicit testID rejects before any mutation', async () => {
  const { result, calls } = await withFillSeam({}, () =>
    performExactFill(
      { ref: '@e2', testID: 'last-name', text: 'Anna' },
      fakeClient({ read: () => ({ value: '', controlled: true }) }),
      { js: true, maestro: false },
    ),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'));
});

test('gh-581: cancellation after mismatch prevents corrective retype', async () => {
  const abortController = new AbortController();
  const { result, calls } = await withFillSeam(
    {
      verify: () => {
        abortController.abort();
        return okResult({ verifyVerdict: 'mismatch', verifyStable: true });
      },
    },
    () =>
      performExactFill({ ref: '@e3', text: 'value' }, null, {
        ...NATIVE_ONLY,
        abortSignal: abortController.signal,
      }),
  );
  const env = envelope(result as never);
  assert.equal(env.meta.mutation, 'possible');
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1);
});

test('gh-581: uncontrolled probe skips the JS tier entirely (no handler double-fire)', async () => {
  let typeTextCalls = 0;
  const client = fakeClient({
    read: () => ({ value: null, controlled: false }),
    typeText: () => {
      typeTextCalls += 1;
      return { controlled: false, handlerCalled: 'onChangeText', valueBefore: null };
    },
  });
  const { result, calls } = await withFillSeam({}, () =>
    performExactFill({ ref: '@e2', text: 'Anna' }, client, { js: true, maestro: false }),
  );
  assert.ok(!(result as { isError?: boolean }).isError);
  assert.equal(typeTextCalls, 0, 'fiber typeText never fired for an uncontrolled input');
  assert.ok(
    calls.some((c) => c.cliArgs[0] === 'fill'),
    'native tier used',
  );
});

test('gh-581: an uncertain JS dispatch hard-fails as possible mutation without native descent', async () => {
  const client = {
    isConnected: true,
    evaluate: async (expr: string) => {
      if (expr.includes('readInputValue')) {
        return { value: JSON.stringify({ value: '', controlled: true }) };
      }
      throw new Error('socket closed mid-dispatch');
    },
  } as never;
  const { result, calls } = await withFillSeam({}, () =>
    performExactFill({ ref: '@e2', text: 'Anna' }, client, { js: true, maestro: false }),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'possible');
  assert.ok(
    !calls.some((c) => c.cliArgs[0] === 'fill'),
    'no native typing after uncertain dispatch',
  );
});

test('gh-581: no envelope ever echoes the requested text', async () => {
  const secret = 'sekrit-canary-1234';
  const scenarios: Array<() => Promise<{ result: unknown }>> = [
    () => withFillSeam({}, () => performExactFill({ ref: '@e1', text: secret }, null, NATIVE_ONLY)),
    () =>
      withFillSeam(
        { verify: () => okResult({ verifyVerdict: 'unreadable', verifyStable: false }) },
        () => performExactFill({ ref: '@e3', text: secret }, null, NATIVE_ONLY),
      ),
    () =>
      withFillSeam(
        { fill: () => failResult('refused', 'NO_TEXT_INPUT_TARGET', { mutation: 'none' }) },
        () => performExactFill({ ref: '@e3', text: secret }, null, NATIVE_ONLY),
      ),
    () => {
      let value = '';
      const client = fakeClient({
        read: () => ({ value, controlled: true }),
        typeText: () => {
          value = secret;
          return { controlled: true, handlerCalled: 'onChangeText', valueBefore: '' };
        },
      });
      return withFillSeam({}, () =>
        performExactFill({ ref: '@e2', text: secret }, client, { js: true, maestro: false }),
      );
    },
  ];
  for (const scenario of scenarios) {
    const outcome = await scenario();
    const text = (outcome.result as { content: Array<{ text: string }> }).content[0].text;
    assert.ok(!text.includes(secret), 'envelope leaked the requested text (redacted)');
  }
});

test('gh-581: extractTypingMeta surfaces typingBurst + keyboardWaitMs from the runner envelope', () => {
  const result = okResult({ typed: true, typingBurst: true, keyboardWaitMs: 120 });
  assert.deepEqual(extractTypingMeta(result), { burst: true, keyboardWaitMs: 120 });
  assert.equal(extractTypingMeta(okResult({ typed: true })), null);
  assert.equal(extractTypingMeta(failResult('nope')), null);
});
