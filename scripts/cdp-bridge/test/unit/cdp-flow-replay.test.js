import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSteps, UnsupportedStepError } from '../../dist/domain/cdp-flow-replay.js';

test('normalizeSteps maps the supported subset with ${VAR} interpolation', () => {
  const body = [
    { launchApp: { stopApp: false } },
    { tapOn: { id: 'wizard-title-input' } },
    { inputText: '${TITLE}' },
    { assertVisible: { id: 'wizard-step-1' } },
    { tapOn: { id: 'wizard-priority-${PRIORITY}' } },
    'waitForAnimationToEnd',
    {
      runFlow: {
        when: { visible: { id: 'onboarding-screen' } },
        commands: [{ tapOn: { id: 'onboarding-done' } }],
      },
    },
  ];
  const steps = normalizeSteps(body, { TITLE: 'Ship it', PRIORITY: 'high' });
  assert.deepEqual(steps, [
    { t: 'launch', stopApp: false },
    { t: 'tap', id: 'wizard-title-input' },
    { t: 'type', text: 'Ship it' },
    { t: 'assert', id: 'wizard-step-1' },
    { t: 'tap', id: 'wizard-priority-high' },
    { t: 'wait' },
    {
      t: 'runFlow',
      whenVisible: 'onboarding-screen',
      commands: [{ t: 'tap', id: 'onboarding-done' }],
    },
  ]);
});

test('normalizeSteps throws UnsupportedStepError on an unknown step', () => {
  assert.throws(
    () => normalizeSteps([{ scroll: { direction: 'DOWN' } }], {}),
    (e) => {
      assert.ok(e instanceof UnsupportedStepError);
      assert.equal(e.stepKey, 'scroll');
      return true;
    },
  );
});

test('normalizeSteps rejects malformed supported steps (never a silent "undefined" target)', () => {
  assert.throws(() => normalizeSteps([{ tapOn: {} }], {}), UnsupportedStepError); // missing id
  assert.throws(() => normalizeSteps([{ tapOn: null }], {}), UnsupportedStepError); // null value
  assert.throws(() => normalizeSteps([{ inputText: { id: 'x' } }], {}), UnsupportedStepError); // not a string
  assert.throws(() => normalizeSteps([{ tapOn: { id: 'a' }, extra: 1 }], {}), UnsupportedStepError); // >1 key
  assert.throws(() => normalizeSteps([42], {}), UnsupportedStepError); // non-object
});
