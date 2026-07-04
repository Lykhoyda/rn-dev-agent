import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashSnapshotNodes } from '../../dist/lifecycle/settle-hash.js';

const node = (over = {}) => ({
  ref: '@e0', type: 'Button', label: 'Save', identifier: 'save-btn',
  rect: { x: 100, y: 200, width: 120, height: 44 }, ...over,
});

test('identical node lists hash identically', () => {
  assert.equal(hashSnapshotNodes([node()]), hashSnapshotNodes([node()]));
});

test('sub-4px bounds jitter does NOT change the hash', () => {
  const jittered = node({ rect: { x: 101, y: 201, width: 120, height: 44 } });
  assert.equal(hashSnapshotNodes([node()]), hashSnapshotNodes([jittered]));
});

test('a real transition (moved element) DOES change the hash', () => {
  const moved = node({ rect: { x: 100, y: 420, width: 120, height: 44 } });
  assert.notEqual(hashSnapshotNodes([node()]), hashSnapshotNodes([moved]));
});

test('label/text change registers', () => {
  assert.notEqual(hashSnapshotNodes([node()]), hashSnapshotNodes([node({ label: 'Saving…' })]));
});

test('synthetic ref churn alone does NOT change the hash', () => {
  assert.equal(hashSnapshotNodes([node()]), hashSnapshotNodes([node({ ref: '@e7' })]));
});

test('node added/removed changes the hash', () => {
  assert.notEqual(hashSnapshotNodes([node()]), hashSnapshotNodes([node(), node({ identifier: 'x' })]));
});

test('empty list hashes deterministically', () => {
  assert.equal(hashSnapshotNodes([]), hashSnapshotNodes([]));
});
