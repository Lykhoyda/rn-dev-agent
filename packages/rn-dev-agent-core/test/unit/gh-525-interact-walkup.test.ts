// GH#525 finding 2: pressing a testID that sits on a non-pressable wrapper
// (handler on an ancestor Pressable) failed with "Component has no onPress
// handler", forcing a snapshot + coordinate-tap detour. Opt-in walkUp:true
// searches a bounded number of fiber ancestors (8) for the nearest onPress;
// default behavior (flag absent) stays byte-for-byte identical, and the walk
// itself refuses when no pressable ancestor exists within the bound. testID
// resolution semantics (strict first match) are shared with direct press and
// deliberately unchanged — the walk itself is deterministic (nearest wins).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { createInteractHandler } from '../../dist/tools/interact.js';

interface FiberSpec {
  name?: string;
  props?: Record<string, unknown>;
  children?: FiberSpec[];
}

interface SandboxFiber {
  type: { displayName: string } | null;
  memoizedProps: Record<string, unknown>;
  return: SandboxFiber | null;
  child: SandboxFiber | null;
  sibling: SandboxFiber | null;
  stateNode: null;
}

function createSandbox(opts: { fiberRoot?: SandboxFiber } = {}) {
  const sandbox: Record<string, unknown> = {
    Array,
    Object,
    JSON,
    Map,
    WeakSet,
    Error,
    Date,
    parseInt,
    parseFloat,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    String,
    Number,
    Boolean,
    RegExp,
    Symbol,
    Set,
    Promise,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  if (opts.fiberRoot) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, {}]]),
      getFiberRoots: (id: number) =>
        id === 1 ? new Set([{ current: opts.fiberRoot }]) : new Set(),
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox as Record<string, any>;
}

function buildFiber(spec: FiberSpec, parent: SandboxFiber | null = null): SandboxFiber {
  const fiber: SandboxFiber = {
    type: spec.name ? { displayName: spec.name } : null,
    memoizedProps: spec.props || {},
    return: parent,
    child: null,
    sibling: null,
    stateNode: null,
  };
  if (spec.children && spec.children.length > 0) {
    let prev: SandboxFiber | null = null;
    for (const c of spec.children) {
      const child = buildFiber(c, fiber);
      if (!fiber.child) fiber.child = child;
      else if (prev) prev.sibling = child;
      prev = child;
    }
  }
  return fiber;
}

// Pressable > CardWrapper > View[testID] — handler 2 fiber levels above the match.
function cardTree(onPress: (...args: unknown[]) => void): SandboxFiber {
  return buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: { onPress },
        children: [
          {
            name: 'CardWrapper',
            children: [{ name: 'View', props: { testID: 'externalCoverageCard_1' } }],
          },
        ],
      },
    ],
  });
}

test('#525 default (no walkUp): the refusal payload is byte-for-byte unchanged and nothing fires', () => {
  let fired = 0;
  const sandbox = createSandbox({ fiberRoot: cardTree(() => fired++) });
  const raw = sandbox.__RN_AGENT.interact({ action: 'press', testID: 'externalCoverageCard_1' });
  assert.equal(
    raw,
    '{"error":"Component has no onPress handler","component":"View","testID":"externalCoverageCard_1"}',
  );
  assert.equal(fired, 0);
});

