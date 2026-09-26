import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateNativePresence } from '../../../dist/qa/native-presence.js';

import { nativeCapture } from './platform-presence-fixtures.ts';

test('native presence requires a complete app/generation-bound unfiltered observation interval', () => {
  const source = nativeCapture();
  const valid = validateNativePresence(source.presenceCapture, source.nodes, 7, 'com.test');
  assert.ok(valid);
  assert.equal(valid.nodes[1].status, 'observed');
  assert.equal(valid.nodes[0].status, 'unknown');
  for (const patch of [
    { version: 2 },
    { source: 'geometry' },
    { enumeration: 'filtered' },
    { complete: false },
    { appId: 'other.app' },
    { generation: 8 },
    { generation: 7.5 },
    { captureId: '' },
    { startedUptimeMs: -1 },
    { endedUptimeMs: 99 },
    { endedUptimeMs: 5100 },
    { endedUptimeMs: Infinity },
  ])
    assert.equal(
      validateNativePresence({ ...source.presenceCapture, ...patch }, source.nodes, 7, 'com.test'),
      undefined,
    );
  for (const generation of [undefined, '7', 8])
    assert.equal(
      validateNativePresence(source.presenceCapture, source.nodes, generation, 'com.test'),
      undefined,
    );
  assert.equal(
    validateNativePresence(source.presenceCapture, source.nodes, 7, undefined),
    undefined,
  );
});

test('node evidence cannot be reused for a different capture, generation, index or observation time', () => {
  const source = nativeCapture();
  for (const patch of [
    { captureId: 'old' },
    { generation: 6 },
    { nodeIndex: 0 },
    { status: 'visible' },
    { status: true },
    { labelSource: 'inferred' },
    { observedUptimeMs: undefined },
    { observedUptimeMs: 99 },
    { observedUptimeMs: 201 },
    { observedUptimeMs: NaN },
    { status: 'unknown', observedUptimeMs: 150 },
  ]) {
    const nodes = [
      source.nodes[0],
      { ...source.nodes[1], presence: { ...source.nodes[1].presence, ...patch } },
    ];
    assert.equal(validateNativePresence(source.presenceCapture, nodes, 7, 'com.test'), undefined);
  }
});

test('complete native enumeration rejects lost hierarchy, bad geometry and duplicate references', () => {
  const source = nativeCapture();
  for (const nodes of [
    [],
    [source.nodes[1]],
    [source.nodes[0], source.nodes[0]],
    [source.nodes[0], { ...source.nodes[1], index: undefined }],
    [source.nodes[0], { ...source.nodes[1], parentIndex: undefined }],
    [source.nodes[0], { ...source.nodes[1], parentIndex: 1 }],
    [source.nodes[0], { ...source.nodes[1], depth: 2 }],
    [source.nodes[0], { ...source.nodes[1], ref: '@e0' }],
    [source.nodes[0], { ...source.nodes[1], rect: { x: NaN, y: 0, width: 1, height: 1 } }],
    [source.nodes[0], { ...source.nodes[1], rect: { x: 0, y: 0, width: 0, height: 1 } }],
    [source.nodes[0], { ...source.nodes[1], presence: undefined }],
  ])
    assert.equal(validateNativePresence(source.presenceCapture, nodes, 7, 'com.test'), undefined);
});

test('negative or unavailable native hittability is retained as unknown, never absence', () => {
  const source = nativeCapture();
  const { observedUptimeMs: _observedUptimeMs, ...observation } = source.nodes[1].presence;
  const nodes = [
    source.nodes[0],
    { ...source.nodes[1], presence: { ...observation, status: 'unknown' } },
  ];
  const valid = validateNativePresence(source.presenceCapture, nodes, 7, 'com.test');
  assert.ok(valid);
  assert.equal(valid.nodes[1].status, 'unknown');
});
