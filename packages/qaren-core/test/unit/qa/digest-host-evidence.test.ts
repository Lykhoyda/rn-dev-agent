import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildFiber, createSandbox, INJECTED_HELPERS } from '../helpers/inject-harness.js';
import { PRIVATE_INPUT_LIMITS } from '../../../dist/qa/private-input-limits.js';

const { maxHosts } = PRIVATE_INPUT_LIMITS;

interface FiberSpec {
  name?: string;
  hostType?: string;
  props?: Record<string, unknown>;
  children?: FiberSpec[];
}

function readDigest(sandbox: vm.Context, semanticEvidence = true) {
  return JSON.parse(
    vm.runInContext(
      `__QAREN.getTree({ interactiveOnly: true, semanticEvidence: ${semanticEvidence} })`,
      sandbox,
    ),
  );
}

function digest(children: FiberSpec[]) {
  return readDigest(createSandbox({ fiberRoot: buildFiber({ name: 'Screen', children }) }));
}

const handler = () => assert.fail('capturing evidence must never invoke handlers');

test('opt-in host evidence includes a heading-only host without changing the legacy digest', () => {
  const sandbox = createSandbox({
    fiberRoot: buildFiber({
      hostType: 'RCTText',
      props: {
        testID: 'title',
        nativeID: 'native-title',
        role: 'heading',
        accessibilityLabel: 'Private heading',
        value: 'Private value',
      },
    }),
  });
  const legacy = readDigest(sandbox, false);
  const { hostEvidence, ...rest } = readDigest(sandbox);
  assert.deepEqual(rest, legacy);
  assert.equal(legacy.hostEvidence, undefined);
  assert.deepEqual(hostEvidence, {
    hosts: [
      {
        testID: 'title',
        nativeID: 'native-title',
        role: 'heading',
        roleSource: 'role',
        capabilities: {},
      },
    ],
    complete: true,
  });
  assert.deepEqual(legacy.interactive, []);
});

test('only actual hosts contribute evidence, including unidentified and independent same-ID hosts', () => {
  const result = digest([
    { name: 'Heading', props: { testID: 'pretend', role: 'heading' } },
    { name: 'RCTText', props: { testID: 'also-pretend', accessibilityRole: 'header' } },
    { name: 'Pressable', props: { testID: 'missing-host', onPress: handler } },
    {
      name: 'Pressable',
      props: { testID: 'shared', onPress: handler },
      children: [
        {
          hostType: 'RCTView',
          props: { testID: 'shared', onPress: handler },
          children: [{ hostType: 'RCTText', props: { testID: 'shared', role: 'heading' } }],
        },
      ],
    },
    { hostType: 'RCTView', props: { nativeID: 'shared' } },
    { hostType: 'RCTView' },
  ]);
  assert.equal(result.hostEvidence.complete, true);
  assert.deepEqual(result.hostEvidence.hosts, [
    { nativeID: 'shared', role: null, roleSource: 'none', capabilities: {} },
    { role: null, roleSource: 'none', capabilities: {} },
    { testID: 'shared', role: null, roleSource: 'none', capabilities: { press: true } },
    { testID: 'shared', role: 'heading', roleSource: 'role', capabilities: {} },
  ]);
});

test('capabilities are observed positives, never negative claims about opaque native behavior', () => {
  const result = digest([
    { hostType: 'RCTView', props: { onPress: handler } },
    { hostType: 'RCTView', props: { onClick: handler } },
    { hostType: 'RCTView', props: { onPress: true, onClick: '[Function]' } },
    { hostType: 'NativeOpaqueControl', props: { onChangeText: handler, onChange: handler } },
    { hostType: 'NativeOpaqueControl', props: { role: 'button' } },
    { hostType: 'AndroidTextInput' },
    { hostType: 'RCTSinglelineTextInputView', props: { editable: true } },
    { name: 'TextInput', props: { onChangeText: handler } },
  ]);
  assert.equal(result.hostEvidence.complete, true);
  assert.deepEqual(
    result.hostEvidence.hosts.map((host) => host.capabilities),
    [{ press: true }, { press: true }, {}, {}, {}, { fill: true }, { fill: true }],
  );
});

test('host disabled and read-only positives stay separate from forwarded parent digest state', () => {
  const result = digest([
    {
      name: 'Pressable',
      props: { testID: 'save', disabled: true, onPress: handler },
      children: [{ hostType: 'RCTView', props: { testID: 'save', onPress: handler } }],
    },
    { hostType: 'RCTView', props: { disabled: true, onPress: handler } },
    { hostType: 'RCTView', props: { accessibilityState: { disabled: true } } },
    { hostType: 'RCTView', props: { 'aria-disabled': true } },
    { hostType: 'AndroidTextInput', props: { editable: false, onChangeText: handler } },
    { hostType: 'AndroidTextInput', props: { readOnly: true } },
    { hostType: 'AndroidTextInput', props: { 'aria-readonly': true } },
    { hostType: 'AndroidTextInput', props: { disabled: true } },
  ]);
  assert.equal(result.interactive.find((entry) => entry.testID === 'save').disabled, true);
  assert.deepEqual(result.hostEvidence.hosts, [
    { role: null, roleSource: 'none', capabilities: { press: true }, disabled: true },
    { role: null, roleSource: 'none', capabilities: {}, disabled: true },
    { role: null, roleSource: 'none', capabilities: {}, disabled: true },
    { role: null, roleSource: 'none', capabilities: {}, readOnly: true },
    { role: null, roleSource: 'none', capabilities: {}, readOnly: true },
    { role: null, roleSource: 'none', capabilities: {}, readOnly: true },
    { role: null, roleSource: 'none', capabilities: { fill: true }, disabled: true },
    { testID: 'save', role: null, roleSource: 'none', capabilities: { press: true } },
  ]);
});

