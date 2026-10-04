import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createDevSettingsHandler, WALK_DEV_SETTINGS } from '../../dist/handlers/dev-settings.js';
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
