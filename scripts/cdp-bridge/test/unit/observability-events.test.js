import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFamily,
  clipThenRedact,
  mapObservation,
  unwrapResult,
} from '../../dist/observability/events.js';

function envelope(data) {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] };
}

test('mapObservation redacts secrets + PII embedded in error.message (no raw secret reaches the wire)', () => {
  const ev = mapObservation(1, {
    tool: 'cdp_auto_login',
    params: {},
    status: 'FAIL',
    latencyMs: 3,
    error:
      'auto-login failed (401): {"token":"tok_abcdefghij1234567890XYZ","email":"victim@example.com"} Bearer sk-livesecretvalue1234567890',
  });
  assert.ok(ev.error, 'error field present');
  assert.ok(
    !ev.error.message.includes('tok_abcdefghij1234567890XYZ'),
    'keyed token must be redacted',
  );
  assert.ok(!ev.error.message.includes('victim@example.com'), 'email must be redacted');
  assert.ok(
    !ev.error.message.includes('sk-livesecretvalue1234567890'),
    'bearer secret must be redacted',
  );
  assert.ok(/REDACTED|PII_REDACTED/.test(ev.error.message), 'redaction markers present');
});

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
  const r = clipThenRedact(
    { password: 'hunter2supersecretvalue' },
    { auth: { token: 'eyJabc.def.ghi' } },
  );
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
  const circular = {};
  circular.self = circular;
  const r = clipThenRedact({}, circular);
  assert.deepEqual(r.payload, { redacted: true });
});

test('mapObservation builds an AgentEvent with seq, family, summary, redaction, ghost', () => {
  const e = mapObservation(7, {
    tool: 'device_fill',
    params: { ref: 'e5', text: 'secretpassword1234567890' },
    status: 'PASS',
    latencyMs: 42,
    result: { ok: true },
    ghost: { attempted: true, outcome: 'recovered' },
  });
  assert.equal(e.seq, 7);
  assert.equal(e.tool, 'device_fill');
  assert.equal(e.family, 'interaction');
  assert.equal(e.ok, true);
  assert.equal(e.durationMs, 42);
  assert.deepEqual(e.ghost, { attempted: true, outcome: 'recovered' });
  assert.ok(typeof e.summary === 'string' && e.summary.length > 0);
});

test('unwrapResult parses the real MCP envelope and returns {ok,data}', () => {
  const r = unwrapResult(envelope({ routeName: 'TasksTab' }));
  assert.deepEqual(r, { ok: true, data: { routeName: 'TasksTab' } });
});
test('unwrapResult returns undefined for non-envelope / unparseable input', () => {
  assert.equal(unwrapResult(undefined), undefined);
  assert.equal(unwrapResult({ data: { x: 1 } }), undefined);
  assert.equal(unwrapResult({ content: [{ text: '{not json' }] }), undefined);
});

test('mapObservation unwraps the real MCP envelope: payload is the clean data, not the wrapper', () => {
  const e = mapObservation(11, {
    tool: 'cdp_navigation_state',
    params: {},
    status: 'PASS',
    latencyMs: 8,
    result: {
      content: [
        { type: 'text', text: JSON.stringify({ ok: true, data: { routeName: 'TasksTab' } }) },
      ],
    },
  });
  assert.deepEqual(e.payload, { routeName: 'TasksTab' });
  assert.ok(!JSON.stringify(e.payload).includes('content'));
  assert.ok(!JSON.stringify(e.payload).includes('\\"ok\\"'));
});
