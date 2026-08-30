import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectTestIds,
  isExactPresent,
  buildCdpDispatch,
  replayTreeData,
  runCdpReplayCommands,
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

test('buildCdpDispatch counts the filtered tree once when the interactive digest repeats it', async () => {
  const calls = [];
  const dispatch = buildCdpDispatch({
    pressByTestId: async (id) => calls.push(id),
    typeByTestId: async () => {},
    treeFor: async () => ({
      tree: { testID: 'quick-add-fab', children: [] },
      interactive: [{ testID: 'quick-add-fab' }],
    }),
    launchApp: async () => {},
    settle: async () => {},
  });
  await dispatch.press('quick-add-fab');
  assert.deepEqual(calls, ['quick-add-fab']);
});

test('buildCdpDispatch accepts propagated fiber matches collapsed by the frontmost oracle', async () => {
  const calls = [];
  const dispatch = buildCdpDispatch({
    pressByTestId: async (id) => calls.push(id),
    typeByTestId: async () => {},
    treeFor: async () => ({
      tree: { matches: [{ testID: 'welcome' }, { testID: 'welcome' }] },
    }),
    frontmostFor: async () => ({ visible: true, matchCount: 1 }),
    launchApp: async () => {},
    settle: async () => {},
  });
  await dispatch.press('welcome');
  assert.deepEqual(calls, ['welcome']);
});

test('buildCdpDispatch uses a complete interactive fallback only for visibility', async () => {
  let mutations = 0;
  const dispatch = buildCdpDispatch({
    pressByTestId: async () => {
      mutations += 1;
    },
    typeByTestId: async () => {},
    treeFor: async () =>
      unwrapTree(
        replayTreeData(
          {
            ok: true,
            data: { interactive: [{ testID: 'otp' }] },
            meta: {
              treeVerdict: {
                state: 'ok',
                path: 'interactive',
                reasons: [],
                rootsSeeded: 1,
                droppedSubtrees: 0,
                collapsedChildLists: 0,
              },
            },
          },
          'otp',
        ),
      ),
    frontmostFor: async () => ({ visible: true }),
    launchApp: async () => {},
    settle: async () => {},
  });
  assert.deepEqual(await dispatch.visibility('otp'), { visible: true });
  await assert.rejects(dispatch.press('otp'), /not present/);
  assert.equal(mutations, 0);
});

test('buildCdpDispatch revalidates a retained input target before mutation', async () => {
  let mutations = 0;
  const dispatch = buildCdpDispatch({
    pressByTestId: async () => {},
    typeByTestId: async () => {
      mutations += 1;
    },
    treeFor: async () => ({ tree: { testID: 'stale-field', children: [] } }),
    frontmostFor: async () => ({ visible: false, reason: 'field is behind a modal' }),
    launchApp: async () => {},
    settle: async () => {},
  });
  await assert.rejects(dispatch.type('stale-field', 'value'), /behind a modal/);
  assert.equal(mutations, 0);
});

