import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoDismissDevMenuMeta,
  classifyForegroundSurface,
  foregroundSurfaceFromSnapshot,
  hideExpoDevMenu,
  HIDE_EXPO_DEV_MENU_EXPRESSION,
  RESOLVE_EXPO_DEV_MENU,
} from '../../dist/tools/expo-dev-menu.js';
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
  assert.equal(classifyForegroundSurface([{ label: 'Home' }]), 'app');
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
  test(`dev_settings hideDevMenu: ${sentinel} -> DEV_MENU_HIDE_UNVERIFIED`, async () => {
    const { handler } = handlerFor(
      'ios',
      ['expo_dev_menu'],
      [{ value: sentinel }, { value: sentinel }],
    );
    const result = await handler({ action: 'hideDevMenu' });
    const envelope = parseEnvelope(result);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'DEV_MENU_HIDE_UNVERIFIED');
    assert.equal(envelope.meta.outcome, 'DEV_MENU_HIDE_UNVERIFIED');
    assert.equal(envelope.meta.callSent, false);
  });
}

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

test('dev_settings hideDevMenu has no touch, coordinate, or BACK fallback', async () => {
  const { handler, calls } = handlerFor(
    'android',
    ['expo_dev_menu', 'expo_dev_menu'],
    [{ value: 'ok:hideMenu' }, { value: 'ok:hideMenu' }],
  );
  await handler({ action: 'hideDevMenu' });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.expression === HIDE_EXPO_DEV_MENU_EXPRESSION));
});

test('autoDismissDevMenuMeta reports dismissal only after before/after proof', async () => {
  const { client } = hideEval('ios', { value: 'ok:hideMenu' }, { value: 'ok:hideMenu' });
  assert.deepEqual(await autoDismissDevMenuMeta(client, surfaceProbe('expo_dev_menu', 'app')), {
    dev_menu_dismissed: true,
    dev_menu_method: 'hideMenu',
  });
});

test('autoDismissDevMenuMeta never reports success from the close call alone', async () => {
  const { client } = hideEval('ios', { value: 'ok:hideMenu' }, { value: 'ok:hideMenu' });
  assert.deepEqual(await autoDismissDevMenuMeta(client), {});
});

test('HIDE_EXPO_DEV_MENU_EXPRESSION is syntactically valid JS', () => {
  assert.doesNotThrow(() => new Function('return ' + HIDE_EXPO_DEV_MENU_EXPRESSION));
});

test('RESOLVE_EXPO_DEV_MENU is syntactically valid JS', () => {
  assert.doesNotThrow(() => new Function('return ' + RESOLVE_EXPO_DEV_MENU));
});
