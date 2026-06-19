import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectTestIds,
  isExactPresent,
  buildCdpDispatch,
} from '../../dist/tools/cdp-replay-dispatch.js';

const tree = {
  name: 'View',
  testID: 'screen',
  children: [
    { name: 'SubmitButton', testID: 'tab-tasks', children: [] },
    { name: 'Text', accessibilityLabel: 'tab-tasks-label', children: [] },
  ],
};

test('isExactPresent: verbatim testID match → true', () => {
  assert.equal(isExactPresent(tree, 'tab-tasks'), true);
});
test('isExactPresent: absent testID → false', () => {
  assert.equal(isExactPresent(tree, 'tab-feed'), false);
});
test('isExactPresent: substring / label / name coincidence → false (not a filtered hit)', () => {
  assert.equal(isExactPresent(tree, 'tab'), false); // substring of tab-tasks
  assert.equal(isExactPresent(tree, 'tab-tasks-label'), false); // label, not testID
  assert.equal(isExactPresent(tree, 'SubmitButton'), false); // component name
});
test('collectTestIds gathers nested testIDs', () => {
  assert.deepEqual([...collectTestIds(tree)].sort(), ['screen', 'tab-tasks']);
});

// Regression test for #317: disabled-guard must resolve nativeID-identified nodes
function deps(tree) {
  const calls = [];
  return {
    calls,
    pressByTestId: async (id) => {
      calls.push(id);
    },
    typeByTestId: async () => {},
    treeFor: async () => tree,
    launchApp: async () => {},
    settle: async () => {},
  };
}

test('buildCdpDispatch.press: disabled node by testID → rejects, does not press', async () => {
  const d = deps({ testID: 'save', disabled: true, children: [] });
  await assert.rejects(buildCdpDispatch(d).press('save'));
  assert.deepEqual(d.calls, []);
});

test('buildCdpDispatch.press: disabled node by nativeID → rejects, does not press', async () => {
  const d = deps({ nativeID: 'save2', accessibilityState: { disabled: true }, children: [] });
  await assert.rejects(buildCdpDispatch(d).press('save2'));
  assert.deepEqual(d.calls, []);
});