test('buildCdpDispatch refuses two distinct filtered tree matches as ambiguous', async () => {
  const dispatch = buildCdpDispatch({
    pressByTestId: async () => {},
    typeByTestId: async () => {},
    treeFor: async () => ({
      tree: { matches: [{ testID: 'duplicate' }, { testID: 'duplicate' }] },
    }),
    launchApp: async () => {},
    settle: async () => {},
  });
  await assert.rejects(dispatch.press('duplicate'), /resolves to 2 mounted elements/);
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

test('replayTreeData accepts exact presence independently and complete filtered absence', () => {
  const completeFilterVerdict = {
    state: 'ok',
    path: 'filter',
    reasons: [],
    rootsSeeded: 1,
    droppedSubtrees: 0,
    collapsedChildLists: 0,
  };
  assert.deepEqual(
    replayTreeData(
      {
        ok: true,
        data: { tree: { testID: 'otp', children: [] } },
        meta: { treeVerdict: { ...completeFilterVerdict, droppedSubtrees: 1 } },
      },
      'otp',
    ),
    { tree: { testID: 'otp', children: [] } },
  );
  assert.deepEqual(
    replayTreeData(
      {
        ok: true,
        data: { tree: null },
        meta: { treeVerdict: completeFilterVerdict },
      },
      'missing',
    ),
    { tree: null },
  );
  assert.deepEqual(
    replayTreeData(
      {
        ok: true,
        data: { interactive: [{ testID: 'otp' }] },
        meta: {
          treeVerdict: {
            state: 'degraded',
            path: 'interactive',
            reasons: ['scan-budget-exhausted'],
            rootsSeeded: 1,
            droppedSubtrees: 0,
            collapsedChildLists: 0,
          },
        },
      },
      'otp',
    ),
    { interactive: [{ testID: 'otp' }] },
  );
  assert.throws(
    () =>
      replayTreeData(
        {
          ok: true,
          data: { tree: null },
          meta: {
            treeVerdict: {
              ...completeFilterVerdict,
              state: 'degraded',
              reasons: ['scan-budget-exhausted'],
            },
          },
        },
        'missing',
      ),
    (error) => error.code === 'EVAL_FAILED' && error.meta?.treeEnvelope?.incomplete === true,
  );
});

test('replayTreeData refuses filtered evidence that cannot prove exact-id absence', () => {
  const treeVerdict = {
    state: 'ok',
    path: 'filter',
    reasons: [],
    rootsSeeded: 1,
    droppedSubtrees: 0,
    collapsedChildLists: 0,
  };
  for (const envelope of [
    {
      ok: true,
      data: { tree: { name: 'otp-container', children: [] } },
      meta: { treeVerdict },
    },
    {
      ok: true,
      data: { tree: null },
      meta: { treeVerdict: { ...treeVerdict, droppedSubtrees: 1 } },
    },
    {
      ok: true,
      data: { tree: null },
      meta: { treeVerdict: { ...treeVerdict, collapsedChildLists: 1 } },
    },
    {
      ok: true,
      data: { tree: null },
      meta: { treeVerdict: { ...treeVerdict, rootsSeeded: 0 } },
    },
    {
      ok: true,
      data: {
        tree: { matches: Array.from({ length: 10 }, () => ({ testID: 'otp' })) },
      },
      meta: { treeVerdict },
    },
  ]) {
    assert.throws(
      () => replayTreeData(envelope, 'otp'),
      (error) => error.code === 'EVAL_FAILED' && error.meta?.treeEnvelope?.incomplete === true,
    );
  }
});

test('React replay propagates a component-tree transport envelope without selector repair evidence', async () => {
  const replay = await runCdpReplayCommands(
    [{ assertVisible: { id: 'ready' } }],
    {},
    {
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () =>
        replayTreeData({
          ok: false,
          code: 'RECONNECT_TIMEOUT',
          error: 'Component tree connection timed out',
          meta: { reconnectAttempted: true },
        }),
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'RECONNECT_TIMEOUT');
  assert.equal(replay.failureMeta?.failedSelector, 'ready');
  assert.equal(typeof replay.failureMeta?.waitedMs, 'number');
  assert.equal(replay.steps[0].t, 'assert');
  assert.deepEqual(replay.failureMeta?.treeEnvelope, {
    ok: false,
    code: 'RECONNECT_TIMEOUT',
    error: 'Component tree connection timed out',
    meta: { reconnectAttempted: true },
  });
});

test('React replay refuses a truncated component tree distinctly from readable absence', async () => {
  const replay = await runCdpReplayCommands(
    [{ extendedWaitUntil: { visible: { id: 'otp' }, timeout: 250 } }],
    {},
    {
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () =>
        replayTreeData({
          ok: true,
          data: { __agent_truncated: true, originalLength: 75_000 },
        }),
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'EVAL_FAILED');
  assert.equal(replay.failedStepIndex, 0);
  assert.deepEqual(replay.failureMeta?.treeEnvelope, {
    ok: true,
    truncated: true,
    originalLength: 75_000,
  });
});

test('React replay refuses helper-truncated filtered evidence', async () => {
  const replay = await runCdpReplayCommands(
    [{ extendedWaitUntil: { visible: { id: 'otp' }, timeout: 250 } }],
    {},
    {
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () =>
        replayTreeData({
          ok: true,
          data: { tree: { testID: 'otp' }, truncated: true },
          meta: {
            treeVerdict: {
              state: 'degraded',
              path: 'filter',
              reasons: ['output-truncated'],
            },
          },
        }),
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'EVAL_FAILED');
  assert.equal(replay.failureMeta?.treeEnvelope?.truncated, true);
});

test('React replay refuses budget-exhausted absence as incomplete evidence', async () => {
  const replay = await runCdpReplayCommands(
    [{ extendedWaitUntil: { visible: { id: 'otp' }, timeout: 250 } }],
    {},
    {
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () =>
        replayTreeData({
          ok: true,
          data: { tree: null },
          meta: {
            treeVerdict: {
              state: 'degraded',
              path: 'filter',
              reasons: ['scan-budget-exhausted'],
            },
          },
        }),
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'EVAL_FAILED');
  assert.equal(replay.failureMeta?.treeEnvelope?.incomplete, true);
  assert.equal(replay.failureMeta?.failedSelector, 'otp');
});

test('React replay propagates APP_HAS_REDBOX instead of reporting a missing testID', async () => {
  const replay = await runCdpReplayCommands(
    [{ tapOn: { id: 'submit' } }],
    {},
    {
      pressByTestId: async () => assert.fail('redbox must refuse before mutation'),
      typeByTestId: async () => {},
      treeFor: async () =>
        replayTreeData({
          ok: true,
          data: { message: 'App is showing an error screen.' },
          meta: { warning: 'APP_HAS_REDBOX', treeVerdict: { quality: 'unavailable' } },
        }),
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'APP_HAS_REDBOX');
  assert.equal(replay.failureMeta?.failedSelector, undefined);
  assert.deepEqual(replay.failureMeta?.treeEnvelope, {
    ok: true,
    warning: 'APP_HAS_REDBOX',
    message: 'App is showing an error screen.',
    meta: { warning: 'APP_HAS_REDBOX', treeVerdict: { quality: 'unavailable' } },
  });
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

test('press refuses a child beneath pointerEvents none or box-only ancestors', async () => {
  const calls = [];
  const base = {
    pressByTestId: async () => calls.push('press'),
    typeByTestId: async () => calls.push('type'),
    launchApp: async () => {},
    settle: async () => {},
  };
  for (const pointerEvents of ['none', 'box-only']) {
    await assert.rejects(
      buildCdpDispatch({
        ...base,
        treeFor: async () => ({
          tree: { props: { pointerEvents }, children: [{ testID: 'child', children: [] }] },
        }),
      }).press('child'),
      /not user-interactable/,
    );
  }
  assert.deepEqual(calls, []);
});

test('text input preserves box-none and auto ancestors but rejects hidden hit-testing', async () => {
  const calls = [];
  const tree = (pointerEvents) => ({
    tree: { props: { pointerEvents }, children: [{ testID: 'field', children: [] }] },
  });
  const make = (value) =>
    buildCdpDispatch({
      pressByTestId: async () => {},
      typeByTestId: async () => calls.push('type'),
      treeFor: async () => tree(value),
      launchApp: async () => {},
      settle: async () => {},
    });
  await make('box-none').type('field', 'ok');
  await make('auto').type('field', 'ok');
  await assert.rejects(make('none').type('field', 'no'), /not user-interactable/);
  assert.deepEqual(calls, ['type', 'type']);
});

test('target box-none refuses press and type without dispatch', async () => {
  const calls = [];
  const dispatch = buildCdpDispatch({
    pressByTestId: async () => calls.push('press'),
    typeByTestId: async () => calls.push('type'),
    treeFor: async () => ({ tree: { testID: 'target', props: { pointerEvents: 'box-none' } } }),
    launchApp: async () => {},
    settle: async () => {},
  });
  await assert.rejects(dispatch.press('target'), /target has pointerEvents="box-none"/);
  await assert.rejects(dispatch.type('target', 'value'), /target has pointerEvents="box-none"/);
  assert.deepEqual(calls, []);
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
