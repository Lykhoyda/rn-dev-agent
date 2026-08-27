import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import {
  nativeSelectorsForCommands,
  planIosProofDomains,
  selectorsVisibleInNativeSnapshot,
  soleComparableNativeSelectorForCommands,
} from '../../dist/domain/ios-proof-router.js';
import {
  createMaestroRunHandler,
  executeMaestroAuthorityStages,
  runFlowParked,
} from '../../dist/tools/maestro-run.js';
import { runCdpReplayCommands } from '../../dist/tools/cdp-replay-dispatch.js';
import { performReactTreeInput } from '../../dist/tools/device-interact.js';
import { chooseMaestroDispatch } from '../../dist/tools/maestro-dispatch.js';
import { buildReplayEngineStatus, MAESTRO_RUNNER_PIN } from '../../dist/domain/engine-pin.js';
import { reapStaleFastRunner } from '../../dist/runners/rn-fast-runner-client.js';
import {
  normalizeSteps,
  replayFlow,
  UnsupportedStepError,
} from '../../dist/domain/cdp-flow-replay.js';

function envelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text) as {
    ok?: boolean;
    code?: string;
    data?: Record<string, any>;
    meta?: Record<string, any>;
    error?: string;
  };
}

const callbacks = {
  claimNativeOrigin: async () => {},
  completeNativeOrigin: async () => {},
  relaunchManagedApp: async () => {},
  reproveManagedOrigin: async () => {},
  completeRunnerPark: async () => {},
};

test('exact iOS commands route before dispatch to react-tree proof', async () => {
  const calls: string[] = [];
  const handler = createMaestroRunHandler({
    chooseDispatch: () => {
      throw new Error('WDA dispatch must not be selected for an exact React flow');
    },
    replayDeps: () => ({
      pressByTestId: async (id) => calls.push(`press:${id}`),
      typeByTestId: async (id, text) => calls.push(`type:${id}:${text}`),
      treeFor: async (id) => ({ testID: id, children: [] }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => calls.push('unexpected-launch'),
      settle: async () => calls.push('settle'),
    }),
    getLiveRoute: async () => 'home',
  });

  const result = await handler({
    platform: 'ios',
    inlineYaml: `appId: com.example.app
---
- launchApp:
    stopApp: false
- tapOn:
    id: email
- inputText: a
- assertVisible:
    id: home
`,
    actionMetadata: {
      id: 'login-en',
      enginePin: 'maestro-runner@1.1.24',
      tags: ['auth', 'login'],
      expectedRouteSequence: ['home'],
    },
    ...callbacks,
  });
  const env = envelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.data?.passed, true);
  assert.equal(env.data?.proofDomain, 'react-tree');
  assert.equal(env.data?.maestroCertified, false);
  assert.deepEqual(calls, ['press:email', 'type:email:a']);
});

test('React launchApp stopApp is forwarded to the authority relaunch lifecycle', async () => {
  const relaunches: boolean[] = [];
  const run = (launch: unknown) =>
    executeMaestroAuthorityStages(
      [launch, { tapOn: { id: 'email' } }],
      async (commands) => commands,
      async () => {},
      async () => {},
      async (stopApp) => relaunches.push(stopApp ?? true),
    );

  await run({ launchApp: { stopApp: false } });
  await run({ launchApp: { stopApp: true } });
  await run({ launchApp: null });
  assert.deepEqual(relaunches, [false, true, true]);
});

test('partitioned reconnect recovery honors the replay deadline', async () => {
  const started = Date.now();
  const handler = createMaestroRunHandler({
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
  });
  const result = await handler({
    platform: 'ios',
    timeoutMs: 20,
    inlineYaml: 'appId: com.example.app\n---\n- launchApp: null\n- tapOn:\n    id: submit\n',
    relaunchManagedApp: async () => {
      throw new Error('reconnect required');
    },
    reproveManagedOrigin: async ({ signal } = {}) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        if (signal?.aborted) {
          clearTimeout(timer);
          reject(new Error('RUNNER_TIMEOUT: reconnect cancelled'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('RUNNER_TIMEOUT: reconnect cancelled'));
          },
          { once: true },
        );
      }),
    completeNativeOrigin: async () => {},
    claimNativeOrigin: async () => {},
    completeRunnerPark: async () => {},
  });
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'RUNNER_TIMEOUT');
  assert.ok(Date.now() - started < 3000);
});