test('unsupported editability values do not establish a positive fill capability', () => {
  for (const props of [
    { editable: 'false' },
    { editable: 0 },
    { readOnly: 'true' },
    { 'aria-readonly': 'true' },
  ]) {
    assert.deepEqual(digest([{ hostType: 'AndroidTextInput', props }]).hostEvidence.hosts, [
      { role: null, roleSource: 'none', capabilities: {} },
    ]);
  }
});

test('explicit roles retain owner precedence, normalization and provenance without name inference', () => {
  const result = digest([
    { hostType: 'RCTView', props: { role: 'heading', accessibilityRole: 'button' } },
    { hostType: 'RCTView', props: { role: null, accessibilityRole: 'header' } },
    { hostType: 'RCTView', props: { accessibilityRole: 'image' } },
    { hostType: 'RCTView', props: { role: 'none', accessibilityRole: 'button' } },
    { hostType: 'RCTText' },
    { hostType: 'Button' },
    { hostType: 'TextInput' },
  ]);
  assert.equal(result.hostEvidence.complete, true);
  assert.deepEqual(
    result.hostEvidence.hosts.map(({ role, roleSource }) => ({ role, roleSource })),
    [
      { role: 'heading', roleSource: 'role' },
      { role: 'header', roleSource: 'accessibilityRole' },
      { role: 'img', roleSource: 'accessibilityRole' },
      { role: 'none', roleSource: 'role' },
      { role: null, roleSource: 'none' },
      { role: null, roleSource: 'none' },
      { role: null, roleSource: 'none' },
    ],
  );
});

test('unsupported selected roles are unknown and incomplete, never coerced or bypassed', () => {
  const unsupported = ['', false, 0, 7, [], ['heading'], {}, 'invented', 'Heading', 'toString'];
  for (const value of unsupported) {
    for (const props of [
      { role: value, accessibilityRole: 'button' },
      { accessibilityRole: value },
    ]) {
      const result = digest([{ hostType: 'RCTText', props: { testID: 'title', ...props } }]);
      assert.deepEqual(result.hostEvidence, {
        hosts: [
          {
            testID: 'title',
            role: null,
            roleSource: 'role' in props ? 'role' : 'accessibilityRole',
            capabilities: {},
          },
        ],
        complete: false,
      });
    }
  }
});

test('unsupported identities keep their host observation and mark coverage incomplete', () => {
  for (const field of ['testID', 'nativeID']) {
    for (const value of [12, false, {}, ['save']]) {
      const result = digest([{ hostType: 'RCTView', props: { [field]: value, onPress: handler } }]);
      assert.deepEqual(result.hostEvidence, {
        hosts: [{ role: null, roleSource: 'none', capabilities: { press: true } }],
        complete: false,
      });
    }
  }
});

test('host tag identifies native object types but similarly named composites are not hosts', () => {
  const root = buildFiber({ name: 'RCTText', props: { role: 'heading', testID: 'title' } });
  Object.assign(root, { tag: 5 });
  assert.deepEqual(readDigest(createSandbox({ fiberRoot: root })).hostEvidence, {
    hosts: [{ testID: 'title', role: 'heading', roleSource: 'role', capabilities: {} }],
    complete: true,
  });
  Object.assign(root, { tag: 0 });
  assert.deepEqual(readDigest(createSandbox({ fiberRoot: root })).hostEvidence, {
    hosts: [],
    complete: true,
  });
});

test('host evidence saturates at the shared host cap and discloses incomplete coverage without changing the digest', () => {
  // 336 is the measured Home plus lazily mounted Tasks tab of the workspace test app.
  for (const count of [336, maxHosts - 1, maxHosts, maxHosts + 50]) {
    const sandbox = createSandbox({
      fiberRoot: buildFiber({
        name: 'Screen',
        children: Array.from({ length: count }, (_, i) => ({
          hostType: 'RCTText',
          props: { testID: `heading-${i}`, role: 'heading' },
        })),
      }),
    });
    const legacy = readDigest(sandbox, false);
    const { hostEvidence, ...rest } = readDigest(sandbox);
    assert.deepEqual(rest, legacy);
    assert.deepEqual(legacy.interactive, []);
    assert.equal(legacy.verdict.complete, true);
    assert.equal(hostEvidence.hosts.length, Math.min(count, maxHosts));
    assert.equal(hostEvidence.complete, count < maxHosts);
    if (count === 336) assert.equal(hostEvidence.complete, true);
  }
});

