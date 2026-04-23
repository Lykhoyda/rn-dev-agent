// B143: cdp_component_tree must walk ALL registered React renderers, not
// just the first one with roots. findActiveRenderer returns early on the
// first non-empty rendererID, which on apps with Bridgeless + Reanimated
// (or main + LogBox split) is usually the tiny LogBox shell, not the
// main app tree. The filter BFS now seeds its queue from every renderer.
//
// This test exercises the TS mirror `findAllRootFibersForTest`; a
// regression guard at the bottom scans the injected JS string for the
// multi-renderer-loop tokens so drift between the two copies fails loudly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findAllRootFibersForTest, INJECTED_HELPERS } from '../../dist/injected-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeRootsMap(fibers) {
  const items = fibers.map((f) => ({ current: f }));
  return {
    size: items.length,
    values() {
      let i = 0;
      return {
        next() {
          if (i >= items.length) return { done: true, value: undefined };
          return { done: false, value: items[i++] };
        },
      };
    },
  };
}

function makeHook(rendererMap) {
  return {
    getFiberRoots(ri) {
      return rendererMap[ri] ?? null;
    },
  };
}

test('B143: no hook returns empty array', () => {
  assert.deepEqual(findAllRootFibersForTest(null), []);
  assert.deepEqual(findAllRootFibersForTest(undefined), []);
  assert.deepEqual(findAllRootFibersForTest({}), []);
});

test('B143: hook without getFiberRoots returns empty', () => {
  assert.deepEqual(findAllRootFibersForTest({ other: 'prop' }), []);
});

test('B143: single renderer with single root returns one entry', () => {
  const fiber = { tag: 'root1' };
  const hook = makeHook({ 1: makeRootsMap([fiber]) });
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 1);
  assert.equal(result[0].rendererId, 1);
  assert.equal(result[0].fiber, fiber);
});

test('B143: single renderer with multiple roots returns all roots', () => {
  const f1 = { tag: 'root1-a' };
  const f2 = { tag: 'root1-b' };
  const hook = makeHook({ 1: makeRootsMap([f1, f2]) });
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((r) => r.rendererId), [1, 1]);
  assert.deepEqual(result.map((r) => r.fiber), [f1, f2]);
});

test('B143: multi-renderer (1 + 2) returns union — the B143 core case', () => {
  const logboxFiber = { tag: 'logbox-shell' };
  const appFiber1 = { tag: 'app-main' };
  const appFiber2 = { tag: 'app-secondary' };
  const hook = makeHook({
    1: makeRootsMap([logboxFiber]),
    2: makeRootsMap([appFiber1, appFiber2]),
  });
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((r) => r.rendererId), [1, 2, 2]);
  assert.deepEqual(result.map((r) => r.fiber), [logboxFiber, appFiber1, appFiber2]);
});

test('B143: sparse rendererIDs (1, 4) both included', () => {
  const f1 = { tag: 'r1' };
  const f4 = { tag: 'r4' };
  const hook = makeHook({ 1: makeRootsMap([f1]), 4: makeRootsMap([f4]) });
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((r) => r.rendererId), [1, 4]);
});

test('B143: empty renderer IDs are skipped', () => {
  const f2 = { tag: 'r2' };
  const hook = {
    getFiberRoots(ri) {
      if (ri === 2) return makeRootsMap([f2]);
      if (ri === 3) return { size: 0, values: () => ({ next: () => ({ done: true }) }) };
      return null;
    },
  };
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 1);
  assert.equal(result[0].rendererId, 2);
});

test('B143: null root in the map is filtered out', () => {
  // Edge: getFiberRoots can hand back a Set where .values().next() returns
  // null/undefined values in pathological cases. Don't push them.
  const hook = {
    getFiberRoots(ri) {
      if (ri === 1) {
        return {
          size: 2,
          values() {
            let i = 0;
            return {
              next() {
                if (i === 0) { i++; return { done: false, value: null }; }
                if (i === 1) { i++; return { done: false, value: { current: { tag: 'ok' } } }; }
                return { done: true };
              },
            };
          },
        };
      }
      return null;
    },
  };
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 1);
  assert.equal(result[0].fiber.tag, 'ok');
});

