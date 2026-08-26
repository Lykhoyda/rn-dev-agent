import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  classifyForegroundSurface,
  createForegroundSurfaceProbe,
  foregroundSurfaceFromSnapshot,
  hideExpoDevMenu,
  HIDE_EXPO_DEV_MENU_EXPRESSION,
  RESOLVE_EXPO_DEV_MENU,
} from '../../dist/tools/expo-dev-menu.js';
import {
  _setActiveSessionForTest,
  _setRunAgentDeviceForTest,
  getActiveSession,
  runNative,
} from '../../dist/agent-device-wrapper.js';
import { CDPClient } from '../../dist/cdp-client.js';
import { CDPProtocolError, handleMessage } from '../../dist/cdp/transport.js';
import { planeForTool } from '../../dist/lifecycle/device-arbiter.js';
import { authorityProfileFor } from '../../dist/session/tool-profiles.js';
import { createDevSettingsHandler } from '../../dist/tools/dev-settings.js';
import {
  attachForegroundSurfaceDiscovery,
  createDeviceSnapshotHandler,
} from '../../dist/tools/device-session.js';
import { createReloadHandler } from '../../dist/tools/reload.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk, parseEnvelope } from '../helpers/result-helpers.js';

function surfaceProbe(...surfaces) {
  let index = 0;
  return async () => surfaces[Math.min(index++, surfaces.length - 1)];
}

function snapshotEnvelope(nodes) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: true, data: { nodes } }),
      },
    ],
  };
}

function normalAndroidSystemChrome() {
  return [
    {
      type: 'android.widget.FrameLayout',
      identifier: 'status_bar',
      packageName: 'com.android.systemui',
    },
    {
      label: '12:31',
      type: 'android.widget.TextView',
      identifier: 'clock',
      packageName: 'com.android.systemui',
    },
    {
      label: 'Battery charging, 100 percent.',
      type: 'android.widget.LinearLayout',
      identifier: 'battery',
      packageName: 'com.android.systemui',
    },
    {
      type: 'android.widget.FrameLayout',
      identifier: 'navigation_bar_frame',
      packageName: 'com.android.systemui',
    },
  ];
}

function hideEval(platform, ...values) {
  let index = 0;
  const calls = [];
  const client = createMockClient({
    _connectedTarget: {
      id: 'page1',
      title: 'React Native (Hermes)',
      vm: 'Hermes',
      webSocketDebuggerUrl: 'ws://127.0.0.1:8081/debugger/page1',
      platform,
    },
    evaluate: async (expression, awaitPromise, timeoutMs) => {
      if (expression.includes('__RN_AGENT')) return { value: 40 };
      if (expression.includes('__DEV__')) return { value: true };
      calls.push({ expression, awaitPromise, timeoutMs });
      const value = values[Math.min(index++, values.length - 1)];
      if (value && typeof value === 'object' && 'throw' in value) {
        throw new Error(value.throw);
      }
      return value;
    },
  });
  return { client, calls };
}

function handlerFor(platform, surfaces, values) {
  const { client, calls } = hideEval(platform, ...values);
  return {
    calls,
    handler: createDevSettingsHandler(() => client, {
      probeForegroundSurface: surfaceProbe(...surfaces),
      settleAfterHide: async () => {},
    }),
  };
}

