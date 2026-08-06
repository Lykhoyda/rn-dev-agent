// GH #581: strict fill-truth model — classification, oracle arbitration,
// retype gating, JS-tier dispatch safety, and the final fiber verifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFiberVerification,
  combineVerificationOracles,
  decideNativeRetype,
  resolveJsTestId,
  probeInputState,
  finalFiberVerify,
  attemptJsFill,
  settleRead,
  type EvaluateSeam,
  type FinalVerification,
} from '../../dist/tools/fill-verify.js';

function seam(reads: Array<{ value?: string | null; controlled?: boolean } | null>): EvaluateSeam {
  let i = 0;
  return {
    evaluate: async (expr: string) => {
      if (expr.includes('readInputValue')) {
        const read = reads[Math.min(i, reads.length - 1)];
        i += 1;
        if (read === null) return { error: 'unreadable' };
        return {
          value: JSON.stringify({ value: read.value ?? null, controlled: read.controlled ?? true }),
        };
      }
      return { value: JSON.stringify({}) };
    },
    sleep: async () => {},
  };
}

test('classifyFiberVerification is exact-or-nothing', () => {
  assert.equal(classifyFiberVerification({ text: 'hello', valueAfter: 'hello' }), 'exact');
  assert.equal(classifyFiberVerification({ text: 'hello', valueAfter: 'HELLO' }), 'mismatch');
  // The pre-#581 half-length "verified-transformed" soft-accept is gone: a
  // same-length or half-length different value is a mismatch.
  assert.equal(classifyFiberVerification({ text: 'abcdefgh', valueAfter: 'WXYZ' }), 'mismatch');
  assert.equal(classifyFiberVerification({ text: 'password', valueAfter: 'XXXXXXXX' }), 'mismatch');
  assert.equal(classifyFiberVerification({ text: 'hello', valueAfter: null }), 'unreadable');
  assert.equal(classifyFiberVerification({ text: '', valueAfter: '' }), 'exact');
  assert.equal(classifyFiberVerification({ text: '', valueAfter: 'left' }), 'mismatch');
});

test('arbiter: fiber exact + native exact verifies with both oracles', () => {
  const v = combineVerificationOracles('exact', 'exact', true);
  assert.equal(v.verified, true);
  assert.equal(v.oracle, 'fiber+native');
});

test('arbiter: controlled fiber exact verifies when native cannot read', () => {
  for (const native of ['unreadable', 'secure-masked', 'unavailable'] as const) {
    const v = combineVerificationOracles('exact', native, false);
    assert.equal(v.verified, true, `native=${native}`);
    assert.equal(v.oracle, 'fiber');
  }
});

test('arbiter: native stable exact verifies uncontrolled inputs', () => {
  const v = combineVerificationOracles('unavailable', 'exact', true);
  assert.equal(v.verified, true);
  assert.equal(v.oracle, 'native');
});

test('arbiter: unstable native exact never verifies alone', () => {
  const v = combineVerificationOracles('unavailable', 'exact', false);
  assert.equal(v.verified, false);
});

test('arbiter: stable fiber exact verifies despite a still-settling native exact', () => {
  const v = combineVerificationOracles('exact', 'exact', false);
  assert.equal(v.verified, true);
  assert.equal(v.oracle, 'fiber');
});

test('arbiter: an unstable native exact still vetoes corrective retyping', () => {
  const v = combineVerificationOracles('mismatch', 'exact', false);
  assert.equal(v.verified, false);
  assert.equal(v.observedMismatch, false);
});

test('arbiter: oracle disagreement fails and is not retryable', () => {
  const fiberSaysExact = combineVerificationOracles('exact', 'mismatch', true);
  assert.equal(fiberSaysExact.verified, false);
  assert.equal(fiberSaysExact.observedMismatch, false);
  const nativeSaysExact = combineVerificationOracles('mismatch', 'exact', true);
  assert.equal(nativeSaysExact.verified, false);
  assert.equal(nativeSaysExact.observedMismatch, false);
});

test('arbiter: native ambiguous/target-lost poisons both oracles', () => {
  for (const native of ['ambiguous', 'target-lost'] as const) {
    const v = combineVerificationOracles('exact', native, true);
    assert.equal(v.verified, false, `native=${native}`);
    assert.equal(v.observedMismatch, false, `native=${native}`);
  }
});

test('arbiter: unanimous stable mismatch is the only retype license', () => {
  const observed = combineVerificationOracles('mismatch', 'mismatch', true);
  assert.equal(observed.observedMismatch, true);
  const inconclusive = combineVerificationOracles('unreadable', 'unreadable', false);
  assert.equal(inconclusive.observedMismatch, false);
  const secure = combineVerificationOracles('unavailable', 'secure-masked', true);
  assert.equal(secure.verified, false);
  assert.equal(secure.observedMismatch, false);
});

function verification(overrides: Partial<FinalVerification>): FinalVerification {
  return {
    verified: false,
    oracle: 'none',
    fiber: 'unavailable',
    native: 'mismatch',
    nativeStable: true,
    observedMismatch: true,
    ...overrides,
  };
}

test('decideNativeRetype only descends on observed mismatch with attempts left', () => {
  assert.deepEqual(decideNativeRetype(verification({}), 0, 2), {
    action: 'retype',
    delayMs: 40,
  });
  assert.deepEqual(decideNativeRetype(verification({}), 2, 2), { action: 'escalate' });
  assert.deepEqual(decideNativeRetype(verification({ observedMismatch: false }), 0, 2), {
    action: 'escalate',
  });
});

test('resolveJsTestId precedence', () => {
  assert.equal(resolveJsTestId('@e5', { explicitTestId: 'email' }), 'email');
  assert.equal(resolveJsTestId('@e5', { cachedIdentifier: 'email' }), 'email');
  assert.equal(resolveJsTestId('@e5', {}), null);
  assert.equal(resolveJsTestId('my-input', {}), 'my-input');
  assert.equal(resolveJsTestId('@42', {}), null);
});

