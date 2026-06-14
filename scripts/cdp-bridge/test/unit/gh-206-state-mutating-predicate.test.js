// test/unit/gh-206-state-mutating-predicate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStateMutating } from '../../dist/observability/live-device.js';

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
