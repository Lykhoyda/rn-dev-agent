// Focused (keyboard fallback) fill replaces in the runner and proves focus immediately before dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _setActiveSessionForTest, _setRunAgentDeviceForTest, markSnapshotDirty } =
  await import('../../dist/agent-device-wrapper.js');
const { performFocusedFill } = await import('../../dist/handlers/device-interact.js');
const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
const { okResult, failResult } = await import('../../dist/utils.js');

const WRAPPER_ONLY = [
  {
    ref: '@e1',
    identifier: 'qa-hidden-email-pressable',
    type: 'Other',
    rect: { x: 20, y: 100, width: 360, height: 60 },
  },
];

type Read = { value: string | null; focused: boolean } | null;

async function run(
  reads: Read[],
  options: { mutation?: 'none' | 'possible'; requireFocused?: boolean } = {},
): Promise<{ env: any; dispatched: string[][] }> {
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-DEVICE', appId: 'com.test' });
  clearRefMap();
  markSnapshotDirty();
  updateRefMapFromFlat(WRAPPER_ONLY as never, { snapshotGeneration: 7, keyboardVisible: true });
  const dispatched: string[][] = [];
  let index = 0;
  _setRunAgentDeviceForTest(async (cliArgs: string[]) => {
    if (cliArgs[0] !== 'fill') return okResult({ nodes: WRAPPER_ONLY });
    dispatched.push(cliArgs.slice(2));
    if (options.mutation)
      return failResult('Replacement refused', 'TEXT_SYNTHESIS_UNAVAILABLE', {
        mutation: options.mutation,
      });
    return okResult({ typed: true, textEntryRoute: 'synthesized-first-responder' });
  });
  const client = {
    isConnected: true,
    evaluate: async () => {
      const read = reads[Math.min(index++, reads.length - 1)];
      return read
        ? {
            value: JSON.stringify({
              value: read.value,
              controlled: read.value !== null,
              focused: read.focused,
            }),
          }
        : { error: 'unreadable' };
    },
  } as never;
  try {
    const result = await performFocusedFill(
      {
        ref: '@e1',
        text: 'real@example.test',
        testID: 'qa-hidden-email',
        focused: true,
        vetoUnfocused: true,
        ...(options.requireFocused ? { requireFocused: true } : {}),
        skipFinalValidation: true,
        clearFirst: true,
      },
      client,
    );
    return { env: JSON.parse(result.content[0].text), dispatched };
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
    clearRefMap();
  }
}

const REPLACE = ['real@example.test', '--clear-first'];

test('a fallback refill replaces the decoy in one runner dispatch, never appends', async () => {
  const { env, dispatched } = await run([{ value: 'decoy@example.test', focused: true }]);
  assert.equal(env.ok, true);
  assert.deepEqual(dispatched, [REPLACE]);
});

test('an unreadable field on the keyboard-down transition path still replaces', async () => {
  for (const read of [null, { value: null, focused: true }] as const) {
    const { env, dispatched } = await run([read]);
    assert.equal(env.ok, true);
    assert.deepEqual(dispatched, [REPLACE]);
  }
});

for (const [name, read] of [
  ['unreadable', null],
  ['unfocused', { value: '', focused: false }],
] as const) {
  test(`keyboard-up focus that is ${name} at dispatch types nothing`, async () => {
    const { env, dispatched } = await run([read], { requireFocused: true });
    assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
    assert.equal(env.meta.mutation, 'none');
    assert.deepEqual(dispatched, []);
  });
}

test('I2: a contradictory read at dispatch time vetoes typing on the transition path', async () => {
  const { env, dispatched } = await run([{ value: 'decoy', focused: false }]);
  assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
  assert.equal(env.meta.mutation, 'none');
  assert.deepEqual(dispatched, []);
});

for (const mutation of ['none', 'possible'] as const) {
  test(`a refused replacement with mutation ${mutation} keeps its disposition`, async () => {
    const { env, dispatched } = await run([{ value: 'decoy', focused: true }], { mutation });
    assert.equal(env.code, mutation === 'none' ? 'NO_TEXT_INPUT_TARGET' : 'TEXT_ENTRY_UNVERIFIED');
    assert.equal(env.meta.mutation, mutation);
    assert.match(
      env.meta.hint,
      mutation === 'none' ? /No text was entered/ : /do not blindly re-run device_fill/,
    );
    assert.deepEqual(dispatched, [REPLACE]);
    assert.ok(!JSON.stringify(env).includes('decoy'));
  });
}
