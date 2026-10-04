import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  clearDevOverlays,
  recoverDevOverlays,
  createDevSettingsHandler,
  WALK_DEV_SETTINGS,
} from '../../dist/handlers/dev-settings.js';
import { failResult, okResult, warnResult, type ToolResult } from '../../dist/utils.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../helpers/result-helpers.js';

function run(preferences?: Record<string, unknown>) {
  const calls: { awaitPromise?: boolean; value?: unknown }[] = [];
  const client = createMockClient({
    evaluate: async (expression: string, awaitPromise?: boolean) => {
      try {
        const value = await runInNewContext(expression, {
          expo: { modules: { DevMenuPreferences: preferences } },
        });
        calls.push({ awaitPromise, value });
        return { value };
      } catch (error) {
        return { error: String(error) };
      }
    },
  });
  const handler = createDevSettingsHandler(() => client, { settleAfterHide: async () => {} });
  return { calls, result: handler({ action: 'hideDevMenuFab' }) };
}

test('D1: a verified hidden floating button lets the walk proceed', async () => {
  const mutations: Record<string, unknown>[] = [];
  let stored: Record<string, unknown> = { showFloatingActionButton: true };
  const { calls, result } = run({
    setPreferencesAsync: async (preferences: Record<string, unknown>) => {
      stored = { ...preferences };
      mutations.push(stored);
    },
    getPreferencesAsync: async () => stored,
  });
  const env = parseEnvelope(await result);
  assert.equal(env.ok, true);
  assert.equal(env.data.executed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].awaitPromise, true);
  assert.equal(calls[0].value, 'ok');
  assert.deepEqual(mutations, [
    {
      showFloatingActionButton: false,
      showsAtLaunch: false,
      motionGestureEnabled: false,
      touchGestureEnabled: false,
    },
  ]);
});