test('foreground classifier keeps Expo sheet, picker, tutorial, RN core menu, and app distinct', () => {
  assert.equal(
    classifyForegroundSurface([
      { label: 'Toggle performance monitor' },
      { label: 'Toggle element inspector' },
    ]),
    'unknown',
  );
  assert.equal(classifyForegroundSurface([{ label: 'Development servers' }]), 'dev_client_picker');
  assert.equal(
    classifyForegroundSurface([{ label: 'This is the developer menu. It gives you access.' }]),
    'first_run_tutorial',
  );
  assert.equal(classifyForegroundSurface([{ label: 'Open Debugger' }]), 'react_native_dev_menu');
  assert.equal(
    classifyForegroundSurface(
      [
        { label: 'React Native Dev Menu', packageName: 'com.example.app' },
        { label: 'Open DevTools', packageName: 'com.example.app' },
        { label: 'Change Bundle Location', packageName: 'com.example.app' },
        ...normalAndroidSystemChrome(),
      ],
      'com.example.app',
    ),
    'react_native_dev_menu',
  );
  assert.equal(
    classifyForegroundSurface([{ label: 'Home', type: 'Application' }], 'com.example.app'),
    'app',
  );
  assert.equal(
    classifyForegroundSurface(
      [{ label: 'Home', packageName: 'com.example.app' }],
      'com.example.app',
    ),
    'app',
  );
  assert.equal(
    classifyForegroundSurface(
      [
        {
          label: '',
          identifier: '',
          type: 'android.widget.FrameLayout',
          packageName: 'com.example.app',
        },
      ],
      'com.example.app',
    ),
    'app',
  );
  assert.equal(
    classifyForegroundSurface(
      [
        {
          label: '',
          identifier: '',
          type: 'android.widget.FrameLayout',
          packageName: 'com.example.app',
        },
        {
          label: '',
          identifier: '',
          type: 'android.widget.FrameLayout',
          packageName: 'com.android.permissioncontroller',
        },
      ],
      'com.example.app',
    ),
    'unknown',
  );
  assert.equal(
    classifyForegroundSurface(
      [{ label: 'Home', packageName: 'com.example.app' }, ...normalAndroidSystemChrome()],
      'com.example.app',
    ),
    'app',
  );
  assert.equal(classifyForegroundSurface([{ label: 'Home' }], 'com.example.app'), 'unknown');
  assert.equal(
    classifyForegroundSurface(
      [{ label: 'Allow camera access', packageName: 'com.android.permissioncontroller' }],
      'com.example.app',
    ),
    'unknown',
  );
  assert.equal(
    classifyForegroundSurface(
      [
        { label: 'Home', packageName: 'com.example.app' },
        ...normalAndroidSystemChrome(),
        {
          label: 'Internet',
          type: 'android.widget.TextView',
          identifier: 'quick_settings_panel',
          packageName: 'com.android.systemui',
        },
      ],
      'com.example.app',
    ),
    'unknown',
  );
  assert.equal(
    classifyForegroundSurface(
      [
        { label: 'Home', packageName: 'com.example.app' },
        {
          label: 'Back',
          type: 'android.widget.ImageView',
          identifier: 'back',
          packageName: 'com.android.systemui',
        },
      ],
      'com.example.app',
    ),
    'app',
  );
  assert.equal(
    classifyForegroundSurface(
      [
        { label: 'Home', packageName: 'com.example.app' },
        {
          label: 'While using the app',
          type: 'android.widget.Button',
          packageName: 'com.android.permissioncontroller',
        },
      ],
      'com.example.app',
    ),
    'unknown',
  );
  assert.equal(
    classifyForegroundSurface(
      [
        { label: 'Home', packageName: 'com.example.app' },
        {
          label: 'No notifications',
          type: 'android.widget.TextView',
          packageName: 'com.android.systemui',
        },
      ],
      'com.example.app',
    ),
    'unknown',
  );
  assert.equal(
    classifyForegroundSurface(
      [
        { label: 'Home', packageName: 'com.example.app' },
        {
          label: 'Home screen',
          type: 'android.widget.FrameLayout',
          packageName: 'com.google.android.apps.nexuslauncher',
        },
      ],
      'com.example.app',
    ),
    'unknown',
  );
  assert.equal(
    classifyForegroundSurface(
      [
        { label: 'Fixture', type: 'Application' },
        { label: 'Allow', type: 'Alert' },
      ],
      'com.example.app',
    ),
    'unknown',
  );
  assert.equal(classifyForegroundSurface([]), 'unknown');
});

test('foreground classifier treats tutorial copy inside the Expo Developer Menu as menu content', () => {
  assert.equal(
    classifyForegroundSurface([
      { label: 'This is the developer menu. It gives you access.' },
      { label: 'Reload' },
      { label: 'Go home' },
      { label: 'Toggle performance monitor' },
      { label: 'Toggle element inspector' },
      { label: 'Open DevTools' },
      { label: 'Copy system info' },
      { label: 'Open React Native dev menu' },
    ]),
    'expo_dev_menu',
  );
});

test('React Native core menu markers win when generic Expo toggle labels overlap', () => {
  assert.equal(
    classifyForegroundSurface([
      { label: 'React Native Dev Menu' },
      { label: 'Open Debugger' },
      { label: 'Toggle performance monitor' },
      { label: 'Toggle element inspector' },
    ]),
    'react_native_dev_menu',
  );
});

test('generic toggle overlap never exposes the Expo remedy without Expo-specific evidence', () => {
  const envelope = parseEnvelope(
    attachForegroundSurfaceDiscovery(
      snapshotEnvelope([
        { label: 'Toggle performance monitor' },
        { label: 'Toggle element inspector' },
      ]),
      'com.example.app',
      true,
    ),
  );

  assert.equal(envelope.meta.foregroundSurface, 'unknown');
  assert.equal(envelope.meta.recommendation, undefined);
});