test('React-only learned replay preflights action format before mutation', async () => {
  let mutations = 0;
  const handler = createMaestroRunHandler({
    replayDeps: () => ({
      pressByTestId: async () => mutations++,
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    resolveEngineStatus: async () => buildReplayEngineStatus('not-installed', null, false),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      inlineYaml: `appId: com.example.app
---
- tapOn:
    id: submit
`,
      actionMetadata: { id: 'saved-login', tags: ['auth'] },
      ...callbacks,
    }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'ENGINE_PIN_MISMATCH');
  assert.match(env.error ?? '', /migrated to maestro-runner/);
  assert.equal(mutations, 0);
});

test('React-only learned replay ignores native runtime pin drift', async () => {
  let mutations = 0;
  const handler = createMaestroRunHandler({
    replayDeps: () => ({
      pressByTestId: async () => mutations++,
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    resolveEngineStatus: async () => buildReplayEngineStatus('not-installed', null, false),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      inlineYaml: `appId: com.example.app
---
- tapOn:
    id: submit
`,
      actionMetadata: {
        id: 'saved-submit',
        enginePin: `maestro-runner@${MAESTRO_RUNNER_PIN.version}`,
        tags: ['action'],
      },
      ...callbacks,
    }),
  );
  assert.equal(env.ok, true);
  assert.equal(mutations, 1);
});

test('mounted hidden extendedWaitUntil target is an assertion failure, not absence', async () => {
  const replay = await runCdpReplayCommands(
    [{ extendedWaitUntil: { visible: { id: 'clipped' }, timeout: 0 } }],
    {},
    {
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () => ({ testID: 'clipped' }),
      frontmostFor: async () => ({ visible: false, reason: 'target is clipped' }),
      launchApp: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'ASSERTION_FAILED');
  assert.match(replay.reason ?? '', /clipped/);
});

test('ordinary missing React testID stays TESTID_NOT_FOUND without WDA', async () => {
  const handler = createMaestroRunHandler({
    chooseDispatch: () => {
      throw new Error('WDA dispatch must not be selected');
    },
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () => null,
      frontmostFor: async () => ({ visible: false }),
      launchApp: async () => {},
      settle: async () => {},
    }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      inlineYaml: `appId: com.example.app
---
- assertVisible:
    id: genuinely-missing
`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'TESTID_NOT_FOUND');
  assert.match(env.error ?? '', /React-tree replay failed/);
});

test('React stage failures retain completed tap and launch evidence', async () => {
  const calls: string[] = [];
  let relaunches = 0;
  const handler = createMaestroRunHandler({
    replayDeps: () => ({
      pressByTestId: async (id) => calls.push(`press:${id}`),
      typeByTestId: async () => {},
      treeFor: async (id) => (id === 'missing' ? { tree: {} } : { testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => calls.push('launch'),
      settle: async () => {},
    }),
  });
  const result = await handler({
    platform: 'ios',
    inlineYaml: `appId: com.example.app
---
- launchApp: null
- tapOn:
    id: continue
- launchApp: null
- assertVisible:
    id: missing
`,
    claimNativeOrigin: async () => {},
    completeNativeOrigin: async () => {},
    relaunchManagedApp: async () => {
      relaunches++;
    },
    reproveManagedOrigin: async () => {},
    completeRunnerPark: async () => {},
  });
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.match(env.error ?? '', /testID "missing" not present/);
  assert.equal(relaunches, 2);
  assert.deepEqual(calls, ['press:continue']);
  assert.deepEqual(
    env.meta?.steps?.map((step: { name: string }) => step.name),
    ['launch', 'tap', 'launch', 'assert'],
  );
});

test('login replay refuses before mutation without a final positive ID', async () => {
  let mutations = 0;
  const handler = createMaestroRunHandler({
    replayDeps: () => ({
      pressByTestId: async () => mutations++,
      typeByTestId: async () => mutations++,
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      inlineYaml: `appId: com.example.app
---
- tapOn:
    id: submit
`,
      actionMetadata: { id: 'login-en', tags: ['auth'], enginePin: 'maestro-runner@1.1.24' },
      ...callbacks,
    }),
  );
  assert.equal(env.code, 'ASSERTION_FAILED');
  assert.equal(mutations, 0);
});

test('the real login shape partitions native prefix from exact React suffix', () => {
  const commands = [
    { launchApp: { clearState: true, stopApp: true } },
    { runFlow: { when: { visible: 'Open in' }, commands: [{ tapOn: 'Cancel' }] } },
    { extendedWaitUntil: { visible: { id: 'direct_login_button' }, timeout: 90_000 } },
    { tapOn: { id: 'direct_login_button' } },
    { assertVisible: { id: 'MainTabNavigatorCoverageTab' } },
  ];
  const plan = planIosProofDomains(commands, {});
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(
    plan.segments.map(({ domain, sourceIndices }) => ({ domain, sourceIndices })),
    [
      { domain: 'xctest-native', sourceIndices: [0, 1] },
      { domain: 'react-tree', sourceIndices: [2, 3, 4] },
    ],
  );
});

test('exact-ID commands with unimplemented selector fields refuse React routing', () => {
  for (const command of [
    { assertVisible: { id: 'row', text: 'Paid' } },
    { tapOn: { id: 'row', retryTapIfNoChange: true } },
    { extendedWaitUntil: { visible: { id: 'row', text: 'Paid' }, timeout: 1000 } },
  ]) {
    const plan = planIosProofDomains([command], {});
    assert.equal(plan.ok, false);
    assert.throws(() => normalizeSteps([command], {}), UnsupportedStepError);
  }
});

test('inputText inherits the preceding selector proof domain', () => {
  const native = planIosProofDomains([{ tapOn: 'Email' }, { inputText: 'person@example.com' }], {});
  assert.equal(native.ok, true);
  if (native.ok)
    assert.deepEqual(
      native.segments.map((segment) => segment.domain),
      ['xctest-native'],
    );

  const react = planIosProofDomains(
    [{ tapOn: { id: 'email' } }, { inputText: 'person@example.com' }],
    {},
  );
  assert.equal(react.ok, true);
  if (react.ok)
    assert.deepEqual(
      react.segments.map((segment) => segment.domain),
      ['react-tree'],
    );
});

test('inputText keeps the focused selector domain across an intervening proof segment', () => {
  const nativeFocus = planIosProofDomains(
    [
      { tapOn: 'Email' },
      { assertVisible: { id: 'react-status' } },
      { inputText: 'person@example.com' },
    ],
    {},
  );
  assert.equal(nativeFocus.ok, true);
  if (nativeFocus.ok)
    assert.deepEqual(
      nativeFocus.segments.map(({ domain, sourceIndices }) => ({ domain, sourceIndices })),
      [
        { domain: 'xctest-native', sourceIndices: [0] },
        { domain: 'react-tree', sourceIndices: [1] },
        { domain: 'xctest-native', sourceIndices: [2] },
      ],
    );

  const reactFocus = planIosProofDomains(
    [
      { tapOn: { id: 'email' } },
      { assertVisible: 'Native status' },
      { inputText: 'person@example.com' },
    ],
    {},
  );
  assert.equal(reactFocus.ok, true);
  if (reactFocus.ok) {
    assert.deepEqual(
      reactFocus.segments.map(({ domain, sourceIndices }) => ({ domain, sourceIndices })),
      [
        { domain: 'react-tree', sourceIndices: [0] },
        { domain: 'xctest-native', sourceIndices: [1] },
        { domain: 'react-tree', sourceIndices: [2] },
      ],
    );
    assert.equal(reactFocus.segments[2]?.initialReactFocusId, 'email');
  }
});

test('inputText without a proven React focus remains in the native domain', () => {
  const plan = planIosProofDomains(
    [{ inputText: 'autofocused value' }, { assertVisible: { id: 'react-status' } }],
    {},
  );
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(
    plan.segments.map(({ domain, sourceIndices }) => ({ domain, sourceIndices })),
    [
      { domain: 'xctest-native', sourceIndices: [0] },
      { domain: 'react-tree', sourceIndices: [1] },
    ],
  );
});

test('nested leading inputText preserves native auto-focus without a proven React focus', () => {
  const plan = planIosProofDomains(
    [
      {
        runFlow: {
          when: { visible: { id: 'condition' } },
          commands: [{ inputText: 'autofocused value' }],
        },
      },
    ],
    {},
  );
  assert.equal(plan.ok, true);
  if (plan.ok)
    assert.deepEqual(
      plan.segments.map(({ domain }) => domain),
      ['xctest-native'],
    );
});

test('nested waits before inputText remain native without a React focus anchor', () => {
  for (const leading of [
    [{ waitForAnimationToEnd: null }],
    [{ waitForAnimationToEnd: null }, { waitForAnimationToEnd: null }],
  ]) {
    const plan = planIosProofDomains(
      [
        {
          runFlow: {
            when: { visible: { id: 'condition' } },
            commands: [...leading, { inputText: 'value' }],
          },
        },
      ],
      {},
    );
    assert.equal(plan.ok, true);
    if (plan.ok)
      assert.deepEqual(
        plan.segments.map(({ domain }) => domain),
        ['xctest-native'],
      );
  }
});

test('nested leading inputText stays React-eligible after a proven focus tap', () => {
  const plan = planIosProofDomains(
    [
      { tapOn: { id: 'field' } },
      {
        runFlow: {
          when: { visible: { id: 'condition' } },
          commands: [{ inputText: 'focused value' }],
        },
      },
    ],
    {},
  );
  assert.equal(plan.ok, true);
  if (plan.ok)
    assert.deepEqual(
      plan.segments.map(({ domain }) => domain),
      ['react-tree'],
    );
});

test('nested leading inputText preserves native focus after a native tap', () => {
  const plan = planIosProofDomains(
    [
      { tapOn: 'Email' },
      {
        runFlow: {
          when: { visible: { id: 'condition' } },
          commands: [{ inputText: 'focused value' }],
        },
      },
    ],
    {},
  );
  assert.equal(plan.ok, true);
  if (plan.ok)
    assert.deepEqual(
      plan.segments.map(({ domain }) => domain),
      ['xctest-native'],
    );
});

test('conditional React subflows preserve focus in both directions', async () => {
  const calls: string[] = [];
  const result = await replayFlow(
    [
      { t: 'tap', id: 'outer-field' },
      {
        t: 'runFlow',
        whenVisible: 'first-condition',
        commands: [{ t: 'type', text: 'from-outer' }],
      },
      {
        t: 'runFlow',
        whenVisible: 'second-condition',
        commands: [{ t: 'tap', id: 'inner-field' }],
      },
      { t: 'type', text: 'from-inner' },
    ],
    {
      press: async (id) => calls.push(`press:${id}`),
      type: async (id, text) => calls.push(`type:${id}:${text}`),
      visibility: async () => ({ visible: true }),
      launch: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(result.passed, true);
  assert.equal(result.finalFocusId, 'inner-field');
  assert.deepEqual(calls, [
    'press:outer-field',
    'type:outer-field:from-outer',
    'press:inner-field',
    'type:inner-field:from-inner',
  ]);
});

test('partitioned replay carries nested React focus across a native segment', async () => {
  const calls: string[] = [];
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'nested-focus-across-native',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async (id) => calls.push(`press:${id}`),
      typeByTestId: async (id) => calls.push(`type:${id}`),
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => ({ stdout: nativeRunnerOutput(), stderr: '' }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app
---
- tapOn:
    id: outer-field
- runFlow:
    when:
      visible:
        id: nested-form
    commands:
      - tapOn:
          id: inner-field
- assertVisible: Native status
- inputText: value
- assertVisible:
    id: finished
`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, true);
  assert.equal(env.data?.proofDomain, 'partitioned');
  assert.deepEqual(calls, ['press:outer-field', 'press:inner-field', 'type:inner-field']);
});

test('inputText follows a nested native tap instead of reviving stale React focus', () => {
  const plan = planIosProofDomains(
    [
      { tapOn: { id: 'react-field' } },
      {
        runFlow: {
          when: { visible: 'Native form' },
          commands: [{ tapOn: 'Native field' }],
        },
      },
      { inputText: 'value' },
    ],
    {},
  );
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(
    plan.segments.map(({ domain, sourceIndices }) => ({ domain, sourceIndices })),
    [
      { domain: 'react-tree', sourceIndices: [0] },
      { domain: 'xctest-native', sourceIndices: [1, 2] },
    ],
  );
});

test('inputText does not retain React authority after a native coordinate tap', () => {
  for (const nativeCommand of [
    { tap: { point: '50%,50%' } },
    { doubleTapOn: 'Native field' },
    { back: true },
    { swipe: { direction: 'LEFT' } },
  ]) {
    const plan = planIosProofDomains(
      [{ tapOn: { id: 'react-field' } }, nativeCommand, { inputText: 'value' }],
      {},
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) continue;
    assert.deepEqual(
      plan.segments.map(({ domain, sourceIndices }) => ({ domain, sourceIndices })),
      [
        { domain: 'react-tree', sourceIndices: [0] },
        { domain: 'xctest-native', sourceIndices: [1, 2] },
      ],
    );
  }
});

test('negative native assertions cannot prove blindness', () => {
  assert.deepEqual(
    nativeSelectorsForCommands([
      { assertNotVisible: 'Gone' },
      { extendedWaitUntil: { notVisible: { text: 'Also gone' }, timeout: 1000 } },
    ]),
    [],
  );
  assert.deepEqual(nativeSelectorsForCommands([{ assertVisible: { text: 'Present' } }]), [
    { kind: 'text', value: 'Present' },
  ]);
  assert.deepEqual(
    nativeSelectorsForCommands([{ assertVisible: { text: 'Present', index: 1 } }]),
    [],
  );
  assert.deepEqual(
    nativeSelectorsForCommands([
      { assertVisible: 'Present' },
      { assertVisible: { text: 'Present', index: 1 } },
    ]),
    [],
  );
  assert.deepEqual(soleComparableNativeSelectorForCommands([{ assertVisible: 'Present' }]), {
    kind: 'text',
    value: 'Present',
  });
  assert.equal(
    soleComparableNativeSelectorForCommands([
      { assertVisible: 'Present' },
      { assertVisible: { text: 'Hidden', index: 1 } },
    ]),
    null,
  );
  assert.equal(
    soleComparableNativeSelectorForCommands([
      { assertVisible: 'Present' },
      { assertVisible: { label: 'Hidden' } },
    ]),
    null,
  );
});

test('hidden or offscreen native nodes cannot prove blindness', () => {
  const selectors = [{ kind: 'text' as const, value: 'Present' }];
  assert.deepEqual(
    selectorsVisibleInNativeSnapshot(selectors, [
      { label: 'Present', hittable: false },
      { identifier: 'Present' },
    ]),
    [],
  );
  assert.deepEqual(
    selectorsVisibleInNativeSnapshot(selectors, [{ label: 'Present', hittable: true }]),
    selectors,
  );
});

test('controlled input appends and succeeds only after exact fiber read-back', async () => {
  let value = '04';
  const client = {
    evaluate: async (expression: string) => {
      if (expression.includes('__RN_AGENT.interact')) {
        const options = JSON.parse(expression.slice(expression.indexOf('(') + 1, -1));
        const before = value;
        value = options.text;
        return {
          value: JSON.stringify({
            controlled: true,
            handlerCalled: 'onChangeText',
            valueBefore: before,
          }),
        };
      }
      return { value: JSON.stringify({ value, controlled: true }) };
    },
  };
  const env = envelope(await performReactTreeInput('otp', '5', client as never));
  assert.equal(env.ok, true);
  assert.equal(value, '045');
  assert.equal(env.data?.filled, true);
  assert.equal(JSON.stringify(env).includes('045'), false, 'result must not echo entered text');
});

test('uncontrolled or secure-masked-only input refuses without mutation', async () => {
  let interacted = false;
  const client = {
    evaluate: async (expression: string) => {
      if (expression.includes('__RN_AGENT.interact')) interacted = true;
      return { value: JSON.stringify({ value: null, controlled: false }) };
    },
  };
  const env = envelope(await performReactTreeInput('password', 'secret', client as never));
  assert.equal(env.code, 'TEXT_ENTRY_UNVERIFIED');
  assert.equal(interacted, false);
  assert.equal(JSON.stringify(env).includes('secret'), false);
});

function makeFrontmostSandbox(root: any, navState: Record<string, unknown>) {
  const sandbox: Record<string, any> = {
    Array,
    Object,
    JSON,
    Map,
    WeakSet,
    Set,
    Error,
    Date,
    RegExp,
    Symbol,
    String,
    Number,
    Boolean,
    Promise,
    setTimeout,
    clearTimeout,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    __expo_router_state__: navState,
  };
  sandbox.globalThis = sandbox;
  const roots = Array.isArray(root) ? root : [root];
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: (id: number) =>
      id === 1 ? new Set(roots.map((current) => ({ current }))) : new Set(),
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox;
}

const viewportRect = { x: 0, y: 0, width: 390, height: 844 };

interface LayoutBoundsInstance {
  getBoundingClientRect(): Record<string, number>;
  ownerDocument?: { documentElement: LayoutBoundsInstance };
  parentElement?: LayoutBoundsInstance | null;
}

function layoutStateNode(
  rect: Record<string, number>,
  viewport = viewportRect,
  parentElement: LayoutBoundsInstance | null = null,
) {
  const documentElement: LayoutBoundsInstance = {
    getBoundingClientRect: () => viewport,
  };
  return {
    canonical: {
      publicInstance: {
        ownerDocument: { documentElement },
        parentElement,
        getBoundingClientRect: () => rect,
      },
    },
  };
}

function routeTree(testID: string, route: string) {
  const root: any = {
    type: { displayName: 'Root' },
    memoizedProps: {},
    return: null,
    child: null,
    sibling: null,
  };
  const screen: any = {
    type: { displayName: 'Screen' },
    memoizedProps: { route: { name: route } },
    return: root,
    child: null,
    sibling: null,
  };
  const target: any = {
    type: { displayName: 'View' },
    memoizedProps: { testID },
    stateNode: layoutStateNode({ x: 20, y: 80, width: 120, height: 44 }),
    return: screen,
    child: null,
    sibling: null,
  };
  root.child = screen;
  screen.child = target;
  return root;
}

test('mounted prior-route IDs are not frontmost', () => {
  const sandbox = makeFrontmostSandbox(routeTree('coverage', 'login'), {
    index: 1,
    routes: [{ name: 'login' }, { name: 'home' }],
  });
  const verdict = JSON.parse(sandbox.__RN_AGENT.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, false);
  assert.match(verdict.reason, /inactive mounted route/);
});

test('current-route ID is frontmost', () => {
  const sandbox = makeFrontmostSandbox(routeTree('coverage', 'home'), {
    index: 1,
    routes: [{ name: 'login' }, { name: 'home' }],
  });
  const verdict = JSON.parse(sandbox.__RN_AGENT.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, true);
  assert.equal(verdict.activeRoute, 'home');
});

test('unavailable navigation proof is typed and does not skip runFlow commands', async () => {
  const sandbox = makeFrontmostSandbox(routeTree('coverage', 'home'), {
    error: 'No navigation state',
  });
  const verdict = JSON.parse(sandbox.__RN_AGENT.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, false);
  assert.equal(verdict.code, 'ASSERTION_FAILED');

  let nestedPresses = 0;
  const replay = await replayFlow(
    [
      {
        t: 'runFlow',
        whenVisible: 'coverage',
        commands: [{ t: 'tap', id: 'nested-action' }],
      },
    ],
    {
      press: async () => {
        nestedPresses++;
      },
      type: async () => {},
      visibility: async () => verdict,
      launch: async () => {},
      settle: async () => {},
    },
  );
  assert.equal(replay.passed, false);
  assert.equal(replay.failureCode, 'ASSERTION_FAILED');
  assert.equal(nestedPresses, 0);
});

test('a mounted testID without native layout proof fails closed', () => {
  const root = routeTree('coverage', 'home');
  root.child.child.stateNode = null;
  const sandbox = makeFrontmostSandbox(root, {
    index: 0,
    routes: [{ name: 'home' }],
  });
  const verdict = JSON.parse(sandbox.__RN_AGENT.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, false);
  assert.equal(verdict.code, 'ASSERTION_FAILED');
  assert.match(verdict.reason, /layout visibility cannot be proven/);
});

test('a zero-size mounted testID is not visible', () => {
  const root = routeTree('coverage', 'home');
  root.child.child.stateNode = layoutStateNode({ x: 20, y: 80, width: 0, height: 44 });
  const sandbox = makeFrontmostSandbox(root, {
    index: 0,
    routes: [{ name: 'home' }],
  });
  const verdict = JSON.parse(sandbox.__RN_AGENT.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, false);
  assert.match(verdict.reason, /zero-size/);
});

test('a mounted testID outside the native viewport is not visible', () => {
  const root = routeTree('coverage', 'home');
  root.child.child.stateNode = layoutStateNode({ x: 20, y: 900, width: 120, height: 44 });
  const sandbox = makeFrontmostSandbox(root, {
    index: 0,
    routes: [{ name: 'home' }],
  });
  const verdict = JSON.parse(sandbox.__RN_AGENT.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, false);
  assert.match(verdict.reason, /outside the visible viewport/);
});

test('a mounted testID outside a native ancestor boundary is not visible', () => {
  const root = routeTree('coverage', 'home');
  const nativeAncestor: LayoutBoundsInstance = {
    getBoundingClientRect: () => ({ x: 0, y: 100, width: 390, height: 300 }),
    parentElement: null,
  };
  root.child.child.stateNode = layoutStateNode(
    { x: 20, y: 600, width: 120, height: 44 },
    viewportRect,
    nativeAncestor,
  );
  const sandbox = makeFrontmostSandbox(root, {
    index: 0,
    routes: [{ name: 'home' }],
  });
  const verdict = JSON.parse(sandbox.__RN_AGENT.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, false);
  assert.match(verdict.reason, /outside an ancestor layout boundary/);
});

test('a mounted testID outside its ScrollView viewport is not visible', () => {
  const root = routeTree('coverage', 'home');
  const screen = root.child;
  const target = screen.child;
  const scrollView: any = {
    type: { displayName: 'RCTScrollView' },
    memoizedProps: {},
    stateNode: layoutStateNode({ x: 0, y: 100, width: 390, height: 300 }),
    return: screen,
    child: target,
    sibling: null,
  };
  screen.child = scrollView;
  target.return = scrollView;
  target.stateNode = layoutStateNode({ x: 20, y: 600, width: 120, height: 44 });
  const sandbox = makeFrontmostSandbox(root, {
    index: 0,
    routes: [{ name: 'home' }],
  });
  const verdict = JSON.parse(sandbox.__RN_AGENT.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, false);
  assert.match(verdict.reason, /clipped by an ancestor viewport/);
});

test('a visible testID inside its ScrollView viewport remains frontmost', () => {
  const root = routeTree('coverage', 'home');
  const screen = root.child;
  const target = screen.child;
  const scrollView: any = {
    type: { displayName: 'RCTScrollView' },
    memoizedProps: {},
    stateNode: layoutStateNode({ x: 0, y: 100, width: 390, height: 300 }),
    return: screen,
    child: target,
    sibling: null,
  };
  screen.child = scrollView;
  target.return = scrollView;
  target.stateNode = layoutStateNode({ x: 20, y: 140, width: 120, height: 44 });
  const sandbox = makeFrontmostSandbox(root, {
    index: 0,
    routes: [{ name: 'home' }],
  });
  const verdict = JSON.parse(sandbox.__RN_AGENT.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, true);
});

test('an inactive mounted modal does not mask the current route', () => {
  const root = routeTree('coverage', 'home');
  root.child.sibling = {
    type: { displayName: 'Modal' },
    memoizedProps: { visible: false },
    return: root,
    child: null,
    sibling: null,
  };
  const sandbox = makeFrontmostSandbox(root, {
    index: 0,
    routes: [{ name: 'home' }],
  });
  const verdict = JSON.parse(sandbox.__RN_AGENT.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, true);
  assert.equal(verdict.modalCount, 0);
});

test('stacked visible modal roots fail closed when ordering is unavailable', () => {
  const backgroundModal: any = {
    type: { displayName: 'Modal' },
    memoizedProps: { visible: true },
    return: null,
    child: null,
    sibling: null,
  };
  const target: any = {
    type: { displayName: 'View' },
    memoizedProps: { testID: 'covered-action' },
    return: backgroundModal,
    child: null,
    sibling: null,
  };
  backgroundModal.child = target;
  const foregroundModal = {
    type: { displayName: 'Modal' },
    memoizedProps: { visible: true },
    return: null,
    child: null,
    sibling: null,
  };
  const sandbox = makeFrontmostSandbox([backgroundModal, foregroundModal], {
    index: 0,
    routes: [{ name: 'home' }],
  });

  const verdict = JSON.parse(sandbox.__RN_AGENT.isTestIdFrontmost('covered-action'));
  assert.equal(verdict.visible, false);
  assert.equal(verdict.code, 'ASSERTION_FAILED');
  assert.equal(verdict.modalCount, 2);
});

test('a matching route returned after the replay deadline cannot report success', async () => {
  let clock = 0;
  const handler = createMaestroRunHandler({
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    getLiveRoute: async () => {
      clock = 101;
      return 'home';
    },
    now: () => clock,
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      timeoutMs: 100,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible:\n    id: home\n`,
      actionMetadata: {
        id: 'route-deadline-proof',
        enginePin: 'maestro-runner@1.1.24',
        tags: [],
        expectedRouteSequence: ['home'],
      },
      ...callbacks,
    }),
  );

  assert.equal(env.code, 'RUNNER_TIMEOUT');
  assert.equal(env.meta?.expectedRoute, 'home');
  assert.equal(env.meta?.liveRoute, 'home');
});

test('propagated testIDs on one fiber lineage remain one logical match', () => {
  const root = routeTree('coverage', 'home');
  const propagated = {
    type: { displayName: 'HostView' },
    memoizedProps: { testID: 'coverage' },
    stateNode: layoutStateNode({ x: 20, y: 80, width: 120, height: 44 }),
    return: root.child.child,
    child: null,
    sibling: null,
  };
  root.child.child.child = propagated;
  const sandbox = makeFrontmostSandbox(root, {
    index: 0,
    routes: [{ name: 'home' }],
  });
  const verdict = JSON.parse(sandbox.__RN_AGENT.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, true);
});

test('frontmost scan-budget exhaustion is a typed proof failure', () => {
  const root: any = {
    type: { displayName: 'Root' },
    memoizedProps: {},
    return: null,
    child: null,
    sibling: null,
  };
  let cursor = root;
  for (let index = 0; index < 40_001; index++) {
    const fiber = {
      type: { displayName: 'View' },
      memoizedProps: {},
      return: root,
      child: null,
      sibling: null,
    };
    cursor.sibling = fiber;
    cursor = fiber;
  }
  const sandbox = makeFrontmostSandbox(root, { index: 0, routes: [{ name: 'home' }] });
  const verdict = JSON.parse(sandbox.__RN_AGENT.isTestIdFrontmost('coverage'));
  assert.equal(verdict.visible, false);
  assert.equal(verdict.code, 'ASSERTION_FAILED');
  assert.equal(verdict.truncated, true);
});

const IOS_UDID = 'B5E71CBD-D1F7-46C6-944C-28FF15F773B4';

function nativeDispatch() {
  const dispatch = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => '/usr/bin/adb',
    whichMaestro: () => '/usr/bin/maestro',
    maestroRunnerPath: () => '/fake/maestro-runner',
  });
  if ('error' in dispatch) throw new Error(dispatch.error);
  return dispatch;
}

function nativeRunnerOutput(extra = '') {
  return [
    'Single device execution mode',
    `Using specified iOS device: ${IOS_UDID}`,
    `Building WDA for device ${IOS_UDID} (team ID: )`,
    `Starting WDA on device ${IOS_UDID} (port: 8447)`,
    extra,
  ].join('\n');
}

function nativeHandler(
  visible: boolean | (() => boolean),
  runnerFails: boolean,
  failureOutput = "Element with text 'Open in' not found",
  options: {
    beforeFailure?: () => void;
    failureCode?: string | number;
    stopFastRunner?: () => Promise<void>;
  } = {},
) {
  return createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'native-blind-environment',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => null,
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    stopFastRunner: options.stopFastRunner ?? (async () => {}),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    nativeVisionProbe: async ({ selectors }) => ({
      source: 'rn-fast-runner-snapshot',
      nodeCount: 42,
      visibleSelectors: (typeof visible === 'function' ? visible() : visible) ? selectors : [],
      runtimeMajor: 26,
    }),
    execFile: async () => {
      if (!runnerFails) return { stdout: nativeRunnerOutput(), stderr: '' };
      options.beforeFailure?.();
      throw Object.assign(new Error('native selector failed'), {
        code: options.failureCode ?? 1,
        stdout: nativeRunnerOutput(failureOutput),
        stderr: '',
      });
    },
  });
}

test('native-only blindness requires a WDA miss and same-screen native visibility', async () => {
  let comparisonRunnerStopped = false;
  const env = envelope(
    await nativeHandler(true, true, undefined, {
      stopFastRunner: async () => {
        comparisonRunnerStopped = true;
      },
    })({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Open in\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.code, 'NATIVE_SURFACE_BLIND');
  assert.equal(env.meta?.nativeVision.source, 'rn-fast-runner-snapshot');
  assert.equal(env.meta?.nativeVision.visibleSelectorCount, 1);
  assert.equal(env.meta?.nativeVision.failedSelectorKind, 'text');
  assert.equal(env.meta?.nativeVision.runtimeVersionHeuristicIsProof, false);
  assert.equal(env.meta?.cleanup.cleanupProven, true);
  assert.equal(env.meta?.cleanup.wdaProcessSettled, true);
  assert.equal(comparisonRunnerStopped, true);
  assert.equal(JSON.stringify(env).includes('Open in'), false, 'selector text stays sanitized');
});

test('one failed native assertion can use its sole failure-screen selector without echoing it', async () => {
  const handler = nativeHandler(true, true, '    ✗ assertVisible (0.1s)');
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Modal control\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.code, 'NATIVE_SURFACE_BLIND');
  assert.equal(JSON.stringify(env).includes('Modal control'), false);
});

test('a selector visible only before navigation cannot prove native blindness', async () => {
  let visible = true;
  const env = envelope(
    await nativeHandler(() => visible, true, "Element with text 'Initial control' not found", {
      beforeFailure: () => {
        visible = false;
      },
    })({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- tapOn: Next\n- assertVisible: Initial control\n`,
      ...callbacks,
    }),
  );
  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
});

test('failure-screen comparison cleanup uncertainty overrides native blindness', async () => {
  const env = envelope(
    await nativeHandler(true, true, undefined, {
      stopFastRunner: async () => {
        throw new Error('cleanup unavailable');
      },
    })({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Open in\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.code, 'AUTOMATION_CLEANUP_UNPROVEN');
  assert.equal(env.meta?.cleanup.cleanupProven, false);
});

test('ordinary native selector miss is not called blind', async () => {
  const env = envelope(
    await nativeHandler(
      false,
      true,
    )({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Open in\n`,
      ...callbacks,
    }),
  );
  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
});

test('a constrained native selector miss is not reduced to a blind text comparison', async () => {
  const env = envelope(
    await nativeHandler(
      true,
      true,
      "Element with text 'Repeated' not found",
    )({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app
---
- assertVisible:
    text: Repeated
    index: 1
`,
      ...callbacks,
    }),
  );
  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
});

test('a selector-less constrained failure cannot borrow another visible selector', async () => {
  const env = envelope(
    await nativeHandler(
      true,
      true,
      '    ✗ assertVisible (0.1s)',
    )({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app
---
- assertVisible: Visible
- assertVisible:
    text: Hidden
    index: 1
`,
      ...callbacks,
    }),
  );
  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
});

test('a timed-out selector failure cannot become native blindness', async () => {
  let comparisonProbes = 0;
  const env = envelope(
    await nativeHandler(
      () => {
        comparisonProbes += 1;
        return true;
      },
      true,
      "Element with text 'Visible' not found",
      { failureCode: 'ETIMEDOUT' },
    )({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Visible\n`,
      ...callbacks,
    }),
  );
  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
  assert.equal(env.meta?.timedOut, true);
  assert.equal(comparisonProbes, 0);
});

test('a Maestro-internal selector timeout cannot become native blindness', async () => {
  let comparisonProbes = 0;
  const env = envelope(
    await nativeHandler(
      () => {
        comparisonProbes += 1;
        return true;
      },
      true,
      "Timed out waiting for element 'Visible'",
    )({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Visible\n`,
      ...callbacks,
    }),
  );

  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
  assert.equal(env.meta?.timedOut, true);
  assert.equal(comparisonProbes, 0);
});

test('a deadline reached during the failure-screen probe cannot become native blindness', async () => {
  let clock = 0;
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'native-probe-deadline',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => null,
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    stopFastRunner: async () => {},
    now: () => clock,
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    nativeVisionProbe: async ({ selectors }) => {
      clock = 101;
      return {
        source: 'rn-fast-runner-snapshot',
        nodeCount: 42,
        visibleSelectors: selectors,
        runtimeMajor: 26,
      };
    },
    execFile: async () => {
      throw Object.assign(new Error('native selector failed'), {
        code: 1,
        stdout: nativeRunnerOutput("Element with text 'Visible' not found"),
        stderr: '',
      });
    },
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      timeoutMs: 100,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Visible\n`,
      ...callbacks,
    }),
  );

  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
  assert.equal(env.meta?.timedOut, true);
  assert.equal(env.meta?.terminal.exitClass, 'timed-out');
});

test('a deadline reached during failure-screen cleanup cannot become native blindness', async () => {
  let clock = 0;
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'native-cleanup-deadline',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => null,
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    stopFastRunner: async () => {},
    now: () => clock,
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    nativeVisionProbe: async ({ selectors }) => ({
      source: 'rn-fast-runner-snapshot',
      nodeCount: 42,
      visibleSelectors: selectors,
      runtimeMajor: 26,
    }),
    execFile: async () => {
      throw Object.assign(new Error('native selector failed'), {
        code: 1,
        stdout: nativeRunnerOutput("Element with text 'Visible' not found"),
        stderr: '',
      });
    },
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      timeoutMs: 100,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Visible\n`,
      ...callbacks,
      completeRunnerPark: async () => {
        clock = 101;
      },
    }),
  );

  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
  assert.equal(env.meta?.timedOut, true);
  assert.equal(env.meta?.terminal.exitClass, 'timed-out');
});

test('a deadline reached during runner resume skips the failure-screen probe', async () => {
  let clock = 0;
  let comparisonProbes = 0;
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'runner-resume-deadline',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => null,
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    fastHealthCheck: async () => {
      clock = 101;
      return true;
    },
    now: () => clock,
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    nativeVisionProbe: async ({ selectors }) => {
      comparisonProbes += 1;
      return {
        source: 'rn-fast-runner-snapshot',
        nodeCount: 42,
        visibleSelectors: selectors,
        runtimeMajor: 26,
      };
    },
    execFile: async () => {
      throw Object.assign(new Error('native selector failed'), {
        code: 1,
        stdout: nativeRunnerOutput("Element with text 'Visible' not found"),
        stderr: '',
      });
    },
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      timeoutMs: 100,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Visible\n`,
      ...callbacks,
    }),
  );

  assert.notEqual(env.code, 'NATIVE_SURFACE_BLIND');
  assert.equal(env.meta?.timedOut, true);
  assert.equal(env.meta?.terminal.exitClass, 'timed-out');
  assert.equal(comparisonProbes, 0);
});

test('WDA-visible native smoke still passes in the XCTest domain', async () => {
  const env = envelope(
    await nativeHandler(
      true,
      false,
    )({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Increment\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, true);
  assert.equal(env.data?.proofDomain, 'xctest-native');
});

test('a deadline-triggered runner abort remains a timeout', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'native-deadline',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => null,
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async (_file, _args, options) =>
      new Promise((_resolve, reject) => {
        const abort = () =>
          reject(Object.assign(new Error('runner aborted'), { code: 'ABORT_ERR' }));
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener('abort', abort, { once: true });
      }),
  });

  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      timeoutMs: 30,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Native status\n`,
      ...callbacks,
    }),
  );

  assert.equal(env.ok, false);
  assert.equal(env.meta?.timedOut, true);
  assert.match(env.error ?? '', /timed out/);
});

