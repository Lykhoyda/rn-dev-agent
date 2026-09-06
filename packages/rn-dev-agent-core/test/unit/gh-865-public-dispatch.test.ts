import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { CDPClient } from '../../dist/cdp-client.js';
import { createDispatchHandler } from '../../dist/tools/dispatch.js';
import { createExpectReduxHandler } from '../../dist/tools/macro-asserts.js';
import { createStoreStateHandler } from '../../dist/tools/store-state.js';
import { startFakeCDP } from '../helpers/fake-cdp-server.js';

interface Fiber {
  type: { name: string };
  memoizedProps: Record<string, unknown>;
  child: Fiber | null;
  sibling: Fiber | null;
}

interface DispatchOptions {
  action: string;
  payload?: unknown;
  readPath?: string;
}

test('public Redux tools share the deep Provider when the app bridge cannot dispatch', async (t) => {
  let phase = 'baseline';
  let dispatchCount = 0;
  const store = {
    getState: () => ({ qaAcceptance: { phase }, dispatchCount }),
    dispatch: ({ type }: { type: string }) => {
      dispatchCount++;
      if (type === 'qaAcceptance/completeQaAcceptance') phase = 'result';
    },
  };
  let fiber: Fiber = {
    type: { name: 'Provider' },
    memoizedProps: { store },
    child: null,
    sibling: null,
  };
  for (let depth = 0; depth < 60; depth++) {
    fiber = { type: { name: 'ContextProvider' }, memoizedProps: {}, child: fiber, sibling: null };
  }
  const bridge = {
    __v: 1,
    getNavState: () => '{}',
    getConsole: () => '[]',
    getErrors: () => '[]',
    getStoreState: () => JSON.stringify({ error: 'No stores' }),
    dispatchAction: (() => JSON.stringify({ error: 'No Redux store' })) as
      | ((opts: DispatchOptions) => string)
      | undefined,
  };
  const context = vm.createContext({
    __DEV__: true,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout,
    clearTimeout,
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      renderers: new Map([[1, {}]]),
      getFiberRoots: () => new Set([{ current: fiber }]),
    },
    __RN_DEV_BRIDGE__: bridge,
  });
  const server = await startFakeCDP();
  const client = new CDPClient(server.port);
  server.setResponse('Runtime.evaluate', (params) => {
    assert.ok(params && typeof params === 'object' && 'expression' in params);
    assert.equal(typeof params.expression, 'string');
    try {
      const value: unknown = vm.runInContext(String(params.expression), context);
      return { result: { type: typeof value, value } };
    } catch (error) {
      return { exceptionDetails: { text: String(error) } };
    }
  });
  try {
    await client.autoConnect(server.port);
    assert.equal(client.bridgeDetected, true);
    const read = createStoreStateHandler(() => client);
    for (const storeType of ['redux', undefined]) {
      const before = await read({ path: 'qaAcceptance', storeType });
      assert.deepEqual(JSON.parse(before.content[0].text), {
        ok: true,
        data: { type: 'redux', state: { phase: 'baseline' } },
      });
    }
    const expectRedux = createExpectReduxHandler(() => client);
    const matched = await expectRedux({
      storeType: 'redux',
      path: 'qaAcceptance.phase',
      equals: 'baseline',
      timeoutMs: 0,
    });
    assert.equal(JSON.parse(matched.content[0].text).data.matched, true);

    const dispatch = createDispatchHandler(() => client);
    const result = await dispatch({
      action: 'qaAcceptance/completeQaAcceptance',
      readPath: 'qaAcceptance.phase',
    });
    assert.deepEqual(JSON.parse(result.content[0].text), {
      ok: true,
      data: { dispatched: true, state: 'result' },
    });
    const after = await read({ storeType: 'redux', path: 'qaAcceptance' });
    assert.deepEqual(JSON.parse(after.content[0].text), {
      ok: true,
      data: { type: 'redux', state: { phase: 'result' } },
    });

    await t.test(
      'successful registered bridge dispatch stays preferred and runs once',
      async () => {
        bridge.dispatchAction = (opts) => {
          store.dispatch({ type: opts.action });
          return JSON.stringify({ dispatched: true, action: opts.action });
        };
        const result = await dispatch({ action: 'qaAcceptance/completeQaAcceptance' });
        assert.deepEqual(JSON.parse(result.content[0].text), {
          ok: true,
          data: { dispatched: true, action: 'qaAcceptance/completeQaAcceptance' },
        });
        const count = await read({ path: 'dispatchCount', storeType: 'redux' });
        assert.equal(JSON.parse(count.content[0].text).data.state, 2);
      },
    );

    await t.test(
      'bridge errors are failures and never repeat a potentially applied action',
      async () => {
        for (const failure of [
          { error: 'Reducer rejected action' },
          { __agent_error: 'State serialization failed' },
          { error: 'No Redux store', dispatched: true },
        ]) {
          bridge.dispatchAction = (opts) => {
            store.dispatch({ type: opts.action });
            return JSON.stringify(failure);
          };
          const before = await read({ path: 'dispatchCount', storeType: 'redux' });
          const result = await dispatch({ action: 'qaAcceptance/completeQaAcceptance' });
          assert.equal(result.isError, true);
          assert.deepEqual(JSON.parse(result.content[0].text), {
            ok: false,
            error: failure.__agent_error ?? failure.error,
          });
          const after = await read({ path: 'dispatchCount', storeType: 'redux' });
          assert.equal(
            JSON.parse(after.content[0].text).data.state,
            JSON.parse(before.content[0].text).data.state + 1,
          );
        }
      },
    );

    await t.test('a bridge throw after mutation does not dispatch again', async () => {
      bridge.dispatchAction = (opts) => {
        store.dispatch({ type: opts.action });
        throw new Error('Readback failed after dispatch');
      };
      const before = await read({ path: 'dispatchCount', storeType: 'redux' });
      const result = await dispatch({ action: 'qaAcceptance/completeQaAcceptance' });
      assert.equal(result.isError, true);
      assert.match(JSON.parse(result.content[0].text).error, /Readback failed after dispatch/);
      const after = await read({ path: 'dispatchCount', storeType: 'redux' });
      assert.equal(
        JSON.parse(after.content[0].text).data.state,
        JSON.parse(before.content[0].text).data.state + 1,
      );
    });

    await t.test('a detected bridge without dispatch falls back to the Provider', async () => {
      bridge.dispatchAction = undefined;
      const before = await read({ path: 'dispatchCount', storeType: 'redux' });
      const result = await dispatch({ action: 'qaAcceptance/completeQaAcceptance' });
      assert.deepEqual(JSON.parse(result.content[0].text), {
        ok: true,
        data: { dispatched: true },
      });
      const after = await read({ path: 'dispatchCount', storeType: 'redux' });
      assert.equal(
        JSON.parse(after.content[0].text).data.state,
        JSON.parse(before.content[0].text).data.state + 1,
      );
    });

    await t.test('a miss in both helpers preserves the protected dispatch refusal', async () => {
      bridge.dispatchAction = () => JSON.stringify({ error: 'No Redux store' });
      context.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = () => new Set();
      const result = await dispatch({ action: 'qaAcceptance/completeQaAcceptance' });
      assert.equal(result.isError, true);
      assert.deepEqual(JSON.parse(result.content[0].text), {
        ok: false,
        error: 'No Redux store with dispatch found. Zustand stores do not support dispatch.',
      });
    });
  } finally {
    await client.disconnect();
    await server.close();
  }
});
