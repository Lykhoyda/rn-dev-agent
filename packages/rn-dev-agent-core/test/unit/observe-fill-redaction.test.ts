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

test('stored Observe timeline redacts fill text routed through device_batch and cdp_interact', () => {
  const recorder = new Recorder();
  recorder.record({
    tool: 'device_batch',
    params: {
      steps: [
        { action: 'find', text: 'Visible label' },
        { action: 'fill', testID: 'wizard-title-input', text: FILL_CANARY },
      ],
    },
    status: 'PASS',
    latencyMs: 11,
  });
  recorder.record({
    tool: 'cdp_interact',
    params: { action: 'typeText', testID: 'wizard-title-input', text: FILL_CANARY },
    status: 'PASS',
    latencyMs: 12,
  });
  recorder.record({
    tool: 'cdp_interact',
    params: { action: 'setFieldValue', name: 'title', value: FILL_CANARY },
    status: 'PASS',
    latencyMs: 13,
  });
  recorder.record({
    tool: 'cdp_interact',
    params: { action: 'press', text: 'Visible label' },
    status: 'PASS',
    latencyMs: 14,
  });

  const timeline = recorder.snapshot();
  assert.doesNotMatch(
    JSON.stringify(timeline),
    new RegExp(FILL_CANARY),
    'fill text must never be stored, whichever tool carried it',
  );

  const steps = timeline[0]?.args.steps as Array<Record<string, unknown>>;
  assert.deepEqual(steps[0], { action: 'find', text: 'Visible label' });
  assert.deepEqual(steps[1], {
    action: 'fill',
    testID: 'wizard-title-input',
    text: '[REDACTED:string]',
    textLength: FILL_CANARY.length,
  });

  assert.equal(timeline[1]?.args.text, '[REDACTED:string]');
  assert.equal(timeline[1]?.args.textLength, FILL_CANARY.length);
  assert.equal(timeline[1]?.args.testID, 'wizard-title-input');

  assert.equal(timeline[2]?.args.value, '[REDACTED:string]');
  assert.equal(timeline[2]?.args.valueLength, FILL_CANARY.length);
  assert.equal(timeline[2]?.args.name, 'title');

  assert.equal(timeline[3]?.args.text, 'Visible label', 'byText selectors stay readable');
});
