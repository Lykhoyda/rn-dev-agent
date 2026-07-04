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

test('same-quantization-bucket jitter (±1px within a 4px bucket) does NOT change the hash', () => {
  const jittered = node({ rect: { x: 101, y: 201, width: 120, height: 44 } });
  assert.equal(hashSnapshotNodes([node()]), hashSnapshotNodes([jittered]));
});

test('bucket-crossing movement registers (quantization is bucketed, not a distance threshold)', () => {
  const crossed = node({ rect: { x: 102, y: 200, width: 120, height: 44 } });
  assert.notEqual(hashSnapshotNodes([node()]), hashSnapshotNodes([crossed]));
});

test('delimiter-lookalike content in labels cannot alias node boundaries', () => {
  const tricky = [node({ label: 'a\nb', identifier: '' })];
  const split = [node({ label: 'a', identifier: '' }), node({ label: 'b', identifier: '' })];
  assert.notEqual(hashSnapshotNodes(tricky), hashSnapshotNodes(split));
});

test('raw control bytes in app-controlled strings cannot alias field/node boundaries', () => {
  const controlBytes = [node({ label: 'a\0b\x01c', identifier: '' })];
  const shifted = [node({ label: 'a', identifier: 'b\x01c' })];
  assert.notEqual(hashSnapshotNodes(controlBytes), hashSnapshotNodes(shifted));
});

test('enabled/hittable state flips register as UI change', () => {
  assert.notEqual(
    hashSnapshotNodes([node({ enabled: true, hittable: true })]),
    hashSnapshotNodes([node({ enabled: false, hittable: true })]),
  );
  assert.notEqual(
    hashSnapshotNodes([node({ enabled: true, hittable: true })]),
    hashSnapshotNodes([node({ enabled: true, hittable: false })]),
  );
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
