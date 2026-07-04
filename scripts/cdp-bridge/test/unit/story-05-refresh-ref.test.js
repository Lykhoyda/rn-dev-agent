import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshRef } from '../../dist/fast-runner-ref-map.js';

const rect = (x, y) => ({ x, y, width: 100, height: 40 });
const btn = (ref, label, identifier, y) => ({
  ref,
  type: 'Button',
  ...(label !== undefined ? { label } : {}),
  ...(identifier !== undefined ? { identifier } : {}),
  rect: rect(0, y),
});
const sig = (over = {}) => ({
  type: 'Button',
  label: 'Save',
  identifier: 'save-btn',
  flatIndex: 1,
  nodeCount: 3,
  ...over,
});

test('unique: exactly one attrs-minus-bounds match, even at a new position', () => {
  const nodes = [
    btn('@e0', 'Other', 'x', 0),
    btn('@e1', 'Cancel', undefined, 50),
    btn('@e2', 'Save', 'save-btn', 400),
  ];
  const out = refreshRef(sig(), nodes);
  assert.equal(out.kind, 'unique');
  assert.equal(out.node.ref, '@e2');
});

test('absent: zero matches (element truly gone)', () => {
  const nodes = [btn('@e0', 'Other', 'x', 0)];
  assert.deepEqual(refreshRef(sig(), nodes), { kind: 'absent' });
});

test('label changed but testID same → absent (exact attrs, never fuzzy)', () => {
  const nodes = [btn('@e0', 'Saving…', 'save-btn', 0)];
  assert.equal(refreshRef(sig(), nodes).kind, 'absent');
});

test('testID changed but label same → absent', () => {
  const nodes = [btn('@e0', 'Save', 'save-btn-v2', 0)];
  assert.equal(refreshRef(sig(), nodes).kind, 'absent');
});

test('ambiguous: two identical siblings, tree shape changed → candidates, no guess', () => {
  const nodes = [btn('@e0', 'Save', 'save-btn', 0), btn('@e1', 'Save', 'save-btn', 50)];
  const out = refreshRef(sig({ nodeCount: 3 }), nodes); // 2 !== 3 → shape changed
  assert.equal(out.kind, 'ambiguous');
  assert.equal(out.candidates.length, 2);
});

test('index tie-break: identical siblings, tree shape UNCHANGED → unique at cached flatIndex', () => {
  const nodes = [
    btn('@e0', 'Save', 'save-btn', 0),
    btn('@e1', 'Save', 'save-btn', 50),
    btn('@e2', 'Other', 'x', 100),
  ];
  const out = refreshRef(sig({ flatIndex: 1, nodeCount: 3 }), nodes);
  assert.equal(out.kind, 'unique');
  assert.equal(out.node.ref, '@e1');
});

test('index-shift trap: shape unchanged but no candidate at cached index → ambiguous', () => {
  const nodes = [
    btn('@e0', 'Other', 'x', 0),
    btn('@e1', 'Save', 'save-btn', 50),
    btn('@e2', 'Save', 'save-btn', 100),
  ];
  const out = refreshRef(sig({ flatIndex: 0, nodeCount: 3 }), nodes);
  assert.equal(out.kind, 'ambiguous');
});

test('optional attrs: undefined label matches only undefined label', () => {
  const nodes = [btn('@e0', undefined, 'save-btn', 0), btn('@e1', 'Save', 'save-btn', 50)];
  const out = refreshRef(sig({ label: undefined }), nodes);
  assert.equal(out.kind, 'unique');
  assert.equal(out.node.ref, '@e0');
});