test('partitioned native trace indices map back to original commands', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partition-index',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => ({
      stdout: nativeRunnerOutput('    ✓ assertVisible (0.1s)'),
      stderr: '',
    }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible:\n    id: react-status\n- assertVisible: Native status\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, true);
  assert.deepEqual(
    env.data?.steps.map((step: { index: number }) => step.index),
    [0, 1],
  );
});

test('partitioned route failures retain native and React proof evidence', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partition-route-failure',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    getLiveRoute: async () => 'unexpected-route',
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => ({
      stdout: nativeRunnerOutput('    ✓ assertVisible (0.1s)'),
      stderr: '',
    }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Native status\n- assertVisible:\n    id: react-status\n`,
      actionMetadata: {
        id: 'partition-route-proof',
        enginePin: 'maestro-runner@1.1.24',
        tags: [],
        expectedRouteSequence: ['expected-route'],
      },
      ...callbacks,
    }),
  );

  assert.equal(env.ok, false);
  assert.equal(env.meta?.proofDomain, 'partitioned');
  assert.deepEqual(env.meta?.proofDomains, ['xctest-native', 'react-tree']);
  assert.equal(env.meta?.runner, 'partitioned');
  assert.equal(env.meta?.transport, 'partitioned');
  assert.deepEqual(
    env.meta?.steps.map((step: { index: number }) => step.index),
    [0, 1],
  );
});

test('partitioned native failures map evidence back to original commands', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partition-failure-index',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => {
      throw Object.assign(new Error('native selector failed'), {
        code: 1,
        stdout: nativeRunnerOutput('    ✗ assertVisible (0.1s)'),
        stderr: '',
      });
    },
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible:\n    id: react-status\n- assertVisible: Native status\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.meta?.proofDomain, 'partitioned');
  assert.equal(env.meta?.runner, 'partitioned');
  assert.deepEqual(
    env.meta?.steps.map((step: { index: number }) => step.index),
    [0, 1],
  );
  assert.equal(env.meta?.failedStep.index, 1);
  assert.equal(env.meta?.lastStep.index, 1);
});

test('partitioned React failures retain prior native proof evidence', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partition-react-failure',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async () => null,
      frontmostFor: async () => ({ visible: false }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => ({
      stdout: nativeRunnerOutput('    ✓ assertVisible (0.1s)'),
      stderr: '',
    }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Native status\n- assertVisible:\n    id: missing-react-status\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'TESTID_NOT_FOUND');
  assert.equal(env.meta?.proofDomain, 'partitioned');
  assert.deepEqual(env.meta?.proofDomains, ['xctest-native', 'react-tree']);
  assert.equal(env.meta?.failedProofDomain, 'react-tree');
  assert.equal(env.meta?.runner, 'partitioned');
  assert.equal(env.meta?.transport, 'partitioned');
  assert.equal(env.meta?.failedStepIndex, 1);
  assert.deepEqual(
    env.meta?.steps.map((step: { index: number; status: string }) => [step.index, step.status]),
    [
      [0, 'pass'],
      [1, 'fail'],
    ],
  );
});

test('partitioned React setup failures retain prior native proof evidence', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partition-react-setup-failure',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => null,
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => ({
      stdout: nativeRunnerOutput('    ✓ assertVisible (0.1s)'),
      stderr: '',
    }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Native status\n- assertVisible:\n    id: react-status\n`,
      ...callbacks,
    }),
  );

  assert.equal(env.ok, false);
  assert.equal(env.code, 'CDP_NOT_CONNECTED');
  assert.equal(env.meta?.proofDomain, 'partitioned');
  assert.deepEqual(env.meta?.proofDomains, ['xctest-native', 'react-tree']);
  assert.equal(env.meta?.failedProofDomain, 'react-tree');
  assert.equal(env.meta?.runner, 'partitioned');
  assert.equal(env.meta?.transport, 'partitioned');
  assert.equal(env.meta?.failedStepIndex, 1);
  assert.deepEqual(
    env.meta?.steps.map((step: { index: number; status: string }) => [step.index, step.status]),
    [[0, 'pass']],
  );
});

