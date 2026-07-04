import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateRefMapFromFlat,
  clearRefMap,
  getCachedSignature,
  getCachedMetadata,
  getLastSnapshotHash,
  invalidateLastSnapshotHash,
} from '../../dist/fast-runner-ref-map.js';
import { hashSnapshotNodes } from '../../dist/lifecycle/settle-hash.js';

const rect = (x = 0, y = 0) => ({ x, y, width: 100, height: 40 });
const nodes = [
  { ref: '@e0', type: 'Button', label: 'Save', identifier: 'save-btn', rect: rect(0, 0) },
  { ref: '@e1', type: 'Button', label: 'Cancel', rect: rect(0, 50) },
  { ref: '@e2', type: 'TextField', identifier: 'name-input', rect: rect(0, 100) },
];

beforeEach(() => clearRefMap());

test('getCachedSignature returns identity attrs + flatIndex + nodeCount', () => {
  updateRefMapFromFlat(nodes);
  assert.deepEqual(getCachedSignature('@e1'), {
    type: 'Button',
    label: 'Cancel',
    flatIndex: 1,
    nodeCount: 3,
  });
  assert.deepEqual(getCachedSignature('e0'), {
    type: 'Button',
    label: 'Save',
    identifier: 'save-btn',
    flatIndex: 0,
    nodeCount: 3,
  });
});

test('getCachedSignature returns null for unknown ref and after clear', () => {
  updateRefMapFromFlat(nodes);
  assert.equal(getCachedSignature('@e99'), null);
  clearRefMap();
  assert.equal(getCachedSignature('@e0'), null);
});

test('getCachedMetadata keeps its exact legacy 3-field shape', () => {
  updateRefMapFromFlat(nodes);
  assert.deepEqual(getCachedMetadata('@e0'), {
    type: 'Button',
    label: 'Save',
    identifier: 'save-btn',
  });
});

test('getLastSnapshotHash matches hashSnapshotNodes of the fed nodes; null after clear', () => {
  assert.equal(getLastSnapshotHash(), null);
  updateRefMapFromFlat(nodes);
  assert.equal(getLastSnapshotHash(), hashSnapshotNodes(nodes));
  clearRefMap();
  assert.equal(getLastSnapshotHash(), null);
});

test('invalidateLastSnapshotHash nulls the baseline without touching refs', () => {
  updateRefMapFromFlat(nodes);
  invalidateLastSnapshotHash();
  assert.equal(getLastSnapshotHash(), null);
  assert.notEqual(getCachedSignature('@e0'), null); // refs still resolvable
});

test('flatIndex is the raw array position when skipped entries are interleaved; hash is guarded', () => {
  const withMalformed = [
    { ref: '@e0', type: 'Button', label: 'Save', rect: rect(0, 0) },
    { ref: '', type: 'Other', rect: undefined },
    { ref: '@e1', type: 'Button', label: 'Cancel', rect: rect(0, 50) },
  ];
  updateRefMapFromFlat(withMalformed);
  assert.equal(getCachedSignature('@e1').flatIndex, 2); // raw position, not filtered position
  assert.equal(typeof getLastSnapshotHash(), 'string'); // hash of the two valid nodes, no throw
});
