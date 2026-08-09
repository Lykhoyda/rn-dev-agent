import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Recorder } from '../../dist/observability/recorder.js';

const FILL_CANARY = 'OBSERVE-FILL-CANARY-x7pz3q';

test('stored Observe timeline redacts device_fill text while retaining diagnostic metadata', () => {
  const recorder = new Recorder();
  recorder.record({
    tool: 'device_press',
    params: { ref: '@e12', text: 'Visible label' },
    status: 'PASS',
    latencyMs: 7,
  });
  recorder.record({
    tool: 'device_fill',
    params: {
      ref: '@e53',
      testID: 'wizard-title-input',
      text: FILL_CANARY,
      waitForKeyboardMs: 100,
    },
    status: 'FAIL',
    latencyMs: 42,
    error: 'exact read-back failed',
  });

  const timeline = recorder.snapshot();
  const serialized = JSON.stringify(timeline);
  assert.doesNotMatch(serialized, new RegExp(FILL_CANARY), 'fill text must never be stored');
  assert.deepEqual(
    timeline.map(({ seq, tool }) => ({ seq, tool })),
    [
      { seq: 1, tool: 'device_press' },
      { seq: 2, tool: 'device_fill' },
    ],
  );
  assert.equal(timeline[0]?.args.text, 'Visible label', 'unrelated tool arguments are unchanged');

  const fill = timeline[1];
  assert.ok(fill);
  assert.equal(fill.args.ref, '@e53');
  assert.equal(fill.args.testID, 'wizard-title-input');
  assert.equal(fill.args.text, '[REDACTED:string]');
  assert.equal(fill.args.textLength, FILL_CANARY.length);
  assert.equal(fill.args.waitForKeyboardMs, 100);
  assert.equal(fill.ok, false);
  assert.equal(fill.durationMs, 42);
});