test('probeInputState never mutates and reports controlled-ness', async () => {
  const evaluated: string[] = [];
  const deps: EvaluateSeam = {
    evaluate: async (expr: string) => {
      evaluated.push(expr);
      return { value: JSON.stringify({ value: 'x', controlled: true }) };
    },
    sleep: async () => {},
  };
  const probe = await probeInputState(deps, 'email');
  assert.equal(probe.readable, true);
  assert.equal(probe.controlled, true);
  assert.ok(evaluated.length > 0);
  assert.ok(
    evaluated.every((e) => e.startsWith('__RN_AGENT.readInputValue(')),
    'probe may only issue read-only readInputValue evaluations',
  );
});

test('finalFiberVerify resets stability evidence across failed reads', async () => {
  const deps = seam([{ value: 'wrong' }, null, { value: 'wrong' }, null, { value: 'wrong' }, null]);
  assert.equal(await finalFiberVerify(deps, 'email', 'hello'), 'unreadable');
});

test('finalFiberVerify polls through a debounced update to a stable exact', async () => {
  const deps = seam([{ value: 'old' }, { value: 'old' }, { value: 'hello' }, { value: 'hello' }]);
  assert.equal(await finalFiberVerify(deps, 'email', 'hello'), 'exact');
});

test('finalFiberVerify fails an exact that reverts during confirmation', async () => {
  const deps = seam([{ value: 'hello' }, { value: 'old' }]);
  assert.equal(await finalFiberVerify(deps, 'email', 'hello'), 'unreadable');
});

test('finalFiberVerify reports mismatch only for a stable final wrong value', async () => {
  const stable = seam([
    { value: 'wrong' },
    { value: 'wrong' },
    { value: 'wrong' },
    { value: 'wrong' },
    { value: 'wrong' },
    { value: 'wrong' },
  ]);
  assert.equal(await finalFiberVerify(stable, 'hello', 'hello2'), 'mismatch');
  const unstable = seam([
    { value: 'a' },
    { value: 'b' },
    { value: 'c' },
    { value: 'd' },
    { value: 'e' },
    { value: 'f' },
  ]);
  assert.equal(await finalFiberVerify(unstable, 'hello', 'zzz'), 'unreadable');
});

test('finalFiberVerify treats uncontrolled reads as inconclusive', async () => {
  const deps = seam([
    { value: 'wrong', controlled: false },
    { value: 'wrong', controlled: false },
    { value: 'wrong', controlled: false },
    { value: 'wrong', controlled: false },
    { value: 'wrong', controlled: false },
    { value: 'wrong', controlled: false },
  ]);
  assert.equal(await finalFiberVerify(deps, 'email', 'hello'), 'unreadable');
});

test('attemptJsFill marks transport failures as dispatch-uncertain', async () => {
  const throwing: EvaluateSeam = {
    evaluate: async () => {
      throw new Error('socket closed');
    },
    sleep: async () => {},
  };
  const result = await attemptJsFill(throwing, 'email', 'hello');
  assert.equal(result.handled, false);
  assert.equal(result.dispatchUncertain, true);
});

test('attemptJsFill treats unknown helper response shapes as dispatch-uncertain', async () => {
  const legacy: EvaluateSeam = {
    evaluate: async () => ({ value: JSON.stringify({ typed: true }) }),
    sleep: async () => {},
  };
  const result = await attemptJsFill(legacy, 'email', 'hello');
  assert.equal(result.handled, false);
  assert.equal(result.dispatchUncertain, true);
});

test('attemptJsFill helper-reported errors are clean pre-mutation no-ops', async () => {
  const refused: EvaluateSeam = {
    evaluate: async () => ({ value: JSON.stringify({ error: 'not found' }) }),
    sleep: async () => {},
  };
  const result = await attemptJsFill(refused, 'email', 'hello');
  assert.equal(result.handled, false);
  assert.equal(result.dispatchUncertain, undefined);
});

test('attemptJsFill exact outcome flows from a settled read', async () => {
  let calls = 0;
  const deps: EvaluateSeam = {
    evaluate: async (expr: string) => {
      if (expr.includes('typeText')) {
        return {
          value: JSON.stringify({
            controlled: true,
            handlerCalled: 'onChangeText',
            valueBefore: '',
          }),
        };
      }
      calls += 1;
      return { value: JSON.stringify({ value: 'hello', controlled: true }) };
    },
    sleep: async () => {},
  };
  const result = await attemptJsFill(deps, 'email', 'hello');
  assert.equal(result.handled, true);
  assert.equal(result.outcome, 'exact');
  assert.ok(calls >= 1);
});

test('attemptJsFill requires a stable wrong value before reporting mismatch', async () => {
  const transient: EvaluateSeam = {
    evaluate: (() => {
      let i = 0;
      return async (expr: string) => {
        if (expr.includes('typeText')) {
          return {
            value: JSON.stringify({ controlled: true, handlerCalled: 'fn', valueBefore: 'old' }),
          };
        }
        i += 1;
        return {
          value: JSON.stringify({ value: i === 1 ? 'transient' : 'hello', controlled: true }),
        };
      };
    })(),
    sleep: async () => {},
  };
  const result = await attemptJsFill(transient, 'email', 'hello');
  assert.equal(result.outcome, 'exact');
});

test('settleRead surfaces the flushed value after a debounce', async () => {
  const deps = seam([{ value: 'old' }, { value: 'old' }, { value: 'new' }]);
  const settled = await settleRead(deps, 'email', 'new', 'old');
  assert.equal(settled.value, 'new');
});
