import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen, NativeCaptureError } from '../../../dist/qa/capture.js';
import { PrivateInputCaptureError } from '../../../dist/qa/private-input.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import type { TimingEvent } from '../../../dist/qa/timing.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { nativeCapture } from './platform-presence-fixtures.ts';

const secret = 'field-secret@example.test';

function withField() {
  const native = nativeCapture();
  native.nodes.push({
    ...native.nodes[1],
    ref: '@email',
    index: 2,
    type: 'TextField',
    identifier: 'email',
    label: 'Email',
    value: secret,
    presence: { ...native.nodes[1].presence, nodeIndex: 2 },
  });
  native.snapshotVerdict.nodeCount = native.nodes.length;
  return { ...native, presenceCapture: undefined };
}

test('a React digest failure degrades coverage without a retry or a refusal', async () => {
  for (const failure of [
    new PrivateInputCaptureError(),
    new Error('transport closed'),
    new Error('malformed digest'),
  ]) {
    let natives = 0;
    let reads = 0;
    const events: TimingEvent[] = [];
    const screen = await captureScreen({
      requirePrivateInputs: true,
      appId: 'com.test',
      native: async () => {
        natives += 1;
        return withField();
      },
      react: async () => {
        reads += 1;
        throw failure;
      },
      timing: (event) => events.push(event),
    });
    assert.deepEqual({ natives, reads }, { natives: 1, reads: 1 });
    assert.equal(screen.coverage?.react, 'unknown');
    assert.equal(events.filter((event) => event.stage === 'refresh').length, 0);
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(privacy.redact(`typed ${secret}`), 'typed •••');
    assert.equal(privacy.canScreenshot(), false);
  }
});

test('a native snapshot failure still refuses', async () => {
  await assert.rejects(
    captureScreen({
      requirePrivateInputs: true,
      native: async () => {
        throw new Error('runner down');
      },
      react: async () => assert.fail('native failed first'),
    }),
    NativeCaptureError,
  );
});

test('a tap whose post-act digest fails still passes on native evidence', async () => {
  let reads = 0;
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('a quoted tap needs no model')),
  );
  f.deps.captureScreen = (options) =>
    captureScreen({
      timing: options?.timing,
      native: async () => ({ ...nativeCapture(), presenceCapture: undefined }),
      react: async () => {
        reads += 1;
        if (reads === 2) throw new PrivateInputCaptureError();
        return {
          interactive: [
            { role: 'button', testID: 'save', capabilities: { press: true, fill: false } },
          ],
          verdict: { state: 'ok', path: 'interactive', complete: true },
        };
      },
    });
  const result = await runPlan(parsePlan('1. Tap "save"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.deepEqual(f.actions, ['press @e1']);
});
