import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFillCoordinator, type FillOwnerResult } from '../../dist/tools/fill-coordinator.js';
import { createDeviceBatchHandler } from '../../dist/tools/device-batch.js';
import {
  _setActiveSessionForTest,
  _setRunAgentDeviceForTest,
} from '../../dist/agent-device-wrapper.js';
import { okResult } from '../../dist/utils.js';
import { isExactTextInputType } from '../../dist/tools/device-interact.js';

const request = { descriptor: { testID: 'field', nativeType: 'TextField' }, text: 'canary' };

function owner(result: FillOwnerResult) {
  let calls = 0;
  return {
    calls: () => calls,
    run: async () => {
      calls += 1;
      return result;
    },
  };
}

test('focus-time replacement refuses before native mutation and never replays', async () => {
  const controlled = owner({ kind: 'native-eligible' });
  const native = owner({
    kind: 'failure',
    code: 'TEXT_TARGET_LOST',
    mutation: 'none',
    reason: 'target-lost',
  });

  const result = await runFillCoordinator(request, {
    controlledFill: controlled.run,
    nativeFill: native.run,
  });

  assert.deepEqual(result, {
    kind: 'failure',
    code: 'TEXT_TARGET_LOST',
    mutation: 'none',
    reason: 'target-lost',
    owner: 'native',
  });
  assert.equal(controlled.calls(), 1);
  assert.equal(native.calls(), 1);
});

test('controlled empty clear is exact without consulting the native oracle', async () => {
  const controlled = owner({ kind: 'success', focusedBefore: false });
  const native = owner({ kind: 'success', focusedBefore: false });

  const result = await runFillCoordinator(
    { ...request, text: '' },
    {
      controlledFill: controlled.run,
      nativeFill: native.run,
    },
  );

  assert.deepEqual(result, { kind: 'success', owner: 'fiber', focusedBefore: false });
  assert.equal(native.calls(), 0);
});

test('wrapper fill uses its unique controlled owner and leaves wrong focus behind', async () => {
  const controlled = owner({ kind: 'success', focusedBefore: false });
  const native = owner({ kind: 'success', focusedBefore: false });

  const result = await runFillCoordinator(
    { descriptor: { testID: 'field-pressable', nativeType: 'Other' }, text: 'canary' },
    { controlledFill: controlled.run, nativeFill: native.run },
  );

  assert.deepEqual(result, { kind: 'success', owner: 'fiber', focusedBefore: false });
  assert.equal(controlled.calls(), 1);
  assert.equal(native.calls(), 0);
});

test('already-focused controlled target reports focus proof and is not sent native', async () => {
  const controlled = owner({ kind: 'success', focusedBefore: true });
  const native = owner({ kind: 'success', focusedBefore: false });

  const result = await runFillCoordinator(request, {
    controlledFill: controlled.run,
    nativeFill: native.run,
  });

  assert.deepEqual(result, { kind: 'success', owner: 'fiber', focusedBefore: true });
  assert.equal(native.calls(), 0);
});

test('controlled transform hard-fails after one dispatch with no corrective native mutation', async () => {
  const controlled = owner({
    kind: 'failure',
    code: 'TEXT_ENTRY_UNVERIFIED',
    mutation: 'observed',
    reason: 'mismatch',
  });
  const native = owner({ kind: 'success', focusedBefore: false });

  const result = await runFillCoordinator(request, {
    controlledFill: controlled.run,
    nativeFill: native.run,
  });

  assert.equal(result.kind, 'failure');
  assert.equal(result.mutation, 'observed');
  assert.equal(controlled.calls(), 1);
  assert.equal(native.calls(), 0);
});

test('ambiguous, stale, secure, unreadable, and occluded controlled targets fail closed', async () => {
  for (const [reason, mutation] of [
    ['ambiguous', 'none'],
    ['target-lost', 'none'],
    ['secure', 'none'],
    ['unreadable', 'possible'],
    ['occluded', 'none'],
  ] as const) {
    const controlled = owner({
      kind: 'failure',
      code: 'TEXT_ENTRY_UNVERIFIED',
      mutation,
      reason,
    });
    const native = owner({ kind: 'success', focusedBefore: false });
    const result = await runFillCoordinator(request, {
      controlledFill: controlled.run,
      nativeFill: native.run,
    });
    assert.equal(result.kind, 'failure', reason);
    assert.equal(result.mutation, mutation, reason);
    assert.equal(native.calls(), 0, reason);
  }
});

test('controlled dispatch timeout is possible mutation and is never replayed', async () => {
  let controlledCalls = 0;
  let nativeCalls = 0;
  const result = await runFillCoordinator(request, {
    controlledFill: async () => {
      controlledCalls += 1;
      throw new Error('timeout');
    },
    nativeFill: async () => {
      nativeCalls += 1;
      return { kind: 'success', focusedBefore: false };
    },
  });

  assert.deepEqual(result, {
    kind: 'failure',
    code: 'TEXT_ENTRY_UNVERIFIED',
    mutation: 'possible',
    reason: 'dispatch-uncertain',
    owner: 'fiber',
  });
  assert.equal(controlledCalls, 1);
  assert.equal(nativeCalls, 0);
});

test('qualified Android editable types remain exact-fill candidates', () => {
  assert.equal(isExactTextInputType('android.widget.EditText'), true);
  assert.equal(isExactTextInputType('androidx.appcompat.widget.AppCompatEditText'), true);
  assert.equal(isExactTextInputType('android.widget.Button'), false);
});

test('batch executes the coordinator and stops before its sentinel after possible mutation', async () => {
  _setActiveSessionForTest({ platform: 'android', deviceId: 'emulator-test', appId: 'dev.test' });
  const nativeCalls: string[][] = [];
  _setRunAgentDeviceForTest(async (args) => {
    nativeCalls.push(args);
    if (args[0] === 'snapshot') {
      return okResult({
        nodes: [
          {
            ref: 'e1',
            type: 'android.widget.EditText',
            identifier: 'field',
            enabled: true,
            hittable: true,
          },
        ],
      });
    }
    return okResult({ pressed: true });
  });
  const client = {
    isConnected: true,
    helpersInjected: true,
    evaluate: async () => ({
      value: {
        kind: 'failure',
        code: 'TEXT_ENTRY_UNVERIFIED',
        mutation: 'possible',
        reason: 'dispatch-uncertain',
      },
    }),
  };

  try {
    const result = await createDeviceBatchHandler(() => client as never)({
      steps: [
        { action: 'fill', testID: 'field', text: 'canary', optional: true },
        { action: 'press', x: 10, y: 20 },
      ],
      continueOnError: true,
      screenshotOn: 'none',
      finalSnapshot: 'none',
      delayMs: 0,
    });
    const envelope = JSON.parse(result.content[0]!.text) as {
      meta?: {
        failed_step?: { action?: string; meta?: { mutation?: string } };
        results?: unknown[];
      };
    };
    assert.equal(result.isError, true);
    assert.equal(envelope.meta?.failed_step?.action, 'fill');
    assert.equal(envelope.meta?.failed_step?.meta?.mutation, 'possible');
    assert.equal(envelope.meta?.results?.length, 1);
    assert.equal(
      nativeCalls.some((args) => args[0] === 'press'),
      false,
    );
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});