test('host evidence uses the same node budget and never finds hosts past the interactive scan', () => {
  const result = digest([
    ...Array.from({ length: 2000 }, () => ({ name: 'Wrapper' })),
    { hostType: 'RCTText', props: { testID: 'past-budget', role: 'heading' } },
  ]);
  assert.equal(result.totalNodes, 2000);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.hostEvidence, { hosts: [], complete: false });
});

test('the interactive entry cap also withholds host completeness and does not trigger another scan', () => {
  const result = digest([
    ...Array.from({ length: 200 }, () => ({ name: 'Pressable', props: { onPress: handler } })),
    { hostType: 'RCTText', props: { testID: 'past-cap', role: 'heading' } },
  ]);
  assert.equal(result.interactive.length, 200);
  assert.equal(result.totalNodes, 201);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.hostEvidence, { hosts: [], complete: false });
});

test('the interactive deadline also bounds host evidence', () => {
  const sandbox = createSandbox({ fiberRoot: buildFiber({ hostType: 'RCTText' }) });
  let reads = 0;
  Object.assign(sandbox, { Date: { now: () => (reads++ === 0 ? 0 : 3001) } });
  const result = readDigest(sandbox);
  assert.equal(result.totalNodes, 0);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.hostEvidence, { hosts: [], complete: false });
});

test('renderer enumeration failures retain observed hosts but withhold completeness', () => {
  const root = buildFiber({ hostType: 'RCTView', props: { testID: 'observed' } });
  for (const mode of ['throws', 'unregistered', 'invalid-registry', 'extra-roots']) {
    const sandbox = createSandbox();
    Object.assign(sandbox, {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        renderers:
          mode === 'unregistered'
            ? undefined
            : mode === 'invalid-registry'
              ? {}
              : new Map([
                  [1, {}],
                  [29, {}],
                ]),
        getFiberRoots(id: number) {
          if (mode === 'throws' && id === 29) throw new Error('renderer teardown');
          return id === 1 ? new Set([{ current: root }]) : new Set();
        },
      },
      __QAREN_EXTRA_ROOTS__:
        mode === 'extra-roots'
          ? () => {
              throw new Error('unreadable');
            }
          : undefined,
    });
    const result = readDigest(sandbox);
    assert.deepEqual(
      result.hostEvidence,
      {
        hosts: [{ testID: 'observed', role: null, roleSource: 'none', capabilities: {} }],
        complete: false,
      },
      mode,
    );
  }
});

test('missing renderers and app error overlays return incomplete opt-in evidence only', () => {
  for (const sandbox of [
    createSandbox(),
    createSandbox({ fiberRoot: buildFiber({ name: 'LogBox' }) }),
  ]) {
    const legacy = readDigest(sandbox, false);
    const { hostEvidence, ...rest } = readDigest(sandbox);
    assert.deepEqual(rest, legacy);
    assert.deepEqual(hostEvidence, { hosts: [], complete: false });
  }
});

test('roots disappearing before the interactive scan cannot establish complete host evidence', () => {
  const root = buildFiber({ hostType: 'RCTView' });
  const sandbox = createSandbox();
  let reads = 0;
  Object.assign(sandbox, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      renderers: new Map([[1, {}]]),
      getFiberRoots(id: number) {
        return new Set(id === 1 && reads++ === 0 ? [{ current: root }] : []);
      },
    },
  });
  assert.deepEqual(readDigest(sandbox).hostEvidence, { hosts: [], complete: false });
});

test('hosts across renderer roots are included once per actual fiber, not deduplicated by ID', () => {
  const a = buildFiber({ hostType: 'RCTText', props: { testID: 'shared', role: 'heading' } });
  const b = buildFiber({ hostType: 'RCTText', props: { testID: 'shared', role: 'heading' } });
  const sandbox = createSandbox();
  Object.assign(sandbox, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      renderers: new Map([
        [1, {}],
        [29, {}],
      ]),
      getFiberRoots(id: number) {
        return new Set(
          id === 1 ? [{ current: a }] : id === 29 ? [{ current: a }, { current: b }] : [],
        );
      },
    },
  });
  assert.deepEqual(readDigest(sandbox).hostEvidence, {
    hosts: [
      { testID: 'shared', role: 'heading', roleSource: 'role', capabilities: {} },
      { testID: 'shared', role: 'heading', roleSource: 'role', capabilities: {} },
    ],
    complete: true,
  });
});

test('current helper replaces a warm version 77 producer and reinjection stays idempotent', () => {
  const sandbox = createSandbox({ fiberRoot: buildFiber({ hostType: 'RCTView' }) });
  Object.assign(sandbox, { __QAREN: { __v: 77 } });
  vm.runInContext(INJECTED_HELPERS, sandbox);
  assert.equal(vm.runInContext('__QAREN.__v', sandbox), 87);
  assert.equal(readDigest(sandbox).hostEvidence.complete, true);
  const producer = vm.runInContext('__QAREN.getTree', sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  assert.equal(vm.runInContext('__QAREN.getTree', sandbox), producer);
});
