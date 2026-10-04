import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDevSettingsHandler, WALK_DEV_SETTINGS } from '../../dist/handlers/dev-settings.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../helpers/result-helpers.js';

function run(evaluate: () => Promise<Record<string, unknown>>) {
  const calls: { expression: string; awaitPromise?: boolean }[] = [];
  const client = createMockClient({
    evaluate: async (expression: string, awaitPromise?: boolean) => {
      calls.push({ expression, awaitPromise });
      return evaluate();
    },
  });
  const handler = createDevSettingsHandler(() => client);
  return { calls, result: handler({ action: 'hideDevMenuFab' }) };
}

test('D1: a verified hidden floating button lets the walk proceed', async () => {
  const { calls, result } = run(async () => ({ value: 'ok' }));
  const env = parseEnvelope(await result);
  assert.equal(env.ok, true);
  assert.equal(env.data.executed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].awaitPromise, true);
  assert.match(calls[0].expression, /showFloatingActionButton: false/);
});

test('D2: an app without the dev-menu preferences module proceeds unchanged', async () => {
  const { result } = run(async () => ({ value: 'no_method_available' }));
  const env = parseEnvelope(await result);
  assert.notEqual(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
  assert.equal(env.data?.executed, false);
});

for (const [name, outcome] of [
  ['an unconfirmed read-back', async () => ({ value: 'unverified' })],
  ['a rejected preferences call', async () => ({ error: 'setPreferencesAsync rejected' })],
] as [string, () => Promise<Record<string, unknown>>][]) {
  test(`D3: ${name} reports the existing unverified dev-menu code`, async () => {
    const { result } = run(outcome);
    const env = parseEnvelope(await result);
    assert.equal(env.ok, false);
    assert.equal(env.code, 'DEV_MENU_HIDE_UNVERIFIED');
  });
}

test('D4: the walk hides the floating button before the other dev-menu actions', () => {
  assert.deepEqual([...WALK_DEV_SETTINGS], ['hideDevMenuFab', 'disableDevMenu', 'hideDevMenu']);
});
