// Phase 125 (D1206 Tier 2 Sprint A): testID-keyed device_batch steps.
// Tests the pure findRefByTestID helper — handler integration tests live
// elsewhere because they need a live agent-device session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRefByTestID } from '../../dist/tools/device-batch.js';

const SAMPLE_OK = JSON.stringify({
  ok: true,
  data: {
    nodes: [
      { ref: 'e1', identifier: undefined, type: 'Application' },
      { ref: 'e7', identifier: 'task-screen', type: 'Other' },
      { ref: 'e29', identifier: 'wizard-title-input', type: 'TextField' },
      { ref: 'e60', identifier: 'wizard-next-btn', type: 'Other', label: 'Next' },
      { ref: 'e151', identifier: 'fab-create-task', type: 'Button' },
    ],
  },
});

test('Phase125: findRefByTestID returns matching node ref', () => {
  assert.equal(findRefByTestID(SAMPLE_OK, 'wizard-title-input'), 'e29');
  assert.equal(findRefByTestID(SAMPLE_OK, 'fab-create-task'), 'e151');
  assert.equal(findRefByTestID(SAMPLE_OK, 'wizard-next-btn'), 'e60');
});

test('Phase125: findRefByTestID returns null when testID is absent', () => {
  assert.equal(findRefByTestID(SAMPLE_OK, 'nonexistent-id'), null);
});

test('Phase125: findRefByTestID returns null when envelope ok=false', () => {
  const err = JSON.stringify({ ok: false, error: 'no session' });
  assert.equal(findRefByTestID(err, 'fab-create-task'), null);
});

test('Phase125: findRefByTestID returns null on malformed JSON', () => {
  assert.equal(findRefByTestID('not-json', 'foo'), null);
});

test('Phase125: findRefByTestID returns null when data.nodes missing', () => {
  const noNodes = JSON.stringify({ ok: true, data: {} });
  assert.equal(findRefByTestID(noNodes, 'foo'), null);
});

test('Phase125: findRefByTestID returns null when nodes has no identifier match (skips undefined identifiers)', () => {
  const noIds = JSON.stringify({
    ok: true,
    data: { nodes: [{ ref: 'e1' }, { ref: 'e2' }] },
  });
  assert.equal(findRefByTestID(noIds, 'foo'), null);
});

test('Phase125: findRefByTestID is exact-match (no substring)', () => {
  // wizard-title-input must NOT match wizard
  assert.equal(findRefByTestID(SAMPLE_OK, 'wizard'), null);
  assert.equal(findRefByTestID(SAMPLE_OK, 'title'), null);
});

test('Phase125: findRefByTestID returns first match if duplicates (defensive)', () => {
  const dup = JSON.stringify({
    ok: true,
    data: {
      nodes: [
        { ref: 'eA', identifier: 'duplicate' },
        { ref: 'eB', identifier: 'duplicate' },
      ],
    },
  });
  assert.equal(findRefByTestID(dup, 'duplicate'), 'eA');
});

test('Phase125: findRefByTestID gracefully handles node missing ref', () => {
  const noRef = JSON.stringify({
    ok: true,
    data: { nodes: [{ identifier: 'orphan-id' }] },
  });
  // No ref on the matching node → returns null (matched but no usable ref).
  assert.equal(findRefByTestID(noRef, 'orphan-id'), null);
});
