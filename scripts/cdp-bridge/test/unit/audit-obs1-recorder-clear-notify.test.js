import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../../dist/observability/recorder.js';

// Audit OBS-1: Recorder.clear() used to empty the subscriber set silently,
// orphaning any live SSE connection (its res + heartbeat interval stayed open
// forever). clear() must now emit a terminal sentinel so subscribers can close.

test('OBS-1: clear() notifies live subscribers with a terminal sentinel before dropping them', () => {
  const rec = new Recorder();
  const received = [];
  const { detach } = rec.attach((ev) => received.push(ev));

  rec.clear();

  assert.equal(received.length, 1, 'subscriber should get exactly one terminal event');
  assert.equal(received[0].type, 'cleared', 'the sentinel must be the {type:"cleared"} terminal event');

  // After clear(), the subscriber set is empty — a subsequent record() reaches
  // no one (no lingering reference).
  rec.record({ tool: 'device_screenshot', ok: true, result: {} });
  assert.equal(received.length, 1, 'dropped subscriber must not receive post-clear events');

  detach(); // idempotent no-op now
});
