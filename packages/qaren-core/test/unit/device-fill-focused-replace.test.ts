// Focused (keyboard fallback) fill replaces: a proven-focused field is cleared and read back empty before typing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { _setActiveSessionForTest, _setRunAgentDeviceForTest, markSnapshotDirty } =
  await import('../../dist/agent-device-wrapper.js');
const { performFocusedFill } = await import('../../dist/handlers/device-interact.js');
const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
const { okResult } = await import('../../dist/utils.js');

const WRAPPER_ONLY = [
  {
    ref: '@e1',
    identifier: 'qa-hidden-email-pressable',
    type: 'Other',
    rect: { x: 20, y: 100, width: 360, height: 60 },
  },
];

type Read = { value: string | null; focused: boolean } | null;

async function run(reads: Read[]): Promise<{ env: any; typed: string[] }> {
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-DEVICE', appId: 'com.test' });
  clearRefMap();
  markSnapshotDirty();
  updateRefMapFromFlat(WRAPPER_ONLY as never, { snapshotGeneration: 7, keyboardVisible: true });
  const typed: string[] = [];
  let index = 0;
  _setRunAgentDeviceForTest(async (cliArgs: string[]) => {
    if (cliArgs[0] !== 'fill') return okResult({ nodes: WRAPPER_ONLY });
    typed.push(cliArgs[2]);
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
        skipFinalValidation: true,
        clearFirst: true,
      },
      client,
    );
    return { env: JSON.parse(result.content[0].text), typed };
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
    clearRefMap();
  }
}

test('a fallback refill clears the decoy and types exactly the second value', async () => {
  const decoy = 'decoy@example.test';
  const { env, typed } = await run([
    { value: decoy, focused: true },
    { value: '', focused: true },
  ]);
  assert.equal(env.ok, true);
  assert.deepEqual(typed, ['\b'.repeat(decoy.length), 'real@example.test']);
});

test('a fallback fill into an empty field types once with no clearing keystrokes', async () => {
  const { env, typed } = await run([{ value: '', focused: true }]);
  assert.equal(env.ok, true);
  assert.deepEqual(typed, ['real@example.test']);
});

test('a field still non-empty after the clear refuses before typing', async () => {
  const { env, typed } = await run([
    { value: 'decoy', focused: true },
    { value: 'de', focused: true },
  ]);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.deepEqual(typed, ['\b'.repeat(5)]);
  assert.ok(!JSON.stringify(env).includes('real@example.test'));
  assert.ok(!JSON.stringify(env).includes('decoy'));
});

test('a field that loses focus after clearing refuses before replacement typing', async () => {
  const { env, typed } = await run([
    { value: 'decoy', focused: true },
    { value: '', focused: false },
  ]);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'observed');
  assert.deepEqual(typed, ['\b'.repeat(5)]);
});

test('focus lost after empty-value confirmation refuses before replacement typing', async () => {
  const { env, typed } = await run([
    { value: 'decoy', focused: true },
    { value: '', focused: true },
    { value: '', focused: true },
    { value: '', focused: false },
  ]);
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(env.meta.mutation, 'observed');
  assert.deepEqual(typed, ['\b'.repeat(5)]);
});

for (const [name, read] of [
  ['unreadable', null],
  ['uncontrolled', { value: null, focused: true }],
] as const) {
  test(`an ${name} field cannot be cleared, so nothing is typed`, async () => {
    const { env, typed } = await run([read]);
    assert.equal(env.code, 'NO_TEXT_INPUT_TARGET');
    assert.equal(env.meta.mutation, 'none');
    assert.deepEqual(typed, []);
  });
}
