import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen, NativeCaptureError } from '../../../dist/qa/capture.js';
import type { ReactObservation } from '../../../dist/qa/capture.js';
import { bindPrivateInputs, PrivateInputCaptureError } from '../../../dist/qa/private-input.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import type { TimingEvent } from '../../../dist/qa/timing.js';
import { nativeCapture } from './platform-presence-fixtures.ts';

const secret = 'private-rn-only@example.test';
const verdict = { state: 'ok', path: 'interactive', complete: true } as const;

function scripted(reactAttempts: Array<() => Promise<ReactObservation>>) {
  const calls = { native: 0, react: 0 };
  const events: TimingEvent[] = [];
  return {
    calls,
    events,
    deps: {
      native: async () => {
        calls.native += 1;
        return { nodes: [{ ref: '@save', type: 'Button', label: 'Save', hittable: true }] };
      },
      react: async () => reactAttempts[calls.react++](),
      timing: (event: TimingEvent) => events.push(event),
    },
  };
}

const refusesOnce = () => Promise.reject(new PrivateInputCaptureError());
const refreshes = (events: TimingEvent[]) => events.filter((e) => e.stage === 'refresh').length;

test('a private-input refusal gets one complete fresh capture and the second capture is returned', async () => {
  const s = scripted([
    refusesOnce,
    async () => ({ interactive: [{ role: 'button', testID: 'save' }], verdict }),
  ]);
  const screen = await captureScreen(s.deps);
  assert.deepEqual(s.calls, { native: 2, react: 2 });
  assert.equal(refreshes(s.events), 1);
  assert.equal(s.events.filter((e) => e.stage === 'native-total' && e.edge === 'end').length, 2);
  assert.equal(screen.captureCoverage?.react, 'complete');
});

test('a second refusal refuses exactly as before, without a third attempt', async () => {
  const s = scripted([refusesOnce, refusesOnce, () => assert.fail('no third attempt')]);
  await assert.rejects(captureScreen(s.deps), PrivateInputCaptureError);
  assert.deepEqual(s.calls, { native: 2, react: 2 });
  assert.equal(refreshes(s.events), 1);
});

test('native and other failures are never retried', async () => {
  let natives = 0;
  await assert.rejects(
    captureScreen({
      requirePrivateInputs: true,
      native: async () => {
        natives += 1;
        throw new Error('runner down');
      },
      react: async () => assert.fail('native failed first'),
    }),
    NativeCaptureError,
  );
  assert.equal(natives, 1);
  const s = scripted([
    () => Promise.reject(new Error('not a private refusal')),
    () => assert.fail('no retry'),
  ]);
  const screen = await captureScreen(s.deps);
  assert.deepEqual(s.calls, { native: 1, react: 1 });
  assert.equal(refreshes(s.events), 0);
  assert.equal(screen.coverage?.react, 'unknown');
});

test('a retried required capture still binds and masks private input values', async () => {
  const native = nativeCapture();
  const echo = {
    ...native,
    nodes: [
      native.nodes[0],
      { ...native.nodes[1], identifier: undefined, type: 'StaticText', label: secret },
    ],
  };
  const react: ReactObservation = {
    interactive: [],
    verdict,
    hostEvidence: {
      complete: true,
      hosts: [{ role: null, roleSource: 'none', capabilities: {}, readOnly: true }],
    },
  };
  let reads = 0;
  const screen = await captureScreen({
    requirePrivateInputs: true,
    appId: 'com.test',
    native: async () => echo,
    react: async () => {
      reads += 1;
      if (reads === 1) throw new PrivateInputCaptureError();
      return bindPrivateInputs(react, {
        version: 1,
        complete: true,
        facts: [{ hostIndex: 0, values: [secret], secure: false }],
      });
    },
  });
  assert.equal(reads, 2);
  assert.equal(screen.elements[1].value, undefined);
  const privacy = new ObservedPrivacy();
  privacy.observe(screen);
  assert.equal(privacy.redact(secret), '•••');
});

test('a tap whose post-act capture refuses once on private input still passes', async () => {
  const { walker, scriptedJudge } = await import('./judgment-fixtures.ts');
  const { parsePlan } = await import('../../../dist/qa/plan.js');
  const { runPlan } = await import('../../../dist/qa/walker.js');
  const events: TimingEvent[] = [];
  let reads = 0;
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('a quoted tap needs no model')),
  );
  f.deps.timing = (event) => events.push(event);
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
          verdict,
        };
      },
    });
  const plan = parsePlan('1. Tap "save"');
  assert.ok(plan.blocks);
  const result = await runPlan(plan.blocks, f.deps);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.deepEqual(f.actions, ['press @e1']);
  assert.equal(events.filter((e) => e.stage === 'refresh').length, 1);
  assert.equal(events.filter((e) => e.stage === 'native-total' && e.edge === 'end').length, 3);
});