test('foregroundSurfaceFromSnapshot classifies a typed native snapshot envelope', () => {
  const result = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          data: { nodes: [{ label: 'Copy system info' }, { label: 'Open DevTools' }] },
        }),
      },
    ],
  };
  assert.equal(foregroundSurfaceFromSnapshot(result), 'expo_dev_menu');
});

test('device_snapshot exposes the exact safe remedy when it detects the Expo Developer Menu', async () => {
  _setActiveSessionForTest({
    name: 'remedy-discovery',
    platform: 'ios',
    deviceId: 'TEST-UDID',
    appId: 'com.example.app',
    openedAt: 'now',
  });
  _setRunAgentDeviceForTest(async () =>
    snapshotEnvelope([
      { label: 'This is the developer menu. It gives you access.' },
      { label: 'Toggle performance monitor' },
      { label: 'Toggle element inspector' },
      { label: 'Copy system info' },
      { label: 'Open DevTools' },
    ]),
  );

  try {
    const handler = createDeviceSnapshotHandler({
      remedyAuthorityAvailable: () => true,
    });
    const envelope = parseEnvelope(await handler({ action: 'snapshot' }));

    assert.equal(envelope.meta.foregroundSurface, 'expo_dev_menu');
    assert.deepEqual(envelope.meta.recommendation, {
      condition: 'expo_dev_menu',
      tool: 'cdp_dev_settings',
      arguments: { action: 'hideDevMenu' },
      guidance:
        'Expo Developer Menu detected. Call cdp_dev_settings({ action: "hideDevMenu" }), then take a fresh device_snapshot and require the app surface before navigation.',
    });
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});

test('hideDevMenu executes for the real Expo menu shape that includes tutorial copy', async () => {
  const appId = 'com.example.app';
  const snapshots = [
    [
      { label: 'This is the developer menu. It gives you access.', packageName: appId },
      { label: 'Toggle performance monitor', packageName: appId },
      { label: 'Toggle element inspector', packageName: appId },
      { label: 'Copy system info', packageName: appId },
      { label: 'Open DevTools', packageName: appId },
    ],
    [{ label: 'Home', packageName: appId }],
  ];
  let probeIndex = 0;
  const probeForegroundSurface = async () =>
    foregroundSurfaceFromSnapshot(
      snapshotEnvelope(snapshots[Math.min(probeIndex++, snapshots.length - 1)]),
      appId,
    );
  const { client, calls } = hideEval('ios', { value: 'ok:hideMenu' }, { value: 'ok:hideMenu' });
  const handler = createDevSettingsHandler(() => client, {
    probeForegroundSurface,
    settleAfterHide: async () => {},
  });

  const data = expectOk(await handler({ action: 'hideDevMenu' }));
  assert.equal(data.outcome, 'hidden');
  assert.equal(data.surface, 'app');
  assert.equal(calls.length, 2);
});

test('foreground discovery does not recommend the Expo remedy for distinct or uncertain surfaces', () => {
  const appId = 'com.example.app';
  const cases = [
    {
      name: 'React Native core menu',
      expectedSurface: 'react_native_dev_menu',
      nodes: [
        { label: 'React Native Dev Menu', packageName: appId },
        { label: 'Open DevTools', packageName: appId },
        { label: 'Change Bundle Location', packageName: appId },
        ...normalAndroidSystemChrome(),
      ],
    },
    {
      name: 'unknown surface',
      expectedSurface: 'unknown',
      nodes: [{ label: 'Unrecognized surface' }],
    },
    {
      name: 'native alert above Expo signatures',
      expectedSurface: 'unknown',
      nodes: [
        { label: 'Copy system info', packageName: appId },
        { label: 'Open DevTools', packageName: appId },
        { label: 'Allow Camera', type: 'Alert', packageName: appId },
      ],
    },
    {
      name: 'Dev Client picker',
      expectedSurface: 'dev_client_picker',
      nodes: [{ label: 'Development servers', packageName: appId }],
    },
    {
      name: 'Expo first-run tutorial',
      expectedSurface: 'first_run_tutorial',
      nodes: [
        {
          label: 'This is the developer menu. It gives you access.',
          packageName: appId,
        },
      ],
    },
    {
      name: 'app-owned native overlay',
      expectedSurface: 'app',
      nodes: [{ label: 'Choose a profile', packageName: appId }],
    },
  ];

  for (const fixture of cases) {
    const envelope = parseEnvelope(
      attachForegroundSurfaceDiscovery(snapshotEnvelope(fixture.nodes), appId, true),
    );
    assert.equal(envelope.meta.foregroundSurface, fixture.expectedSurface, fixture.name);
    assert.equal(envelope.meta.recommendation, undefined, fixture.name);
  }
});

test('foreground discovery withholds the Expo remedy when its authority is unavailable', () => {
  const envelope = parseEnvelope(
    attachForegroundSurfaceDiscovery(
      snapshotEnvelope([{ label: 'Copy system info' }, { label: 'Open DevTools' }]),
      'com.example.app',
      false,
    ),
  );

  assert.equal(envelope.meta.foregroundSurface, 'expo_dev_menu');
  assert.equal(envelope.meta.recommendation, undefined);
});

for (const platform of ['ios', 'android']) {
  test(`dev_settings hideDevMenu: ${platform} sheet present -> typed hidden after clean probe`, async () => {
    const { handler, calls } = handlerFor(
      platform,
      ['expo_dev_menu', 'app'],
      [{ value: 'ok:hideMenu' }, { value: 'ok:hideMenu' }],
    );
    const data = expectOk(await handler({ action: 'hideDevMenu' }));
    assert.equal(data.outcome, 'hidden');
    assert.equal(data.method, 'hideMenu');
    assert.equal(data.surface, 'app');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].awaitPromise, true);
    assert.equal(calls[0].timeoutMs, 5_000);
  });

  test(`dev_settings hideDevMenu: ${platform} app surface -> no_menu_present without close call`, async () => {
    const { handler, calls } = handlerFor(platform, ['app'], [{ value: 'ok:hideMenu' }]);
    const data = expectOk(await handler({ action: 'hideDevMenu' }));
    assert.equal(data.outcome, 'no_menu_present');
    assert.equal(data.executed, false);
    assert.equal(calls.length, 0);
  });
}