test('partitioned warning failures retain native data evidence', async () => {
  const handler = createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'partition-native-warning',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    replayDeps: () => ({
      pressByTestId: async () => {},
      typeByTestId: async () => {},
      treeFor: async (id) => ({ testID: id }),
      frontmostFor: async () => ({ visible: true }),
      launchApp: async () => {},
      settle: async () => {},
    }),
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => run(),
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => ({
      stdout: nativeRunnerOutput('    ✗ assertVisible (0.1s)\nTest FAILED'),
      stderr: '',
    }),
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible:\n    id: react-status\n- assertVisible: Native status\n`,
      ...callbacks,
    }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.meta?.proofDomain, 'partitioned');
  assert.deepEqual(
    env.meta?.steps.map((step: { index: number; status: string }) => [step.index, step.status]),
    [
      [0, 'pass'],
      [1, 'fail'],
    ],
  );
  assert.equal(env.meta?.failedStep.index, 1);
  assert.equal(env.meta?.lastStep.index, 1);
});

test('native origin is claimed before runner parking and completed after resume', async () => {
  const events: string[] = [];
  const handler = createMaestroRunHandler({
    replayDeps: () => null,
    getActiveSession: () => ({
      name: 'native-order',
      platform: 'ios',
      deviceId: IOS_UDID,
      appId: 'com.example.app',
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => nativeDispatch(),
    parkFlow: async (run) => {
      events.push('park');
      try {
        return await run();
      } finally {
        events.push('resume');
      }
    },
    resolveEngineStatus: async () =>
      buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
    execFile: async () => {
      events.push('execute');
      return { stdout: nativeRunnerOutput(), stderr: '' };
    },
  });
  const env = envelope(
    await handler({
      platform: 'ios',
      deviceId: IOS_UDID,
      inlineYaml: `appId: com.example.app\n---\n- assertVisible: Increment\n`,
      claimNativeOrigin: async () => events.push('claim'),
      completeNativeOrigin: async (targetExpected) => events.push(`complete:${targetExpected}`),
      relaunchManagedApp: async () => {},
      reproveManagedOrigin: async () => events.push('reprove'),
      completeRunnerPark: async () => {},
    }),
  );
  assert.equal(env.ok, true);
  assert.deepEqual(events, ['claim', 'park', 'execute', 'resume', 'reprove', 'complete:true']);
});

test('parking forwards the replay deadline signal', async () => {
  const controller = new AbortController();
  controller.abort(new Error('deadline'));
  const seen: AbortSignal[] = [];
  await runFlowParked(async () => 'done', {
    platform: 'ios',
    signal: controller.signal,
    stopFastRunner: async (_deviceId, signal) => seen.push(signal!),
    completeRunnerPark: async (signal) => seen.push(signal!),
    markCdpStale: () => {},
  });
  assert.deepEqual(seen, [controller.signal, controller.signal]);
});

test('an expired deadline skips grace and still settles runner cleanup', async () => {
  const controller = new AbortController();
  controller.abort(new Error('deadline'));
  const signals: string[] = [];
  let probes = 0;
  let killSettled = false;
  let cleared = false;
  await reapStaleFastRunner({
    signal: controller.signal,
    getState: () => ({
      pid: 123,
      port: 456,
      deviceId: IOS_UDID,
      processBirth: 'birth',
      instanceId: 'instance',
    }),
    probeProcessBirth: () => {
      probes += 1;
      return probes < 3 || !killSettled
        ? { status: 'present', birth: { pid: 123, token: 'birth' } }
        : { status: 'absent' };
    },
    sendSignal: (_pid, signal) => signals.push(signal),
    sleep: async (ms) => {
      if (ms === 50) killSettled = true;
      else await new Promise<void>(() => {});
    },
    clearState: () => {
      cleared = true;
    },
  });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(cleared, true);
});
