import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../../dist/observability/recorder.js';

test('record assigns monotonic seq and snapshot returns chronological order', () => {
  const r = new Recorder(3);
  r.record({ tool: 'cdp_status', params: {}, status: 'PASS', latencyMs: 1 });
  r.record({ tool: 'device_press', params: { ref: 'e1' }, status: 'PASS', latencyMs: 2 });
  const snap = r.snapshot();
  assert.equal(snap.length, 2); assert.equal(snap[0].seq, 1); assert.equal(snap[1].seq, 2);
});
test('ring buffer evicts oldest beyond capacity', () => {
  const r = new Recorder(2);
  for (let i = 0; i < 5; i++) r.record({ tool: 'cdp_status', params: {}, status: 'PASS', latencyMs: 1 });
  const snap = r.snapshot();
  assert.equal(snap.length, 2); assert.equal(snap[1].seq, 5);
});
test('attach() returns a same-tick snapshot and delivers subsequent events (no gap)', () => {
  const r = new Recorder(10);
  r.record({ tool: 'cdp_status', params: {}, status: 'PASS', latencyMs: 1 });
  const got = [];
  const { snapshot, detach } = r.attach((e) => got.push(e.seq));
  assert.equal(snapshot.length, 1);
  r.record({ tool: 'device_press', params: {}, status: 'PASS', latencyMs: 1 });
  assert.deepEqual(got, [2]);
  detach();
  r.record({ tool: 'device_press', params: {}, status: 'PASS', latencyMs: 1 });
  assert.deepEqual(got, [2]);
});
test('record swallows errors (never throws into the caller)', () => {
  const r = new Recorder(2);
  assert.doesNotThrow(() => r.record(null));
});