test('Android React Native core dev menu stops without invoking a close action', async () => {
  const appId = 'com.example.app';
  const coreMenuSnapshot = snapshotEnvelope([
    { label: 'React Native Dev Menu', packageName: appId },
    { label: 'Open DevTools', packageName: appId },
    { label: 'Change Bundle Location', packageName: appId },
    ...normalAndroidSystemChrome(),
  ]);
  const probeForegroundSurface = async () => foregroundSurfaceFromSnapshot(coreMenuSnapshot, appId);
  const { client, calls } = hideEval('android', { value: 'ok:hideMenu' });
  const handler = createDevSettingsHandler(() => client, {
    probeForegroundSurface,
    settleAfterHide: async () => {},
  });

  const data = expectOk(await handler({ action: 'hideDevMenu' }));
  assert.equal(data.outcome, 'no_menu_present');
  assert.equal(data.surface, 'react_native_dev_menu');
  assert.equal(data.executed, false);
  assert.equal(calls.length, 0);
});

test('blank Android bound-app snapshot returns no_menu_present without close evaluation', async () => {
  const appId = 'com.example.app';
  const blankAppSnapshot = snapshotEnvelope([
    {
      label: '',
      identifier: '',
      type: 'android.widget.FrameLayout',
      packageName: appId,
    },
  ]);
  const probeForegroundSurface = async () => foregroundSurfaceFromSnapshot(blankAppSnapshot, appId);
  const { client, calls } = hideEval('android', { value: 'ok:hideMenu' });
  const handler = createDevSettingsHandler(() => client, {
    probeForegroundSurface,
    settleAfterHide: async () => {},
  });

  const data = expectOk(await handler({ action: 'hideDevMenu' }));
  assert.equal(data.outcome, 'no_menu_present');
  assert.equal(data.surface, 'app');
  assert.equal(data.executed, false);
  assert.equal(calls.length, 0);
});

for (const sentinel of ['no_module', 'no_method_available']) {
  test(`dev_settings hideDevMenu: ${sentinel} -> DEV_MENU_HIDE_FAILED`, async () => {
    const { handler } = handlerFor(
      'ios',
      ['expo_dev_menu'],
      [{ value: sentinel }, { value: sentinel }],
    );
    const result = await handler({ action: 'hideDevMenu' });
    const envelope = parseEnvelope(result);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'DEV_MENU_HIDE_FAILED');
    assert.equal(envelope.meta.outcome, 'DEV_MENU_HIDE_FAILED');
    assert.equal(envelope.meta.callSent, false);
  });
}

test('hideExpoDevMenu preserves attempted-call truth for a rejected native promise', async () => {
  const { client } = hideEval('android', { value: 'error:hideMenu:native rejection' });
  const outcome = await hideExpoDevMenu(client);
  assert.equal(outcome.callSent, true);
  assert.equal(outcome.method, 'hideMenu');
  assert.match(outcome.reason, /native rejection/);
});

