import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStateRead, STATE_KINDS } from '../../dist/observability/state-read.js';
import type { StateReadGate } from '../../dist/observability/state-read.js';
import { createNavigationStateHandler } from '../../dist/tools/navigation-state.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import type { ToolResult } from '../../dist/utils.js';

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
  meta?: unknown;
}

const envelope = (obj: Envelope): ToolResult =>
  ({ content: [{ type: 'text', text: JSON.stringify(obj) }] }) as ToolResult;

const openGate = (released: string[] = []): (() => StateReadGate) => {
  return () => ({ ok: true, release: () => released.push('released') });
};

type Handlers = Record<'route' | 'store' | 'tree', () => Promise<ToolResult>>;

const HANDLERS = (over: Partial<Handlers> = {}): Handlers => ({
  route: async () => envelope({ ok: true, data: { routeName: 'Home' } }),
  store: async () => envelope({ ok: true, data: { cart: { items: 2 } } }),
  tree: async () => envelope({ ok: true, data: { components: [] } }),
  ...over,
});

test('exposes exactly the three panel kinds', () => {
  assert.deepEqual([...STATE_KINDS], ['route', 'store', 'tree']);
});

test('returns the parsed tool envelope for each known kind', async () => {
  const read = buildStateRead({ acquire: openGate(), handlers: HANDLERS() });
  assert.deepEqual(await read('route'), { ok: true, data: { routeName: 'Home' } });
  assert.deepEqual(await read('store'), { ok: true, data: { cart: { items: 2 } } });
  assert.deepEqual(await read('tree'), { ok: true, data: { components: [] } });
});

test('unknown kind returns null (server maps to 404)', async () => {
  const read = buildStateRead({ acquire: openGate(), handlers: HANDLERS() });
  assert.equal(await read('nav'), null);
  assert.equal(await read(''), null);
  assert.equal(await read('__proto__'), null);
});

test('refuses when the arbiter lease is denied — handler never runs', async () => {
  let called = false;
  const read = buildStateRead({
    acquire: () => ({ ok: false, code: 'BUSY_FLOW_ACTIVE' }),
    handlers: HANDLERS({
      route: async () => {
        called = true;
        return envelope({ ok: true, data: {} });
      },
    }),
  });
  const out = (await read('route')) as Envelope;
  assert.equal(out.ok, false);
  assert.equal(out.code, 'BUSY_FLOW_ACTIVE');
  assert.equal(called, false);
});

test('the lease is released after a successful read', async () => {
  const released: string[] = [];
  const read = buildStateRead({ acquire: openGate(released), handlers: HANDLERS() });
  await read('route');
  assert.deepEqual(released, ['released']);
});

test('the lease is released even when the handler throws', async () => {
  const released: string[] = [];
  const read = buildStateRead({
    acquire: openGate(released),
    handlers: HANDLERS({
      store: async () => {
        throw new Error('socket hung up');
      },
    }),
  });
  const out = (await read('store')) as Envelope;
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /socket hung up/);
  assert.deepEqual(released, ['released']);
});

test('fail envelopes from the handler pass through verbatim', async () => {
  const read = buildStateRead({
    acquire: openGate(),
    handlers: HANDLERS({
      tree: async () => envelope({ ok: false, error: 'Not connected', code: 'NOT_CONNECTED' }),
    }),
  });
  assert.deepEqual(await read('tree'), {
    ok: false,
    error: 'Not connected',
    code: 'NOT_CONNECTED',
  });
});

test('non-JSON or empty tool results become ok:false envelopes', async () => {
  const read = buildStateRead({
    acquire: openGate(),
    handlers: HANDLERS({
      route: async () => ({ content: [{ type: 'text', text: 'not-json{' }] }) as ToolResult,
      store: async () => ({ content: [] }) as unknown as ToolResult,
    }),
  });
  assert.equal(((await read('route')) as Envelope).ok, false);
  assert.equal(((await read('store')) as Envelope).ok, false);
});

test('a throwing acquire fails safe to an ok:false envelope', async () => {
  const read = buildStateRead({
    acquire: () => {
      throw new Error('gate exploded');
    },
    handlers: HANDLERS(),
  });
  const out = (await read('route')) as Envelope;
  assert.equal(out.ok, false);
});

test('annotate:false route read returns nav state without mutation-absence meta', async () => {
  const navState = { routeName: 'Home', index: 0, routes: [{ name: 'Home' }] };
  const client = createMockClient({
    evaluate: async () => ({ value: JSON.stringify(navState) }),
  });
  const handler = createNavigationStateHandler(() => client, { annotate: false });
  const out = JSON.parse((await handler({})).content[0].text) as Envelope;
  assert.equal(out.ok, true);
  assert.deepEqual(out.data, navState);
  assert.equal(out.meta, undefined);
});
