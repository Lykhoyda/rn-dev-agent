import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';

interface FiberSpec {
  name?: string;
  hostType?: string;
  props?: Record<string, unknown>;
  children?: FiberSpec[];
}

const onPress = () => undefined;
const button = (testID: string): FiberSpec => ({ name: 'Pressable', props: { testID, onPress } });

function digest(children: FiberSpec[], qaCapture = false) {
  const sandbox = createSandbox({ fiberRoot: buildFiber({ name: 'App', children }) });
  return JSON.parse(
    vm.runInContext(
      `__QAREN.getTree({ interactiveOnly: true, semanticEvidence: true${qaCapture ? ', qa: true' : ''} })`,
      sandbox,
    ),
  );
}

const ids = (out: { interactive: Array<{ testID?: string }> }) =>
  out.interactive.map((entry) => entry.testID);

test('an inactive react-native-screens screen is not walked', () => {
  const out = digest([
    { name: 'Screen', props: { activityState: 0 }, children: [button('behind')] },
    { name: 'Screen', props: { activityState: 2 }, children: [button('front')] },
  ]);
  assert.deepEqual(ids(out), ['front']);
});

test('an invisible navigator scene and a display-none host view are not walked', () => {
  const out = digest([
    { name: 'MaybeScreen', props: { visible: false }, children: [button('scene')] },
    {
      hostType: 'RCTView',
      props: { style: [{ flex: 1 }, [{ display: 'none' }]] },
      children: [button('collapsed')],
    },
    { hostType: 'RCTView', props: { style: { display: 'flex' } }, children: [button('shown')] },
  ]);
  assert.deepEqual(ids(out), ['shown']);
});

test('a style that cannot be read safely never skips its subtree', () => {
  const style = {};
  Object.defineProperty(style, 'display', { get: () => 'none', enumerable: true });
  const out = digest([{ hostType: 'RCTView', props: { style }, children: [button('kept')] }]);
  assert.deepEqual(ids(out), ['kept']);
});

test('a large tree whose bulk is on inactive routes still yields a complete active digest', () => {
  const filler = (n: number): FiberSpec[] =>
    Array.from({ length: n }, (_, i) => ({ hostType: 'RCTView', props: { testID: `f${i}` } }));
  const inactive = Array.from({ length: 20 }, () => ({
    name: 'Screen',
    props: { activityState: 0 },
    children: filler(1000),
  }));
  const out = digest([
    ...inactive,
    { name: 'Screen', props: { activityState: 2 }, children: [button('active')] },
  ]);
  assert.deepEqual(ids(out), ['active']);
  assert.equal(out.truncated, undefined);
  assert.equal(out.verdict.complete, true);
});