test('a later resolution failure cannot erase an earlier close invocation', async () => {
  const { handler, calls } = handlerFor(
    'android',
    ['expo_dev_menu', 'app'],
    [{ value: 'ok:hideMenu' }, { value: 'no_module' }],
  );
  const data = expectOk(await handler({ action: 'hideDevMenu' }));
  assert.equal(data.outcome, 'hidden');
  assert.equal(data.method, 'hideMenu');
  assert.equal(data.attempts, 2);
  assert.equal(calls.length, 2);
});

test('normal Android system chrome permits a clean hidden post-probe', async () => {
  const appId = 'com.example.app';
  const snapshots = [
    [{ label: 'Copy system info' }, { label: 'Open DevTools' }, ...normalAndroidSystemChrome()],
    [{ label: 'Home', packageName: appId }, ...normalAndroidSystemChrome()],
  ];
  let probeIndex = 0;
  const probeForegroundSurface = async () =>
    foregroundSurfaceFromSnapshot(
      snapshotEnvelope(snapshots[Math.min(probeIndex++, snapshots.length - 1)]),
      appId,
    );
  const { client } = hideEval('android', { value: 'ok:hideMenu' }, { value: 'ok:hideMenu' });
  const handler = createDevSettingsHandler(() => client, {
    probeForegroundSurface,
    settleAfterHide: async () => {},
  });

  const data = expectOk(await handler({ action: 'hideDevMenu' }));
  assert.equal(data.outcome, 'hidden');
  assert.equal(data.surface, 'app');
});

test('mixed bound-app and permission-dialog evidence cannot yield hidden', async () => {
  const appId = 'com.example.app';
  const snapshots = [
    [{ label: 'Copy system info' }, { label: 'Open DevTools' }],
    [
      { label: 'Home', packageName: appId },
      {
        label: 'Allow',
        type: 'android.widget.Button',
        packageName: 'com.android.permissioncontroller',
      },
    ],
  ];
  let probeIndex = 0;
  const probeForegroundSurface = async () =>
    foregroundSurfaceFromSnapshot(
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              data: { nodes: snapshots[Math.min(probeIndex++, snapshots.length - 1)] },
            }),
          },
        ],
      },
      appId,
    );
  const { client } = hideEval('android', { value: 'ok:hideMenu' }, { value: 'ok:hideMenu' });
  const handler = createDevSettingsHandler(() => client, {
    probeForegroundSurface,
    settleAfterHide: async () => {},
  });

  const envelope = parseEnvelope(await handler({ action: 'hideDevMenu' }));
  assert.equal(envelope.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.equal(envelope.meta.callSent, true);
  assert.equal(envelope.meta.surfaceAfter, 'unknown');
});

