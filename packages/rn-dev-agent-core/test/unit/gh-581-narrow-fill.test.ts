import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFillCoordinator, type FillOwnerResult } from '../../dist/tools/fill-coordinator.js';
import { mustStopBatchAfterFillFailure } from '../../dist/tools/device-batch.js';

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

test('batch stops after every failed fill that may have mutated', () => {
  assert.equal(mustStopBatchAfterFillFailure('none'), false);
  assert.equal(mustStopBatchAfterFillFailure('observed'), true);
  assert.equal(mustStopBatchAfterFillFailure('possible'), true);
});
