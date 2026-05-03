// Phase 125 (D1206 Tier 2 Sprint A): testID-keyed device_batch steps.
// Tests the pure findRefByTestID helper — handler integration tests live
// elsewhere because they need a live agent-device session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRefByTestID, snapshotEnvelopeFailed } from '../../dist/tools/device-batch.js';

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

// Phase 128 (post-review #3): fast-runner snapshot tree shape support.
// agent-device-wrapper.ts:483-484 documents that iOS fast-runner snapshots
// return `{ tree: ... }`, not `{ nodes: [...] }`. Without recursive walking,
// every iOS testID lookup after the first daemon snapshot used to return null.

test('Phase128: findRefByTestID walks fast-runner tree shape (top-level match)', () => {
  const treeEnv = JSON.stringify({
    ok: true,
    data: {
      tree: { ref: 'e1', identifier: 'root', children: [] },
    },
  });
  assert.equal(findRefByTestID(treeEnv, 'root'), 'e1');
});

test('Phase128: findRefByTestID walks fast-runner tree shape (deep match)', () => {
  const treeEnv = JSON.stringify({
    ok: true,
    data: {
      tree: {
        ref: 'e1',
        identifier: 'app',
        children: [
          {
            ref: 'e2',
            identifier: 'screen',
            children: [
              { ref: 'e3', identifier: 'header' },
              { ref: 'e4', identifier: 'fab-create-task', children: [{ ref: 'e5', identifier: 'icon' }] },
            ],
          },
        ],
      },
    },
  });
  assert.equal(findRefByTestID(treeEnv, 'fab-create-task'), 'e4');
  assert.equal(findRefByTestID(treeEnv, 'icon'), 'e5');
  assert.equal(findRefByTestID(treeEnv, 'nonexistent'), null);
});

test('Phase128: findRefByTestID prefers nodes shape when both present (defensive)', () => {
  // If a future agent-device returns both, daemon shape wins — it's more reliable.
  const both = JSON.stringify({
    ok: true,
    data: {
      nodes: [{ ref: 'flat-1', identifier: 'foo' }],
      tree: { ref: 'tree-1', identifier: 'foo' },
    },
  });
  assert.equal(findRefByTestID(both, 'foo'), 'flat-1');
});

test('Phase128: findRefByTestID returns null when tree node lacks ref', () => {
  const treeEnv = JSON.stringify({
    ok: true,
    data: {
      tree: { identifier: 'orphan' },
    },
  });
  assert.equal(findRefByTestID(treeEnv, 'orphan'), null);
});

// Phase 128 (post-review #5/#6): snapshotEnvelopeFailed flags infrastructure
// failure so callers can route to SNAPSHOT_FAILED vs TESTID_NOT_FOUND.

test('Phase128: snapshotEnvelopeFailed: ok=true → false', () => {
  assert.equal(snapshotEnvelopeFailed(JSON.stringify({ ok: true, data: { nodes: [] } })), false);
});

test('Phase128: snapshotEnvelopeFailed: ok=false → true', () => {
  assert.equal(snapshotEnvelopeFailed(JSON.stringify({ ok: false, error: 'daemon down' })), true);
});

test('Phase128: snapshotEnvelopeFailed: missing/empty/null → true', () => {
  assert.equal(snapshotEnvelopeFailed(null), true);
  assert.equal(snapshotEnvelopeFailed(undefined), true);
  assert.equal(snapshotEnvelopeFailed(''), true);
});

test('Phase128: snapshotEnvelopeFailed: malformed JSON → true', () => {
  assert.equal(snapshotEnvelopeFailed('not-json{'), true);
});

test('Phase128: snapshotEnvelopeFailed: missing ok field → false (defensive default)', () => {
  // No ok field → not explicitly failed. Caller should still validate
  // shape downstream, but we don't treat absence as failure.
  assert.equal(snapshotEnvelopeFailed(JSON.stringify({ data: {} })), false);
});
