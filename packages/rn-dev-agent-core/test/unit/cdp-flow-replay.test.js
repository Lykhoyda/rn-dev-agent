import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSteps,
  UnsupportedStepError,
  replayFlow,
} from '../../dist/domain/cdp-flow-replay.js';

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
    { t: 'wait', timeoutMs: 400 },
    {
      t: 'runFlow',
      whenVisible: 'onboarding-screen',
      commands: [{ t: 'tap', id: 'onboarding-done' }],
    },
  ]);
});

test('normalizeSteps resolves Maestro-style nullish string defaults', () => {
  assert.deepEqual(normalizeSteps([{ inputText: "${LOGIN_EMAIL ?? 'safe@example.test'}" }], {}), [
    { t: 'type', text: 'safe@example.test' },
  ]);
  assert.deepEqual(
    normalizeSteps([{ inputText: "${LOGIN_EMAIL ?? 'safe@example.test'}" }], {
      LOGIN_EMAIL: 'bound@example.test',
    }),
    [{ t: 'type', text: 'bound@example.test' }],
  );
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

function mockDispatch(over = {}) {
  const calls = [];
  return {
    calls,
    press: async (id) => {
      calls.push(['press', id]);
      if (over.pressThrows?.includes(id)) throw new Error('disabled');
    },
    type: async (id, text) => {
      calls.push(['type', id, text]);
    },
    visibility: async (id) => {
      calls.push(['visibility', id]);
      return { visible: over.visible ? over.visible.includes(id) : true };
    },
    launch: async (stopApp) => {
      calls.push(['launch', stopApp]);
    },
    settle: async (timeoutMs) => {
      calls.push(['settle', timeoutMs]);
    },
  };
}

test('waitForAnimationToEnd preserves its configured timeout', async () => {
  const steps = normalizeSteps([{ waitForAnimationToEnd: { timeout: 2_500 } }], {});
  assert.deepEqual(steps, [{ t: 'wait', timeoutMs: 2_500 }]);
  const dispatch = mockDispatch();
  const result = await replayFlow(steps, dispatch);
  assert.equal(result.passed, true);
  assert.deepEqual(dispatch.calls, [['settle', 2_500]]);
});

test('replayFlow happy path: type routes to last tapped, all pass', async () => {
  const d = mockDispatch();
  const r = await replayFlow(
    [
      { t: 'tap', id: 'title' },
      { t: 'type', text: 'Hi' },
      { t: 'assert', id: 'step-2' },
    ],
    d,
  );
  assert.equal(r.passed, true);
  assert.deepEqual(d.calls, [
    ['press', 'title'],
    ['type', 'title', 'Hi'],
    ['visibility', 'step-2'],
  ]);
});

test('replayFlow can resume a proven React focus across proof-domain segments', async () => {
  const d = mockDispatch();
  const r = await replayFlow([{ t: 'type', text: 'Hi' }], d, {
    initialFocusId: 'title',
  });
  assert.equal(r.passed, true);
  assert.deepEqual(d.calls, [['type', 'title', 'Hi']]);
});

test('replayFlow runFlow recurses only when whenVisible present', async () => {
  const d = mockDispatch({ visible: ['onboarding', 'tabs'] });
  const r = await replayFlow(
    [
      { t: 'runFlow', whenVisible: 'onboarding', commands: [{ t: 'tap', id: 'done' }] },
      { t: 'assert', id: 'tabs' },
    ],
    d,
  );
  assert.equal(r.passed, true);
  assert.deepEqual(
    r.steps.map((step) => step.sourceIndex),
    [0, 1],
  );
});

test('replayFlow fails the step when a target is disabled (no false green)', async () => {
  const d = mockDispatch({ pressThrows: ['save'] });
  const r = await replayFlow([{ t: 'tap', id: 'save' }], d);
  assert.equal(r.passed, false);
  assert.equal(r.failedStepIndex, 0);
});

test('replayFlow fails assert when target not visible', async () => {
  const r = await replayFlow([{ t: 'assert', id: 'ghost' }], mockDispatch({ visible: [] }));
  assert.equal(r.passed, false);
});