test('#525 default (no walkUp): direct press response stays byte-for-byte unchanged', () => {
  let fired = 0;
  const root = buildFiber({
    name: 'App',
    children: [{ name: 'Button', props: { testID: 'plain-btn', onPress: () => fired++ } }],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const raw = sandbox.__RN_AGENT.interact({ action: 'press', testID: 'plain-btn' });
  assert.equal(raw, '{"success":true,"action":"press","component":"Button","testID":"plain-btn"}');
  assert.equal(fired, 1);
});

test('#525 default (no walkUp): duplicate testIDs keep strict first-match semantics', () => {
  let first = 0;
  let second = 0;
  const root = buildFiber({
    name: 'App',
    children: [
      { name: 'Button', props: { testID: 'dup-plain', onPress: () => first++ } },
      { name: 'Button', props: { testID: 'dup-plain', onPress: () => second++ } },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const raw = sandbox.__RN_AGENT.interact({ action: 'press', testID: 'dup-plain' });
  assert.equal(
    raw,
    '{"success":true,"action":"press","component":"Button","testID":"dup-plain"}',
  );
  assert.equal(first, 1);
  assert.equal(second, 0);
});

test('#525 walkUp:true presses the nearest pressable ancestor and reports the walk', () => {
  let fired = 0;
  const sandbox = createSandbox({ fiberRoot: cardTree(() => fired++) });
  const result = JSON.parse(
    sandbox.__RN_AGENT.interact({
      action: 'press',
      testID: 'externalCoverageCard_1',
      walkUp: true,
    }),
  );
  assert.equal(result.success, true);
  assert.equal(fired, 1);
  assert.equal(result.component, 'Pressable');
  assert.equal(result.walkedUpFrom, 'View');
  assert.equal(result.walkUpLevels, 2);
});

function wrapperChain(levels: number, testID: string, onPress: () => void): SandboxFiber {
  // Pressable > L1 > … > L<levels-1> > View[testID] — handler `levels` fiber
  // hops above the match. Live NativeWind evidence (GH #525 proof run): one
  // JSX wrapper costs ~3 fibers (CssInterop.View > View > RCTView), so the
  // bound is 8 — two wrapped JSX levels.
  let spec: FiberSpec = { name: 'View', props: { testID } };
  for (let i = levels - 1; i >= 1; i--) spec = { name: `L${i}`, children: [spec] };
  return buildFiber({
    name: 'App',
    children: [{ name: 'Pressable', props: { onPress }, children: [spec] }],
  });
}

test('#525 walkUp:true succeeds at exactly the 8-level bound (inclusive)', () => {
  let fired = 0;
  const sandbox = createSandbox({ fiberRoot: wrapperChain(8, 'card8', () => fired++) });
  const result = JSON.parse(
    sandbox.__RN_AGENT.interact({ action: 'press', testID: 'card8', walkUp: true }),
  );
  assert.equal(result.success, true);
  assert.equal(fired, 1);
  assert.equal(result.walkUpLevels, 8);
});

test('#525 walkUp:true still refuses when the pressable sits beyond the 8-level bound', () => {
  let fired = 0;
  const sandbox = createSandbox({ fiberRoot: wrapperChain(9, 'deep-card', () => fired++) });
  const raw = sandbox.__RN_AGENT.interact({ action: 'press', testID: 'deep-card', walkUp: true });
  assert.equal(
    raw,
    '{"error":"Component has no onPress handler","component":"View","testID":"deep-card","walkUpSearched":8}',
  );
  assert.equal(fired, 0);
});

test('#525 walkUp:true refuses when no ancestor has onPress at all', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ name: 'Wrapper', children: [{ name: 'View', props: { testID: 'inert' } }] }],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const raw = sandbox.__RN_AGENT.interact({ action: 'press', testID: 'inert', walkUp: true });
  assert.equal(
    raw,
    '{"error":"Component has no onPress handler","component":"View","testID":"inert","walkUpSearched":8}',
  );
});

test('#525 walkUp:true with a directly pressable target presses it without walking', () => {
  let direct = 0;
  let ancestor = 0;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Outer',
        props: { onPress: () => ancestor++ },
        children: [{ name: 'Button', props: { testID: 'direct-btn', onPress: () => direct++ } }],
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__RN_AGENT.interact({ action: 'press', testID: 'direct-btn', walkUp: true }),
  );
  assert.equal(result.success, true);
  assert.equal(direct, 1);
  assert.equal(ancestor, 0);
  assert.equal(result.walkedUpFrom, undefined);
});

test('#525 duplicate testIDs resolving to DISTINCT pressables: walkUp refuses and fires nothing', () => {
  let first = 0;
  let second = 0;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: { onPress: () => first++ },
        children: [{ name: 'Wrap', children: [{ name: 'View', props: { testID: 'dup' } }] }],
      },
      {
        name: 'Pressable',
        props: { onPress: () => second++ },
        children: [{ name: 'Wrap', children: [{ name: 'View', props: { testID: 'dup' } }] }],
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__RN_AGENT.interact({ action: 'press', testID: 'dup', walkUp: true }),
  );
  assert.ok(result.error, 'ambiguous walk targets must refuse');
  assert.match(result.error, /[Aa]mbiguous/);
  assert.equal(first, 0);
  assert.equal(second, 0);
});

test('#525 distinct sibling pressables sharing the SAME onPress function still refuse as ambiguous', () => {
  // Function identity is not target identity: two separate Pressables reusing
  // one callback are still two controls, so the walk must refuse.
  let fired = 0;
  const shared = () => fired++;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: { onPress: shared },
        children: [{ name: 'Wrap', children: [{ name: 'View', props: { testID: 'dup-fn' } }] }],
      },
      {
        name: 'Pressable',
        props: { onPress: shared },
        children: [{ name: 'Wrap', children: [{ name: 'View', props: { testID: 'dup-fn' } }] }],
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__RN_AGENT.interact({ action: 'press', testID: 'dup-fn', walkUp: true }),
  );
  assert.ok(result.error, 'distinct pressables must refuse even with one shared callback');
  assert.match(result.error, /[Aa]mbiguous/);
  assert.equal(fired, 0);
});

