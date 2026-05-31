import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFamily, clipThenRedact } from '../../dist/observability/events.js';

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

test('clipThenRedact deep-redacts secrets in args and payload', () => {
  const r = clipThenRedact({ password: 'hunter2supersecretvalue' }, { auth: { token: 'eyJabc.def.ghi' } });
  assert.ok(!JSON.stringify(r.args).includes('hunter2supersecretvalue'));
  assert.ok(!JSON.stringify(r.payload).includes('eyJabc.def.ghi'));
});
test('clipThenRedact clips an oversized payload and flags truncated', () => {
  const big = { blob: 'x'.repeat(40000) };
  const r = clipThenRedact({}, big);
  assert.equal(r.truncated, true);
  assert.ok(JSON.stringify(r.payload).length < 20000);
});
test('clipThenRedact fails closed: a throwing value yields {redacted:true}, never raw', () => {
  const circular = {}; circular.self = circular;
  const r = clipThenRedact({}, circular);
  assert.deepEqual(r.payload, { redacted: true });
});
