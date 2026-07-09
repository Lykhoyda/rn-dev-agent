import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, buildFiber, INJECTED_HELPERS } from './helpers/inject-harness.js';

test('harness: createSandbox exposes __RN_AGENT and presses by testID', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ name: 'Pressable', props: { testID: 'x', onPress() {} } }],
  });
  const s = createSandbox({ fiberRoot: root });
  assert.ok(s.__RN_AGENT, 'sandbox exposes __RN_AGENT');
  const r = JSON.parse(s.__RN_AGENT.interact({ action: 'press', testID: 'x' }));
  assert.equal(r.success, true);
});

test('harness: buildFiber supports text and hostType nodes', () => {
  assert.equal(buildFiber({ text: 'hello' }).memoizedProps, 'hello');
  assert.equal(buildFiber({ hostType: 'RCTText' }).type, 'RCTText');
  assert.equal(typeof INJECTED_HELPERS, 'string');
});