test('a never-settling native close remains sent and returns unverified after one retry', async () => {
  let closeCalls = 0;
  const context = {
    expo: {
      modules: {
        ExpoDevMenu: {
          hideMenu: () => {
            closeCalls++;
            return new Promise(() => {});
          },
        },
      },
    },
    setTimeout: () => 0,
  };
  const asyncClient = new CDPClient(8081);
  Reflect.set(asyncClient, 'sendWithTimeout', async (_method, params) => ({
    result: { value: runInNewContext(params.expression, context) },
  }));
  const client = createMockClient({
    _connectedTarget: {
      id: 'page1',
      title: 'React Native (Hermes)',
      vm: 'Hermes',
      webSocketDebuggerUrl: 'ws://127.0.0.1:8081/debugger/page1',
      platform: 'android',
    },
    evaluate: (expression, awaitPromise) => asyncClient.evaluate(expression, awaitPromise, 20),
  });
  const handler = createDevSettingsHandler(() => client, {
    probeForegroundSurface: surfaceProbe('expo_dev_menu', 'expo_dev_menu'),
    settleAfterHide: async () => {},
  });

  const envelope = parseEnvelope(await handler({ action: 'hideDevMenu' }));
  assert.equal(envelope.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.equal(envelope.meta.callSent, true);
  assert.equal(envelope.meta.method, 'hideMenu');
  assert.equal(envelope.meta.attempts, 2);
  assert.equal(closeCalls, 2);
});

test('a polling transport failure preserves sent invocation truth across the retry', async () => {
  let closeCalls = 0;
  const context = {
    expo: {
      modules: {
        ExpoDevMenu: {
          hideMenu: () => {
            closeCalls++;
            return new Promise(() => {});
          },
        },
      },
    },
    setTimeout: () => 0,
  };
  const asyncClient = new CDPClient(8081);
  Reflect.set(asyncClient, 'sendWithTimeout', async (_method, params) => {
    if (params.expression.startsWith("globalThis['__rn_agent_async_")) {
      throw new Error('WebSocket closed during async poll');
    }
    return { result: { value: runInNewContext(params.expression, context) } };
  });
  const client = createMockClient({
    _connectedTarget: {
      id: 'page1',
      title: 'React Native (Hermes)',
      vm: 'Hermes',
      webSocketDebuggerUrl: 'ws://127.0.0.1:8081/debugger/page1',
      platform: 'android',
    },
    evaluate: (expression, awaitPromise) => asyncClient.evaluate(expression, awaitPromise, 1_000),
  });
  const handler = createDevSettingsHandler(() => client, {
    probeForegroundSurface: surfaceProbe('expo_dev_menu', 'expo_dev_menu'),
    settleAfterHide: async () => {},
  });

  const envelope = parseEnvelope(await handler({ action: 'hideDevMenu' }));
  assert.equal(envelope.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.equal(envelope.meta.callSent, true);
  assert.equal(envelope.meta.method, 'hideMenu');
  assert.equal(envelope.meta.attempts, 2);
  assert.equal(closeCalls, 2);
});

test('initialization distinguishes definite pre-send failure from post-dispatch uncertainty', async () => {
  const preSendClient = new CDPClient(8081);
  const preSendHandlerClient = createMockClient({
    evaluate: (expression, awaitPromise) => preSendClient.evaluate(expression, awaitPromise, 20),
  });
  const preSendHandler = createDevSettingsHandler(() => preSendHandlerClient, {
    probeForegroundSurface: surfaceProbe('expo_dev_menu'),
    settleAfterHide: async () => {},
  });

  const preSendEnvelope = parseEnvelope(await preSendHandler({ action: 'hideDevMenu' }));
  assert.equal(preSendEnvelope.code, 'DEV_MENU_HIDE_FAILED');
  assert.equal(preSendEnvelope.meta.callSent, false);

  const sentRequests = [];
  const postDispatchClient = new CDPClient(8081);
  Reflect.set(postDispatchClient, 'ws', {
    readyState: 1,
    send: (payload) => sentRequests.push(JSON.parse(payload)),
  });
  const postDispatchHandlerClient = createMockClient({
    evaluate: (expression, awaitPromise) =>
      postDispatchClient.evaluate(expression, awaitPromise, 20),
  });
  const postDispatchHandler = createDevSettingsHandler(() => postDispatchHandlerClient, {
    probeForegroundSurface: surfaceProbe('expo_dev_menu', 'expo_dev_menu'),
    settleAfterHide: async () => {},
  });

  const postDispatchEnvelope = parseEnvelope(await postDispatchHandler({ action: 'hideDevMenu' }));
  assert.equal(postDispatchEnvelope.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.equal(postDispatchEnvelope.meta.callSent, true);
  assert.equal(postDispatchEnvelope.meta.attempts, 2);
  assert.equal(sentRequests.length, 2);
  assert.equal(
    sentRequests.every((request) => request.method === 'Runtime.evaluate'),
    true,
  );
});

test('CDP protocol rejection remains typed and cannot imply a dev-menu invocation', async () => {
  const pendingResponse = Promise.withResolvers();
  const pending = new Map([
    [
      41,
      {
        resolve: pendingResponse.resolve,
        reject: pendingResponse.reject,
        timer: setTimeout(() => {}, 1_000),
      },
    ],
  ]);
  handleMessage(
    Buffer.from(
      JSON.stringify({
        id: 41,
        error: { code: -32000, message: 'Execution context was destroyed.' },
      }),
    ),
    pending,
    new Map(),
  );
  await assert.rejects(pendingResponse.promise, (error) => {
    if (!(error instanceof CDPProtocolError)) return false;
    assert.equal(error.code, -32000);
    assert.equal(error.message, 'Execution context was destroyed.');
    return true;
  });

  let requestIndex = 0;
  let probeCalls = 0;
  const protocolClient = new CDPClient(8081);
  Reflect.set(protocolClient, 'ws', {
    readyState: 1,
    send: (payload) => {
      const request = JSON.parse(payload);
      const responses = [
        { error: { code: -32000, message: 'Execution context was destroyed.' } },
        { result: { result: { value: {} } } },
        { result: { result: { value: { v: JSON.stringify('no_module') } } } },
      ];
      const response = responses[requestIndex++];
      queueMicrotask(() => {
        Reflect.get(protocolClient, 'handleMessage').call(
          protocolClient,
          Buffer.from(JSON.stringify({ id: request.id, ...response })),
        );
      });
    },
  });
  const handlerClient = createMockClient({
    _connectedTarget: {
      id: 'page1',
      title: 'React Native (Hermes)',
      vm: 'Hermes',
      webSocketDebuggerUrl: 'ws://127.0.0.1:8081/debugger/page1',
      platform: 'android',
    },
    evaluate: (expression, awaitPromise, timeoutMs) =>
      protocolClient.evaluate(expression, awaitPromise, timeoutMs),
  });
  const handler = createDevSettingsHandler(() => handlerClient, {
    probeForegroundSurface: async () => {
      probeCalls++;
      return probeCalls === 1 ? 'expo_dev_menu' : 'app';
    },
    settleAfterHide: async () => {},
  });

  const envelope = parseEnvelope(await handler({ action: 'hideDevMenu' }));
  assert.equal(envelope.code, 'DEV_MENU_HIDE_FAILED');
  assert.equal(envelope.meta.callSent, false);
  assert.equal(envelope.meta.attempts, 2);
  assert.equal(probeCalls, 1);
  assert.equal(requestIndex, 4);
});

test('dev_settings hideDevMenu: close sent but post-probe remains occluded -> unverified', async () => {
  const { handler } = handlerFor(
    'android',
    ['expo_dev_menu', 'expo_dev_menu'],
    [{ value: 'ok:closeMenu' }, { value: 'ok:closeMenu' }],
  );
  const envelope = parseEnvelope(await handler({ action: 'hideDevMenu' }));
  assert.equal(envelope.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.equal(envelope.meta.callSent, true);
  assert.equal(envelope.meta.surfaceAfter, 'expo_dev_menu');
  assert.match(envelope.meta.remedy, /classify/i);
});

test('hideExpoDevMenu: a timeout retries once and remains bounded to five seconds', async () => {
  const { client, calls } = hideEval(
    'android',
    { throw: 'Runtime.evaluate timeout (5000ms)' },
    { value: 'ok:hideMenu' },
  );
  const outcome = await hideExpoDevMenu(client, { retries: 7, retryDelayMs: 0 });
  assert.equal(outcome.callSent, true);
  assert.equal(outcome.attempts, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => call.timeoutMs),
    [5_000, 5_000],
  );
});

test('hideDevMenu shares one five-second deadline across initialization and polling', async () => {
  const client = new CDPClient(8081);
  const evaluations = [];
  Reflect.set(client, 'sendWithTimeout', async (_method, params, timeoutMs) => {
    evaluations.push({ expression: params.expression, timeoutMs });
    if (evaluations.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return {};
  });

  const result = await client.evaluate('new Promise(function () {})', true, 1_000);
  const polls = evaluations.filter(({ expression }) =>
    expression.startsWith("globalThis['__rn_agent_async_"),
  );
  assert.match(result.error, /within 1000ms/);
  assert.equal(polls.length, 0);
  assert.equal(evaluations[0].timeoutMs <= 1_000, true);
});

test('hideDevMenu does not replay its bounded retry after stale-helper detection', async () => {
  const { client, calls } = hideEval('android', { value: 'ok:hideMenu' }, { value: 'ok:hideMenu' });
  let freshnessProbes = 0;
  client.probeHelperFreshness = async () => {
    freshnessProbes++;
    return { fresh: false, version: null, probed: true };
  };
  const handler = createDevSettingsHandler(() => client, {
    probeForegroundSurface: surfaceProbe('expo_dev_menu', 'expo_dev_menu'),
    settleAfterHide: async () => {},
  });

  const envelope = parseEnvelope(await handler({ action: 'hideDevMenu' }));
  assert.equal(envelope.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.equal(calls.length, 2);
  assert.equal(freshnessProbes, 0);
});

test('dev_settings hideDevMenu executes only ExpoDevMenu without touch or BACK capabilities', async () => {
  const invoked = [];
  const forbidden = [];
  const nativeCommands = [];
  const appId = 'com.example.app';
  const deviceId = 'emulator-5554';
  const snapshots = [
    [{ label: 'Copy system info' }, { label: 'Open DevTools' }],
    [{ label: 'Home', packageName: appId }],
  ];
  let snapshotIndex = 0;
  const recordForbidden = (name) => () => forbidden.push(name);
  const expoDevMenu = {
    hideMenu: () => {
      invoked.push('ExpoDevMenu.hideMenu');
    },
  };
  const reactNative = {
    NativeModules: {
      ExpoDevMenu: expoDevMenu,
      DevMenu: { hideMenu: recordForbidden('NativeModules.DevMenu.hideMenu') },
    },
    BackHandler: { exitApp: recordForbidden('BackHandler.exitApp') },
    UIManager: {
      dispatchViewManagerCommand: recordForbidden('UIManager.dispatchViewManagerCommand'),
    },
  };
  const context = {
    require: (name) => {
      assert.equal(name, 'react-native');
      return reactNative;
    },
    nativeCallSyncHook: recordForbidden('nativeCallSyncHook'),
    nativeFabricUIManager: {
      dispatchCommand: recordForbidden('nativeFabricUIManager.dispatchCommand'),
    },
    __fbBatchedBridge: {
      enqueueNativeCall: recordForbidden('__fbBatchedBridge.enqueueNativeCall'),
    },
  };
  const client = createMockClient({
    _connectedTarget: {
      id: 'page1',
      title: 'React Native (Hermes)',
      vm: 'Hermes',
      webSocketDebuggerUrl: 'ws://127.0.0.1:8081/debugger/page1',
      platform: 'android',
    },
    evaluate: async (expression, awaitPromise, timeoutMs) => {
      assert.equal(awaitPromise, true);
      assert.equal(timeoutMs, 5_000);
      return { value: await runInNewContext(expression, context) };
    },
  });
  _setActiveSessionForTest({
    name: 'dev-menu-test',
    platform: 'android',
    deviceId,
    appId,
    openedAt: new Date(0).toISOString(),
  });
  _setRunAgentDeviceForTest(async (args, options) => {
    nativeCommands.push({ args, platform: options.platform });
    return snapshotEnvelope(snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]);
  });
  try {
    const probeForegroundSurface = createForegroundSurfaceProbe({
      getAuthorityStatus: () => ({
        available: true,
        bindings: {
          runner: { instanceId: 'runner-1' },
          device: { platform: 'android', deviceId, appId },
        },
      }),
      getActiveSession,
      runNative,
    });
    const handler = createDevSettingsHandler(() => client, {
      probeForegroundSurface,
      settleAfterHide: async () => {},
    });

    const data = expectOk(await handler({ action: 'hideDevMenu' }));
    assert.equal(data.outcome, 'hidden');
    assert.deepEqual(invoked, ['ExpoDevMenu.hideMenu', 'ExpoDevMenu.hideMenu']);
    assert.deepEqual(forbidden, []);
    assert.deepEqual(nativeCommands, [
      { args: ['snapshot'], platform: 'android' },
      { args: ['snapshot'], platform: 'android' },
    ]);
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});

test('ExpoDevMenu resolution never falls through to the React Native core DevMenu', async () => {
  let coreCalls = 0;
  const value = await runInNewContext(HIDE_EXPO_DEV_MENU_EXPRESSION, {
    require: () => ({
      NativeModules: {
        DevMenu: {
          hideMenu: () => {
            coreCalls++;
          },
        },
      },
    }),
  });
  assert.equal(value, 'no_module');
  assert.equal(coreCalls, 0);
});

test('hideDevMenu requires runner authority and an interaction lease for its native probes', () => {
  const profile = authorityProfileFor('cdp_dev_settings', { action: 'hideDevMenu' });
  assert.equal(profile.axes.includes('R'), true);
  assert.equal(planeForTool('cdp_dev_settings', { action: 'hideDevMenu' }), 'interaction');
  assert.equal(planeForTool('cdp_dev_settings', { action: 'disableDevMenu' }), null);
});

test('reload does not invoke ExpoDevMenu implicitly', async () => {
  let client;
  let reloadCalls = 0;
  let expoDevMenuCalls = 0;
  const evaluations = [];
  const context = {
    __turboModuleProxy: (name) => {
      if (name === 'DevSettings') {
        return {
          reload: () => {
            reloadCalls++;
            client._isConnected = false;
          },
        };
      }
      if (name === 'ExpoDevMenu') {
        return {
          hideMenu: () => {
            expoDevMenuCalls++;
          },
        };
      }
      return null;
    },
  };
  client = createMockClient({
    evaluate: async (expression) => {
      evaluations.push(expression);
      return { value: runInNewContext(expression, context) };
    },
    softReconnect: async () => {
      client._isConnected = true;
      client._helpersInjected = true;
    },
    probeHelperFreshness: async () => ({ fresh: true, version: 40, probed: true }),
  });
  const handler = createReloadHandler(
    () => client,
    (next) => {
      client = next;
    },
    () => client,
    { sleep: async () => {} },
  );

  const data = expectOk(await handler({ full: true }));
  assert.equal(data.reloaded, true);
  assert.equal(reloadCalls, 1);
  assert.equal(expoDevMenuCalls, 0);
  assert.equal(evaluations.length, 1);
});

test('HIDE_EXPO_DEV_MENU_EXPRESSION is syntactically valid JS', () => {
  assert.doesNotThrow(() => new Function('return ' + HIDE_EXPO_DEV_MENU_EXPRESSION));
});

test('RESOLVE_EXPO_DEV_MENU is syntactically valid JS', () => {
  assert.doesNotThrow(() => new Function('return ' + RESOLVE_EXPO_DEV_MENU));
});
