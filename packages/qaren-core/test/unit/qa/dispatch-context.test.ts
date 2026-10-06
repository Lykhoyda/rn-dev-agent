import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';

test('expiry latches before dispatch and cannot be erased by a swallowed error', () => {
  let now = 10;
  const context = new QaDispatchContext(10, () => now);
  assert.throws(() => context.authorize(), { code: 'EVIDENCE_EXPIRED' });
  now = 5;
  assert.throws(() => context.authorize(), { code: 'EVIDENCE_EXPIRED' });
  assert.equal(context.authorizations, 0);
  assert.equal(context.refusal?.code, 'EVIDENCE_EXPIRED');
});

test('expiry after a send retains the authorization count', () => {
  let now = 1;
  const context = new QaDispatchContext(10, () => now);
  context.authorize();
  now = 10;
  assert.throws(() => context.authorize(), { code: 'EVIDENCE_EXPIRED' });
  assert.equal(context.authorizations, 1);
});

test('late completion does not retroactively refuse a fully dispatched command', () => {
  let now = 1;
  const context = new QaDispatchContext(10, () => now);
  context.authorize();
  now = 20;
  context.assertComplete();
  assert.equal(context.refusal, undefined);
});

test('cancellation and invalidation latch content-free refusals', () => {
  let cancelled = false;
  const context = new QaDispatchContext(
    10,
    () => 1,
    () => cancelled,
  );
  cancelled = true;
  assert.throws(() => context.check(), { code: 'RUN_CANCELLED' });
  cancelled = false;
  assert.throws(() => context.assertComplete(), { code: 'RUN_CANCELLED' });
  const changed = new QaDispatchContext(10, () => 1);
  assert.throws(() => changed.invalidate(), { code: 'ACTION_CONTEXT_CHANGED' });
  assert.throws(() => changed.authorize(), { code: 'ACTION_CONTEXT_CHANGED' });
});

test('invalid clocks and deadlines refuse before dispatch', () => {
  for (const deadline of [NaN, Infinity, -1]) {
    const context = new QaDispatchContext(deadline, () => 0);
    assert.throws(() => context.authorize(), { code: 'ACTION_CONTEXT_CHANGED' });
  }
  const context = new QaDispatchContext(10, () => NaN);
  assert.throws(() => context.authorize(), { code: 'ACTION_CONTEXT_CHANGED' });
});

test('a runner-attested no-mutation invalidation of the only send is a refusal before mutation', () => {
  const attested = new QaDispatchContext(10, () => 1);
  attested.authorize();
  assert.throws(() => attested.invalidate(true), { code: 'ACTION_CONTEXT_CHANGED' });
  assert.throws(() => attested.authorize(), { code: 'ACTION_CONTEXT_CHANGED' });
  assert.equal(attested.refusedBeforeMutation, true);

  const unattested = new QaDispatchContext(10, () => 1);
  unattested.authorize();
  assert.throws(() => unattested.invalidate(), { code: 'ACTION_CONTEXT_CHANGED' });
  assert.equal(unattested.refusedBeforeMutation, false);

  const twice = new QaDispatchContext(10, () => 1);
  twice.authorize();
  twice.authorize();
  assert.throws(() => twice.invalidate(true), { code: 'ACTION_CONTEXT_CHANGED' });
  assert.equal(twice.refusedBeforeMutation, false);

  let now = 1;
  const expired = new QaDispatchContext(10, () => now);
  expired.authorize();
  now = 10;
  assert.throws(() => expired.authorize(), { code: 'EVIDENCE_EXPIRED' });
  assert.throws(() => expired.invalidate(true), { code: 'EVIDENCE_EXPIRED' });
  assert.equal(expired.refusedBeforeMutation, false);
});
