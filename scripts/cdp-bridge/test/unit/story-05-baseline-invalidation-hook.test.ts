// Story 05 (#386) final-review fix: a mutation via a non-runNative tool
// (cdp_interact, cdp_navigate, maestro_run, …) left the tap-retry baseline
// hash pointed at the pre-mutation screen, so a later tap's "did the UI
// change" check could give a false negative and trigger a wrong-element
// re-tap. toolInvalidatesRetryBaseline is the classifier gating the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolInvalidatesRetryBaseline } from '../../dist/observability/live-device.js';

test('toolInvalidatesRetryBaseline: TRUE for screen-mutating tools that bypass runNative', () => {
  for (const t of [
    'cdp_interact',
    'cdp_navigate',
    'device_deeplink',
    'maestro_run',
    'maestro_test_all',
    'cdp_auto_login',
    'cdp_reload',
    'cdp_restart',
    'cdp_dispatch',
    'device_reset_state',
    'cdp_evaluate',
    'cdp_mmkv',
    'cdp_run_action',
    // device_fill's JS-first path (attemptJsFill) returns before any runNative
    // settle, so it never manages the baseline — the hook must invalidate after
    // it. The native fill path already invalidates on its own, so this is a
    // no-op there and correct on the JS path.
    'device_fill',
    // PR #459 review (Codex P2): swipe/scroll take the iOS fastSwipe path that
    // returns BEFORE any settle → stale baseline. pinch/back/scrollintoview do
    // settle, but as non-retry-eligible verbs their settle already invalidates
    // (hierarchyChanged===undefined), so invalidating here is a harmless no-op.
    'device_swipe',
    'device_scroll',
    'device_scrollintoview',
    'device_pinch',
    'device_back',
  ]) {
    assert.equal(
      toolInvalidatesRetryBaseline(t),
      true,
      `${t} mutates the screen outside a settle-managed runNative path and must invalidate the retry baseline`,
    );
  }
});

test('toolInvalidatesRetryBaseline: FALSE only for tools that leave a valid current-screen baseline for the next tap', () => {
  for (const t of ['device_press', 'device_longpress', 'device_batch']) {
    assert.equal(
      toolInvalidatesRetryBaseline(t),
      false,
      `${t} refreshes the baseline to the current screen via settle — invalidating post-hoc would erase it`,
    );
  }
});

test('toolInvalidatesRetryBaseline: device_find is FALSE for both click and non-click', () => {
  assert.equal(toolInvalidatesRetryBaseline('device_find'), false);
  assert.equal(toolInvalidatesRetryBaseline('device_find', { text: 'x' }), false);
  assert.equal(toolInvalidatesRetryBaseline('device_find', { action: 'click' }), false);
});

test('toolInvalidatesRetryBaseline: FALSE for pure reads', () => {
  for (const t of [
    'cdp_component_tree',
    'cdp_store_state',
    'cdp_navigation_state',
    'cdp_nav_graph',
    'cdp_status',
    'device_screenshot',
    'device_snapshot',
  ]) {
    assert.equal(toolInvalidatesRetryBaseline(t), false, `${t} is a read and must not invalidate`);
  }
});

// Source guard: the classifier must actually be wired at the trackedTool
// boundary, not just defined, otherwise the fix is dead code. Anchored to the
// `try { result = await base(...a); } finally { ... }` shape around it (not a
// bare substring match) so a duplicate/dead-code occurrence elsewhere in the
// file cannot satisfy this guard, and so the invalidation is proven to run
// even when the dispatched tool call throws.
test('source guard: trackedTool invalidates the retry baseline inside the base(...a) try/finally', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '../../dist/index.js'), 'utf-8');
  assert.match(
    src,
    /try\s*\{\s*result = await base\(\.\.\.a\);\s*\}\s*finally\s*\{[\s\S]{0,900}?if\s*\(\s*toolInvalidatesRetryBaseline\(name,\s*args\)\s*\)\s*invalidateLastSnapshotHash\(\);[\s\S]{0,50}?\}/,
    'invalidateLastSnapshotHash() must run inside the finally around base(...a), gated on toolInvalidatesRetryBaseline(name, args) — so it fires even if the dispatched tool call throws',
  );
});