test('D2: an app without the dev-menu preferences module proceeds unchanged', async () => {
  const { calls, result } = run();
  const env = parseEnvelope(await result);
  assert.notEqual(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.equal(env.data?.executed, false);
  assert.equal(calls[0].value, 'no_method_available');
});

for (const [name, preferences] of [
  [
    'an unconfirmed read-back',
    {
      setPreferencesAsync: async () => {},
      getPreferencesAsync: async () => ({ showFloatingActionButton: true }),
    },
  ],
  ['a missing read-back', { setPreferencesAsync: async () => {} }],
  [
    'a rejected preferences call',
    {
      setPreferencesAsync: async () => {
        throw new Error('setPreferencesAsync rejected');
      },
    },
  ],
] as [string, Record<string, unknown>][]) {
  test(`D3: ${name} reports the existing unverified dev-menu code`, async () => {
    const { calls, result } = run(preferences);
    const env = parseEnvelope(await result);
    assert.equal(env.ok, false);
    assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
    if (name !== 'a rejected preferences call') assert.equal(calls[0].value, 'unverified');
  });
}

test('D4: the walk hides the floating button before the other dev-menu actions', () => {
  assert.deepEqual([...WALK_DEV_SETTINGS], ['hideDevMenuFab', 'disableDevMenu', 'hideDevMenu']);
});

type DevAction = (typeof WALK_DEV_SETTINGS)[number];

function overlays(
  results: Partial<Record<DevAction, () => ToolResult>>,
  fabReads: boolean[] = [false],
  stopAfter?: DevAction,
) {
  const calls: string[] = [];
  let stopping = false;
  const done = clearDevOverlays({
    async devSettings({ action }) {
      calls.push(action);
      if (action === stopAfter) stopping = true;
      return (results[action] ?? (() => okResult({ action, executed: true })))();
    },
    async devFab() {
      calls.push('read');
      return fabReads.length > 1 ? fabReads.shift()! : fabReads[0];
    },
    async cancelled() {
      if (stopping) throw new Error('RUN_CANCELLED: stopped');
    },
    log: (message) => calls.push(`log ${message}`),
    sleep: async () => {},
  });
  return { calls, done };
}

const unverifiedFab = () =>
  failResult(
    'The Expo dev-client floating button could not be confirmed hidden.',
    'DEV_MENU_HIDE_UNVERIFIED',
  );

test('overlays: an unverified floating-button hide refuses before any later action or step', async () => {
  const { calls, done } = overlays({ hideDevMenuFab: unverifiedFab });
  const env = parseEnvelope(await done);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.deepEqual(calls, ['hideDevMenuFab']);
});

test('overlays: an app without the preferences module passes and is still verified natively', async () => {
  const { calls, done } = overlays({
    hideDevMenuFab: () => warnResult({ action: 'hideDevMenuFab', executed: false }, 'no module'),
  });
  assert.equal(parseEnvelope(await done).ok, true);
  assert.deepEqual(calls, ['hideDevMenuFab', 'disableDevMenu', 'hideDevMenu', 'read']);
});

test('overlays: the other dev-menu actions log their failures and continue', async () => {
  const { calls, done } = overlays({
    disableDevMenu: () => failResult('Dev settings error: gone'),
    hideDevMenu: () => failResult('not hidden', 'DEV_MENU_HIDE_FAILED'),
  });
  assert.equal(parseEnvelope(await done).ok, true);
  assert.equal(calls.filter((c) => c.startsWith('log ')).length, 2);
  assert.equal(calls.at(-1), 'read');
});

test('overlays: a stop between actions halts before the next action', async () => {
  const { calls, done } = overlays({}, [false], 'hideDevMenuFab');
  await assert.rejects(done, /RUN_CANCELLED/);
  assert.deepEqual(calls, ['hideDevMenuFab']);
});

test('overlays: a floating button that stays on screen refuses with the unverified code', async () => {
  const { calls, done } = overlays({}, [true]);
  const env = parseEnvelope(await done);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.ok(calls.filter((c) => c === 'read').length > 1);
});

test('overlays: a verification read that fails refuses with the unverified code and its reason', async () => {
  const calls: string[] = [];
  const env = parseEnvelope(
    await clearDevOverlays({
      devSettings: async ({ action }) => okResult({ action, executed: true }),
      async devFab() {
        calls.push('read');
        throw new Error('NATIVE_CAPTURE_FAILED: runner gone');
      },
      cancelled: async () => {},
      log: () => {},
      sleep: async () => {},
    }),
  );
  assert.equal(env.ok, false);
  assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.match(env.error, /runner gone/);
  assert.ok(calls.length > 1);
});

test('overlays: a floating button still fading out is re-read until it is gone', async () => {
  const { done } = overlays({}, [true, true, false]);
  assert.equal(parseEnvelope(await done).ok, true);
});

for (const [name, result] of [
  ['a lost connection', () => failResult('CDP not connected', 'NOT_CONNECTED')],
  [
    'a thrown evaluate',
    () => {
      throw new Error('WebSocket closed');
    },
  ],
] as [string, () => ToolResult][]) {
  test(`overlays: ${name} during the floating-button hide refuses with the unverified code`, async () => {
    const { calls, done } = overlays({ hideDevMenuFab: result });
    const env = parseEnvelope(await done);
    assert.equal(env.ok, false);
    assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
    assert.match(
      env.error,
      name === 'a lost connection' ? /CDP not connected/ : /WebSocket closed/,
    );
    assert.deepEqual(calls, ['hideDevMenuFab']);
  });
}

function recovery(hide: () => ToolResult, fabShown: boolean) {
  const calls: string[] = [];
  let reads = 0;
  const done = recoverDevOverlays({
    async devSettings({ action }) {
      calls.push(action);
      return action === 'hideDevMenu' && calls.filter((c) => c === 'hideDevMenu').length === 1
        ? hide()
        : okResult({ action, executed: true });
    },
    async devFab() {
      calls.push('read');
      return reads++ === 0 ? fabShown : false;
    },
    async cancelled() {},
    log: () => {},
    sleep: async () => {},
  });
  return { calls, done };
}

const noMenu = () =>
  okResult({ action: 'hideDevMenu', executed: false, outcome: 'no_menu_present' });

test('recovery: a hidden dev menu re-runs the overlay clearing', async () => {
  const { calls, done } = recovery(
    () => okResult({ action: 'hideDevMenu', executed: true }),
    false,
  );
  assert.equal(parseEnvelope(await done).ok, true);
  assert.deepEqual(calls, [
    'read',
    'hideDevMenu',
    'hideDevMenuFab',
    'disableDevMenu',
    'hideDevMenu',
    'read',
  ]);
});

test('recovery: a floating button in front is cleared even with no menu to hide', async () => {
  const { calls, done } = recovery(noMenu, true);
  const env = parseEnvelope(await done);
  assert.equal(env.ok, true);
  assert.equal(env.data.executed, true);
  assert.ok(calls.includes('hideDevMenuFab'));
});

test('recovery: nothing to hide stays a no-op the walker does not count', async () => {
  const { calls, done } = recovery(noMenu, false);
  assert.equal(parseEnvelope(await done).data.executed, false);
  assert.deepEqual(calls, ['read', 'hideDevMenu']);
});

test('recovery: a failed dev-menu hide is returned as it is', async () => {
  const { calls, done } = recovery(
    () => failResult('not hidden', 'DEV_MENU_HIDE_UNVERIFIED'),
    true,
  );
  assert.equal(parseEnvelope(await done).code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.deepEqual(calls, ['read', 'hideDevMenu']);
});
