import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectTestIds, isExactPresent } from '../../dist/tools/cdp-replay-dispatch.js';

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
