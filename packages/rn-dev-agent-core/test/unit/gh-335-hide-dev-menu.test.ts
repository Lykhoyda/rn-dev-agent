import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hideExpoDevMenu,
  autoDismissDevMenuMeta,
  HIDE_EXPO_DEV_MENU_EXPRESSION,
  RESOLVE_EXPO_DEV_MENU,
} from '../../dist/tools/expo-dev-menu.js';
import { createDevSettingsHandler } from '../../dist/tools/dev-settings.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk, expectWarn } from '../helpers/result-helpers.js';

const fastRetry = { retries: 2, retryDelayMs: 0 };

function clientReturning(...values) {
  let i = 0;
  const calls = { count: 0 };
  const client = {
    evaluate: async () => {
      calls.count += 1;
      const v = values[Math.min(i, values.length - 1)];
      i += 1;
      if (v && typeof v === 'object' && 'throw' in v) throw new Error(v.throw);
      return v;
    },
  };
  return { client, calls };
}

test('hideExpoDevMenu: ok:hideMenu → dismissed via hideMenu', async () => {
  const { client } = clientReturning({ value: 'ok:hideMenu' });
  const r = await hideExpoDevMenu(client);
  assert.equal(r.dismissed, true);
  assert.equal(r.method, 'hideMenu');
});

test('hideExpoDevMenu: ok:closeMenu → dismissed via closeMenu', async () => {
  const { client } = clientReturning({ value: 'ok:closeMenu' });
  const r = await hideExpoDevMenu(client);
  assert.equal(r.dismissed, true);
  assert.equal(r.method, 'closeMenu');
});

test('hideExpoDevMenu: no_module → not dismissed, actionable reason', async () => {
  const { client } = clientReturning({ value: 'no_module' });
  const r = await hideExpoDevMenu(client);
  assert.equal(r.dismissed, false);
  assert.match(r.reason, /expo dev-menu module/i);
});

test('hideExpoDevMenu: no_method_available → not dismissed', async () => {
  const { client } = clientReturning({ value: 'no_method_available' });
  const r = await hideExpoDevMenu(client);
  assert.equal(r.dismissed, false);
});

test('hideExpoDevMenu: error sentinel → not dismissed, surfaces message', async () => {
  const { client } = clientReturning({ value: 'error:boom' });
  const r = await hideExpoDevMenu(client);
  assert.equal(r.dismissed, false);
  assert.match(r.reason, /boom/);
});

test('hideExpoDevMenu: eval {error} → not dismissed, does not throw', async () => {
  const { client } = clientReturning({ error: 'WebSocket closed' });
  const r = await hideExpoDevMenu(client);
  assert.equal(r.dismissed, false);
});

test('hideExpoDevMenu: eval throws → not dismissed, does not throw', async () => {
  const { client } = clientReturning({ throw: 'kaboom' });
  const r = await hideExpoDevMenu(client);
  assert.equal(r.dismissed, false);
  assert.match(r.reason, /kaboom/);
});

test('hideExpoDevMenu: retries fire N+1 evaluations on ok', async () => {
  const { client, calls } = clientReturning({ value: 'ok:hideMenu' });
  await hideExpoDevMenu(client, fastRetry);
  assert.equal(calls.count, 3);
});

test('hideExpoDevMenu: no_module short-circuits retries', async () => {
  const { client, calls } = clientReturning({ value: 'no_module' });
  await hideExpoDevMenu(client, fastRetry);
  assert.equal(calls.count, 1);
});

test('hideExpoDevMenu: a later transient eval error does not downgrade an earlier success', async () => {
  const { client } = clientReturning({ value: 'ok:hideMenu' }, { error: 'WebSocket closed' });
  const r = await hideExpoDevMenu(client, { retries: 1, retryDelayMs: 0 });
  assert.equal(r.dismissed, true);
  assert.equal(r.method, 'hideMenu');
});

test('hideExpoDevMenu: a later eval throw does not downgrade an earlier success', async () => {
  const { client } = clientReturning({ value: 'ok:hideMenu' }, { throw: 'blip' });
  const r = await hideExpoDevMenu(client, { retries: 1, retryDelayMs: 0 });
  assert.equal(r.dismissed, true);
});

test('autoDismissDevMenuMeta: iOS + dismissed → meta with method', async () => {
  const client = {
    connectedTarget: { platform: 'ios' },
    evaluate: async () => ({ value: 'ok:hideMenu' }),
  };
  const meta = await autoDismissDevMenuMeta(client);
  assert.equal(meta.dev_menu_dismissed, true);
  assert.equal(meta.dev_menu_method, 'hideMenu');
});

test('autoDismissDevMenuMeta: Android → empty (platform gate)', async () => {
  let evaluated = false;
  const client = {
    connectedTarget: { platform: 'android' },
    evaluate: async () => {
      evaluated = true;
      return { value: 'ok:hideMenu' };
    },
  };
  const meta = await autoDismissDevMenuMeta(client);
  assert.deepEqual(meta, {});
  assert.equal(evaluated, false, 'must not evaluate on Android');
});

test('autoDismissDevMenuMeta: iOS + no_module → empty', async () => {
  const client = {
    connectedTarget: { platform: 'ios' },
    evaluate: async () => ({ value: 'no_module' }),
  };
  assert.deepEqual(await autoDismissDevMenuMeta(client), {});
});

test('autoDismissDevMenuMeta: iOS + eval throws → empty (best-effort)', async () => {
  const client = {
    connectedTarget: { platform: 'ios' },
    evaluate: async () => {
      throw new Error('detached');
    },
  };
  assert.deepEqual(await autoDismissDevMenuMeta(client), {});
});

test('HIDE_EXPO_DEV_MENU_EXPRESSION is syntactically valid JS', () => {
  assert.doesNotThrow(() => new Function('return ' + HIDE_EXPO_DEV_MENU_EXPRESSION));
});

test('RESOLVE_EXPO_DEV_MENU is syntactically valid JS', () => {
  assert.doesNotThrow(() => new Function('return ' + RESOLVE_EXPO_DEV_MENU));
});

// Return the hide sentinel only for the hide expression; keep the withConnection
// freshness probe (`typeof globalThis.__RN_AGENT`) returning a number.
function hideEval(sentinel) {
  return async (expr) => {
    if (expr.includes('__RN_AGENT')) return { value: 13 };
    if (expr.includes('__DEV__')) return { value: true };
    return { value: sentinel };
  };
}

test('dev_settings hideDevMenu: dismissed → ok with method', async () => {
  const client = createMockClient({ evaluate: hideEval('ok:hideMenu') });
  const handler = createDevSettingsHandler(() => client);
  const data = expectOk(await handler({ action: 'hideDevMenu' }));
  assert.equal(data.executed, true);
  assert.equal(data.method, 'hideMenu');
});

test('dev_settings hideDevMenu: no_module → warn, not executed', async () => {
  const client = createMockClient({ evaluate: hideEval('no_module') });
  const handler = createDevSettingsHandler(() => client);
  const { data, warning } = expectWarn(await handler({ action: 'hideDevMenu' }));
  assert.equal(data.executed, false);
  assert.match(warning, /expo dev-menu module/i);
});