test('#525 duplicate matches sharing ONE handler (composite + host forwarding) collapse and press once', () => {
  // A composite component and its host child often both carry the forwarded
  // testID. They resolve to the same onPress, so the walk stays unambiguous.
  let fired = 0;
  const onPress = () => fired++;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: { onPress },
        children: [
          {
            name: 'Card',
            props: { testID: 'shared' },
            children: [{ name: 'View', props: { testID: 'shared' } }],
          },
        ],
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__RN_AGENT.interact({ action: 'press', testID: 'shared', walkUp: true }),
  );
  assert.equal(result.success, true);
  assert.equal(fired, 1);
});

test('#525 nested distinct pressables both matching the testID refuse as ambiguous', () => {
  // Candidates collapse only when they resolve to the exact same pressable
  // fiber. A Card and its nested Pressable are two pressable targets even on
  // one ancestor chain — refuse and let the caller pass the inner testID.
  let outer = 0;
  let inner = 0;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Card',
        props: { testID: 'fwd', onPress: () => outer++ },
        children: [{ name: 'Pressable', props: { testID: 'fwd', onPress: () => inner++ } }],
      },
    ],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__RN_AGENT.interact({ action: 'press', testID: 'fwd', walkUp: true }),
  );
  assert.ok(result.error, 'distinct pressable fibers on one chain must refuse');
  assert.match(result.error, /[Aa]mbiguous/);
  assert.equal(inner, 0);
  assert.equal(outer, 0);
});

test('#525 walkUp press passes an explicit value to the ancestor handler (GH#336 parity)', () => {
  const seen: unknown[] = [];
  const sandbox = createSandbox({ fiberRoot: cardTree((v) => seen.push(v)) });
  const result = JSON.parse(
    sandbox.__RN_AGENT.interact({
      action: 'press',
      testID: 'externalCoverageCard_1',
      walkUp: true,
      value: 'card-1',
    }),
  );
  assert.equal(result.success, true);
  assert.deepEqual(seen, ['card-1']);
});

test('#525 a throwing walked-up handler keeps the GH#250 action_executed contract', () => {
  const sandbox = createSandbox({
    fiberRoot: cardTree(() => {
      throw new Error('boom from ancestor');
    }),
  });
  const result = JSON.parse(
    sandbox.__RN_AGENT.interact({
      action: 'press',
      testID: 'externalCoverageCard_1',
      walkUp: true,
    }),
  );
  assert.equal(result.success, false);
  assert.equal(result.action_executed, true);
  assert.match(result.handler_error, /boom from ancestor/);
});

test('#525 walkUp is press-only: other actions refuse it explicitly and never dispatch', () => {
  let typed = 0;
  const root = buildFiber({
    name: 'App',
    children: [{ name: 'Input', props: { testID: 'field', onChangeText: () => typed++ } }],
  });
  const sandbox = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sandbox.__RN_AGENT.interact({ action: 'typeText', testID: 'field', text: 'x', walkUp: true }),
  );
  assert.ok(result.error, 'walkUp with a non-press action must refuse');
  assert.match(result.error, /walkUp/);
  assert.equal(typed, 0);
});

test('#525 the registered cdp_interact MCP schema exposes walkUp (source-wiring, gh-202 style)', () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const indexSrc = readFileSync(resolvePath(testDir, '../../src/index.ts'), 'utf8');
  const registration = indexSrc.match(/trackedTool\(\s*'cdp_interact',[\s\S]*?createInteractHandler\(getClient\)/);
  assert.ok(registration, 'cdp_interact registration not found in index.ts');
  assert.match(
    registration[0],
    /walkUp:\s*z\s*[\s\S]{0,40}\.boolean\(\)\s*[\s\S]{0,20}\.optional\(\)/,
    'cdp_interact schema must expose walkUp as an OPTIONAL boolean',
  );
});

test('#525 tool layer forwards walkUp to the helper call', async () => {
  let evaluated = '';
  const client = createMockClient({
    evaluate: async (expr: string) => {
      evaluated = expr;
      return { value: JSON.stringify({ success: true, action: 'press' }) };
    },
  });
  const handler = createInteractHandler(() => client);
  await handler({ action: 'press', testID: 'card', walkUp: true, animated: true });
  const opts = JSON.parse(evaluated.replace(/^__RN_AGENT\.interact\(/, '').replace(/\)$/, ''));
  assert.equal(opts.walkUp, true);
});

test('#525 tool layer omits walkUp when not requested (default unchanged)', async () => {
  let evaluated = '';
  const client = createMockClient({
    evaluate: async (expr: string) => {
      evaluated = expr;
      return { value: JSON.stringify({ success: true, action: 'press' }) };
    },
  });
  const handler = createInteractHandler(() => client);
  await handler({ action: 'press', testID: 'card', animated: true });
  const opts = JSON.parse(evaluated.replace(/^__RN_AGENT\.interact\(/, '').replace(/\)$/, ''));
  assert.ok(!('walkUp' in opts));
});
