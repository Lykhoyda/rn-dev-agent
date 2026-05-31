import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFamily } from '../../dist/observability/events.js';

test('classifyFamily maps tool names to families', () => {
  assert.equal(classifyFamily('device_press'), 'interaction');
  assert.equal(classifyFamily('device_fill'), 'interaction');
  assert.equal(classifyFamily('cdp_navigation_state'), 'navigation');
  assert.equal(classifyFamily('cdp_store_state'), 'introspection');
  assert.equal(classifyFamily('device_screenshot'), 'introspection');
  assert.equal(classifyFamily('cdp_status'), 'lifecycle');
  assert.equal(classifyFamily('maestro_run'), 'testing');
  assert.equal(classifyFamily('something_else'), 'other');
});
