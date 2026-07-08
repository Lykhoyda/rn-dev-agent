import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../../dist/observability/recorder.js';

test('push broadcasts a custom event to all subscribers', () => {
  const r = new Recorder();
  const seen = [];
  r.attach((e) => seen.push(e));
  r.push({ type: 'e2e-progress', completed: 1, total: 3 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'e2e-progress');
  assert.equal(seen[0].completed, 1);
});
test('push swallows a throwing subscriber and still reaches others', () => {
  const r = new Recorder();
  const seen = [];
  r.attach(() => {
    throw new Error('boom');
  });
  r.attach((e) => seen.push(e));
  r.push({ type: 'e2e-done', runId: 'x' });
  assert.equal(seen.length, 1);
});
