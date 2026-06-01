import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instrumentTool, setToolObserver } from '../../dist/observability/instrumentation.js';

test('observer fires once per logical call with resolved status', async () => {
  const seen = [];
  setToolObserver((o) => seen.push(o));
  const tool = instrumentTool('device_press', async () => ({ ok: true, content: [{ text: '{"ok":true}' }] }));
  await tool({ ref: 'e1' });
  setToolObserver(null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, 'device_press');
  assert.equal(seen[0].status, 'PASS');
});
test('observer never throws into the tool path', async () => {
  setToolObserver(() => { throw new Error('boom'); });
  const tool = instrumentTool('cdp_status', async () => ({ ok: true, content: [{ text: '{"ok":true}' }] }));
  await assert.doesNotReject(() => tool({}));
  setToolObserver(null);
});
