// device_fill focused: true — type into the first responder when the inner
// TextInput is absent from the snapshot, verify through the React tree when
// a testID is derivable, and keep the default bind path's refusal code.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _setActiveSessionForTest, _setRunAgentDeviceForTest, markSnapshotDirty } =
  await import('../../dist/agent-device-wrapper.js');
const { createDeviceFillHandler, performExactFill, performFocusedFill } =
  await import('../../dist/tools/device-interact.js');
const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
const { okResult, failResult } = await import('../../dist/utils.js');

const WRAPPER_ONLY = [
  {
    ref: '@e1',
    identifier: 'EmailOtpFormContent_email-pressable',
    type: 'Other',
    rect: { x: 20, y: 100, width: 360, height: 60 },
  },
];

interface Call {
  cliArgs: string[];
  opts: Record<string, unknown>;
}

async function withFocusedSeam<T>(
  config: {
    platform?: 'ios' | 'android';
    fill?: (call: Call) => ReturnType<typeof okResult>;
  },
  run: () => Promise<T>,
): Promise<{ result: T; calls: Call[] }> {
  _setActiveSessionForTest({
    platform: config.platform ?? 'ios',
    deviceId: 'TEST-DEVICE',
    appId: 'com.test',
  });
  clearRefMap();
  markSnapshotDirty();
  updateRefMapFromFlat(WRAPPER_ONLY as never, { snapshotGeneration: 7, keyboardVisible: true });
  const calls: Call[] = [];
  _setRunAgentDeviceForTest(async (cliArgs: string[], opts: Record<string, unknown>) => {
    const call = { cliArgs, opts };
    calls.push(call);
    if (cliArgs[0] === 'snapshot') {
      return okResult({ nodes: WRAPPER_ONLY });
    }
    if (cliArgs[0] === 'fill') {
      return config.fill
        ? config.fill(call)
        : okResult({
            typed: true,
            textEntryRoute: 'synthesized-first-responder',
            inputResolution: 'focused-first-responder',
          });
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

function fakeClient(values: Array<{ value?: string | null; controlled?: boolean } | null>) {
  let reads = 0;
  return {
    isConnected: true,
    evaluate: async (expr: string) => {
      if (!expr.includes('readInputValue')) return { value: JSON.stringify({}) };
      const read = values[Math.min(reads, values.length - 1)];
      reads += 1;
      if (!read) return { error: 'unreadable' };
      return {
        value: JSON.stringify({ value: read.value ?? null, controlled: read.controlled ?? true }),
      };
    },
  } as never;
}

test('focused fill: wrapper ref derives the base testID and matching read-back verifies', async () => {
  const client = fakeClient([
    { value: '', controlled: true },
    { value: 'qa.user@example.com', controlled: true },
  ]);
  const { result, calls } = await withFocusedSeam({}, () =>
    performFocusedFill(
      { ref: 'EmailOtpFormContent_email-pressable', text: 'qa.user@example.com' },
      client,
    ),
  );
  assert.ok(!(result as { isError?: boolean }).isError, envelope(result as never).error);
  const env = envelope(result as never);
  assert.deepEqual(env.data, { filled: true, method: 'native', length: 19 });
  assert.equal(env.meta.verify, 'exact');
  assert.equal(env.meta.textEntryPath, 'focused-synthesized');
  assert.equal(env.meta.verifiedOracle, 'react-tree');
  assert.equal(env.meta.textEntryRoute, 'synthesized-first-responder');
  const fill = calls.find((c) => c.cliArgs[0] === 'fill')!;
  assert.equal(fill.cliArgs[1], 'EmailOtpFormContent_email-pressable');
  assert.equal(fill.opts.focusedType, true);
  assert.equal(fill.opts.exactTarget, undefined);
});

test('focused fill: React mismatch returns TEXT_ENTRY_UNVERIFIED with observed mutation', async () => {
  const client = fakeClient([
    { value: '', controlled: true },
    { value: 'other@example.com', controlled: true },
  ]);
  const { result, calls } = await withFocusedSeam({}, () =>
    performFocusedFill(
      { ref: 'EmailOtpFormContent_email-pressable', text: 'qa.user@example.com' },
      client,
    ),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'observed');
  assert.deepEqual(env.meta.pathsTried, ['focused']);
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1);
});

test('focused fill: positional ref or no client is warned, never verified', async () => {
  const { result: positional } = await withFocusedSeam({}, () =>
    performFocusedFill({ ref: '@e1', text: 'qa.user@example.com' }, null),
  );
  const positionalEnv = envelope(positional as never);
  assert.equal(positionalEnv.ok, true);
  assert.equal(positionalEnv.data.verified, false);
  assert.equal(positionalEnv.data.verifiedOracle, 'none');
  assert.equal(positionalEnv.meta.warning.includes('no read-back oracle'), true);
  assert.ok(!JSON.stringify(positionalEnv).includes('"verified":true'));

  const { result: noClient } = await withFocusedSeam({}, () =>
    performFocusedFill(
      { ref: 'EmailOtpFormContent_email-pressable', text: 'qa.user@example.com' },
      null,
    ),
  );
  const noClientEnv = envelope(noClient as never);
  assert.equal(noClientEnv.data.verified, false);
  assert.equal(noClientEnv.meta.verify, undefined);
});

test('focused fill: runner TEXT_TARGET_FOCUS_FAILED surfaces as NO_TEXT_INPUT_TARGET with no mutation', async () => {
  const { result, calls } = await withFocusedSeam(
    {
      fill: () =>
        failResult(
          'TEXT_TARGET_FOCUS_FAILED: no software keyboard is visible, so no field is proven focused; tap the field, then retry. No typing was performed.',
          'TEXT_TARGET_FOCUS_FAILED',
          { mutation: 'none' },
        ),
    },
    () => performFocusedFill({ ref: 'EmailOtpFormContent_email-pressable', text: 'a' }, null),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.match(env.error, /TEXT_TARGET_FOCUS_FAILED/);
  assert.equal(calls.filter((c) => c.cliArgs[0] === 'fill').length, 1);
});

test('focused fill: Android refuses with no mutation', async () => {
  const { result, calls } = await withFocusedSeam({ platform: 'android' }, () =>
    createDeviceFillHandler(() => null as never)({
      ref: 'EmailOtpFormContent_email-pressable',
      text: 'qa.user@example.com',
      focused: true,
    }),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.match(env.error, /iOS-only/);
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'));
});

test('default fill: wrapper-bind refusal names focused: true and keeps NO_TEXT_INPUT_TARGET', async () => {
  const { result, calls } = await withFocusedSeam({}, () =>
    performExactFill(
      { ref: 'EmailOtpFormContent_email-pressable', text: 'qa.user@example.com' },
      null,
      {},
    ),
  );
  const env = envelope(result as never);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.match(env.error, /retry with focused: true\.$/);
  assert.ok(!calls.some((c) => c.cliArgs[0] === 'fill'));
});
