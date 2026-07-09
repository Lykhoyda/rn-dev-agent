import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectTestIds,
  isExactPresent,
  buildCdpDispatch,
  unwrapTree,
} from '../../dist/tools/cdp-replay-dispatch.js';

const tree = {
  name: 'View',
  testID: 'screen',
  children: [
    { name: 'SubmitButton', testID: 'tab-tasks', children: [] },
    { name: 'Text', accessibilityLabel: 'tab-tasks-label', children: [] },
  ],
};

// Contract: the REAL __RN_AGENT.getTree() payload wraps the node under `.tree`
// (single match) or `.tree.matches[]` (multi match). The oracle must see
// testIDs through these wrappers — the boundary bug where it didn't made the
// fallback inert in production despite a green unit suite.
const GETTREE_SINGLE = { tree: { testID: 'fab-create-task', children: [] }, totalNodes: 1 };
const GETTREE_MULTI = {
  tree: {
    matches: [
      { testID: 'tab-tasks', children: [] },
      { testID: 'tab-feed', children: [] },
    ],
  },
  totalNodes: 2,
};

test('isExactPresent sees a testID through the real getTree `{ tree: <node> }` wrapper', () => {
  assert.equal(isExactPresent(GETTREE_SINGLE, 'fab-create-task'), true);
  assert.equal(isExactPresent(GETTREE_SINGLE, 'nope'), false);
});

test('isExactPresent sees testIDs through the `{ tree: { matches: [...] } }` multi-match wrapper', () => {
  assert.equal(isExactPresent(GETTREE_MULTI, 'tab-feed'), true);
  assert.equal(isExactPresent(GETTREE_MULTI, 'tab-tasks'), true);
  assert.equal(isExactPresent(GETTREE_MULTI, 'tab'), false); // substring, not verbatim
});

test('unwrapTree returns the bare node for a single match and the matches wrapper for many', () => {
  assert.deepEqual(unwrapTree(GETTREE_SINGLE), { testID: 'fab-create-task', children: [] });
  assert.deepEqual(unwrapTree(GETTREE_MULTI), {
    matches: [
      { testID: 'tab-tasks', children: [] },
      { testID: 'tab-feed', children: [] },
    ],
  });
  assert.equal(unwrapTree(null), null);
  // already a bare node (no `.tree`) → returned unchanged
  assert.deepEqual(unwrapTree({ testID: 'x', children: [] }), { testID: 'x', children: [] });
});

test('disabled-guard fires on a node found through the getTree `.tree` wrapper', async () => {
  const calls = [];
  const deps = {
    pressByTestId: async (id) => {
      calls.push(id);
    },
    typeByTestId: async () => {},
    treeFor: async () => ({
      tree: { testID: 'save', disabled: true, children: [] },
      totalNodes: 1,
    }),
    launchApp: async () => {},
    settle: async () => {},
  };
  await assert.rejects(buildCdpDispatch(deps).press('save'), /disabled|non-interactable/);
  assert.deepEqual(calls, [], 'must not press a disabled node found through the wrapper');
});

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