test('B143: root without .current is filtered out', () => {
  const hook = {
    getFiberRoots(ri) {
      if (ri === 1) {
        return {
          size: 2,
          values() {
            let i = 0;
            return {
              next() {
                if (i === 0) { i++; return { done: false, value: { /* no current */ } }; }
                if (i === 1) { i++; return { done: false, value: { current: { tag: 'real' } } }; }
                return { done: true };
              },
            };
          },
        };
      }
      return null;
    },
  };
  const result = findAllRootFibersForTest(hook);
  assert.equal(result.length, 1);
  assert.equal(result[0].fiber.tag, 'real');
});

test('B143 A3 (Gemini 80): per-renderer throw does NOT poison the union (TS mirror contract)', () => {
  // Current TS mirror does bubble, but the injected IIFE now has try/catch
  // guards around each renderer access (see regression guard below).
  // If the TS mirror is hardened later, update this test to assert partial
  // results rather than throw.
  const hook = {
    getFiberRoots(ri) {
      if (ri === 2) throw new Error('boom');
      return null;
    },
  };
  assert.throws(() => findAllRootFibersForTest(hook), /boom/);
});

// ── Regression guard against IIFE/TS-mirror drift ─────────────────────

test('B143: injected helpers contain findAllRootFibers with 1..5 loop', () => {
  const src = INJECTED_HELPERS;
  assert.match(src, /function findAllRootFibers\(\)/, 'findAllRootFibers function missing from injected helpers');
  assert.match(src, /for \(var ri = 1; ri <= 5; ri\+\+\)/, '1..5 renderer loop missing');
  assert.match(src, /hook\.getFiberRoots\(ri\)/, 'hook.getFiberRoots(ri) iteration missing');
  assert.match(src, /out\.push\(\{ rendererId: ri, fiber: v\.value\.current \}\)/, 'out.push signature drifted from TS mirror');
});

test('B143: filter path in getTree uses findAllRootFibers (no single-root short-circuit)', () => {
  const src = INJECTED_HELPERS;
  // The filter branch must populate its BFS queue from allRoots, not from
  // the first renderer's first root.
  assert.match(src, /var allRoots = findAllRootFibers\(\);/, 'filter path did not switch to findAllRootFibers');
  assert.match(src, /for \(var qi = 0; qi < allRoots\.length; qi\+\+\) queue\.push\(allRoots\[qi\]\.fiber\);/, 'filter path queue init drifted');
  // And the result payload exposes rootsSeeded for observability.
  assert.match(src, /rootsSeeded: allRoots\.length/, 'rootsSeeded metric missing from filter response');
});

test('B143 A1 (Gemini 85): hasErrorOverlay check runs across all renderers', () => {
  // Pre-A1 this only checked the first renderer's root. An Error Boundary
  // mounted on a later renderer would be missed.
  const src = INJECTED_HELPERS;
  assert.match(src, /var overlayRoots = findAllRootFibers\(\);/, 'error-overlay check did not switch to findAllRootFibers');
  assert.match(src, /hasErrorOverlay\(overlayRoots\[oi\]\.fiber\)/, 'error-overlay loop did not walk each renderer root');
});

test('B143 A3 (Gemini 80): IIFE wraps per-renderer getFiberRoots in try/catch', () => {
  // Guards against teardown / HMR / worklet-init races on a single renderer
  // throwing and poisoning the whole union.
  const src = INJECTED_HELPERS;
  // The guard lives inside the findAllRootFibers function body specifically.
  const slice = src.split('function findAllRootFibers')[1]?.split('function ')[0] ?? '';
  assert.match(slice, /try \{/, 'findAllRootFibers missing try guard around getFiberRoots');
  assert.match(slice, /catch \(_\)/, 'findAllRootFibers missing per-renderer catch');
});

test('B143 Codex #1 (conf 82): scan budget scales with rootsSeeded count', () => {
  // With N roots, budget = min(5000, 2000 * N) so later renderers don't
  // starve when renderer 1 has a deep/wide subtree.
  const src = INJECTED_HELPERS;
  assert.match(src, /var scanBudget = Math\.min\(5000, 2000 \* Math\.max\(1, allRoots\.length\)\)/, 'scan budget scaling missing or drifted');
  assert.match(src, /scanned < scanBudget/, 'BFS loop did not switch to scanBudget variable');
});
