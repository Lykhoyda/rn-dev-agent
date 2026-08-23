import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  autoDismissDevMenuMeta,
  classifyForegroundSurface,
  foregroundSurfaceFromSnapshot,
  hideExpoDevMenu,
  HIDE_EXPO_DEV_MENU_EXPRESSION,
  RESOLVE_EXPO_DEV_MENU,
} from '../../dist/tools/expo-dev-menu.js';
import { CDPClient } from '../../dist/cdp-client.js';
import { planeForTool } from '../../dist/lifecycle/device-arbiter.js';
import { authorityProfileFor } from '../../dist/session/tool-profiles.js';
import { createDevSettingsHandler } from '../../dist/tools/dev-settings.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk, parseEnvelope } from '../helpers/result-helpers.js';

function surfaceProbe(...surfaces) {
  let index = 0;
  return async () => surfaces[Math.min(index++, surfaces.length - 1)];
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
    'expo_dev_menu',
  );
  assert.equal(classifyForegroundSurface([{ label: 'Development servers' }]), 'dev_client_picker');
  assert.equal(
    classifyForegroundSurface([{ label: 'This is the developer menu. It gives you access.' }]),
    'first_run_tutorial',
  );
  assert.equal(classifyForegroundSurface([{ label: 'Open Debugger' }]), 'react_native_dev_menu');
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
        {
          label: 'Back',
          type: 'android.widget.ImageView',
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
        { label: 'Fixture', type: 'Application' },
        { label: 'Allow', type: 'Alert' },
      ],
      'com.example.app',
    ),
    'unknown',
  );
  assert.equal(classifyForegroundSurface([]), 'unknown');
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
  const handler = createDevSettingsHandler(() => client, {
    probeForegroundSurface: surfaceProbe('expo_dev_menu', 'expo_dev_menu'),
    settleAfterHide: async () => {},
  });

  const envelope = parseEnvelope(await handler({ action: 'hideDevMenu' }));
  assert.equal(envelope.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.deepEqual(invoked, ['ExpoDevMenu.hideMenu', 'ExpoDevMenu.hideMenu']);
  assert.deepEqual(forbidden, []);
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

test('reload keeps best-effort iOS dismissal without reporting unverified success', async () => {
  const { client, calls } = hideEval('ios', { value: 'ok:hideMenu' }, { value: 'ok:hideMenu' });
  assert.deepEqual(await autoDismissDevMenuMeta(client), {});
  assert.equal(calls.length, 2);
});

test('HIDE_EXPO_DEV_MENU_EXPRESSION is syntactically valid JS', () => {
  assert.doesNotThrow(() => new Function('return ' + HIDE_EXPO_DEV_MENU_EXPRESSION));
});

test('RESOLVE_EXPO_DEV_MENU is syntactically valid JS', () => {
  assert.doesNotThrow(() => new Function('return ' + RESOLVE_EXPO_DEV_MENU));
});
