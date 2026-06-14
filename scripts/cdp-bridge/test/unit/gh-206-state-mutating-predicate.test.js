// test/unit/gh-206-state-mutating-predicate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStateMutating, mayTriggerLiveCapture } from '../../dist/observability/live-device.js';

test('every INTERACTION-family tool + cdp_navigate is state-mutating', () => {
  const mutating = [
    'cdp_interact', 'device_press', 'device_fill', 'device_swipe', 'device_scroll',
    'device_longpress', 'device_pinch', 'device_back', 'device_batch',
    'device_scrollintoview', 'device_focus_next', 'device_pick_date',
    'device_pick_value', 'device_deeplink', 'cdp_navigate',
  ];
  for (const t of mutating) assert.equal(isStateMutating(t), true, `${t} should be mutating`);
});

test('read-only nav tools and introspection/lifecycle/testing are NOT state-mutating', () => {
  const readonly = [
    'cdp_navigation_state', 'cdp_nav_graph', 'cdp_component_tree', 'cdp_store_state',
    'device_screenshot', 'device_snapshot', 'cdp_status', 'maestro_run', 'observe',
  ];
  for (const t of readonly) assert.equal(isStateMutating(t), false, `${t} should NOT be mutating`);
});

// PR #296 review P2: device_find is search-only by default but taps on
// action:"click" — that tap must trigger a live refresh, find-only must not.
test('device_find is state-mutating ONLY with action:"click"', () => {
  assert.equal(isStateMutating('device_find'), false, 'find-only must not trigger');
  assert.equal(isStateMutating('device_find', {}), false, 'no action → find-only');
  assert.equal(isStateMutating('device_find', { text: 'Save' }), false, 'search args → find-only');
  assert.equal(isStateMutating('device_find', { action: 'click', text: 'Save' }), true, 'click → mutating');
});

// Registration-time gate: any tool that COULD mutate for some args must be
// wrapped so the per-call check can run — including device_find.
test('mayTriggerLiveCapture covers all mutators + device_find, excludes pure reads', () => {
  for (const t of ['cdp_interact', 'device_press', 'cdp_navigate', 'device_find']) {
    assert.equal(mayTriggerLiveCapture(t), true, `${t} must be wrapped`);
  }
  for (const t of ['cdp_navigation_state', 'cdp_component_tree', 'device_screenshot', 'cdp_status']) {
    assert.equal(mayTriggerLiveCapture(t), false, `${t} must NOT be wrapped`);
  }
});
