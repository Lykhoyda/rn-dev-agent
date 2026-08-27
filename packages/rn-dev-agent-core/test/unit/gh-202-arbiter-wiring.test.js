import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceSessionArbiter, arbiterWrap } from '../../dist/lifecycle/device-arbiter.js';
import { addToolObserver, instrumentTool } from '../../dist/observability/instrumentation.js';

test('GH#202 arbitration refusal remains observable at the external tool boundary', async (t) => {
  const arbiter = new DeviceSessionArbiter();
  const flow = arbiter.tryAcquire('flow', 'maestro_run');
  assert.equal(flow.ok, true);
  t.after(() => arbiter.release(flow.lease));

  const observations = [];
  const detachObserver = addToolObserver((observation) => observations.push(observation));
  t.after(detachObserver);

  let handlerCalls = 0;
  const tool = instrumentTool(
    'device_press',
    arbiterWrap(
      'device_press',
      async () => {
        handlerCalls += 1;
        return { content: [{ type: 'text', text: '{"ok":true}' }] };
      },
      arbiter,
      { getUdid: () => null },
    ),
  );

  const result = await tool({ ref: 'e1' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.code, 'BUSY_FLOW_ACTIVE');
  assert.equal(handlerCalls, 0);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].tool, 'device_press');
  assert.equal(observations[0].status, 'PASS');
  assert.strictEqual(observations[0].result, result);
});
