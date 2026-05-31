import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeHandler } from '../../dist/tools/observe.js';

test('observe start returns a 127.0.0.1 url; status running; stop tears down', async () => {
  const start = JSON.parse((await observeHandler({ action: 'start' })).content[0].text);
  assert.equal(start.ok, true);
  assert.match(start.data.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const status = JSON.parse((await observeHandler({ action: 'status' })).content[0].text);
  assert.equal(status.data.running, true);
  await observeHandler({ action: 'stop' });
  const after = JSON.parse((await observeHandler({ action: 'status' })).content[0].text);
  assert.equal(after.data.running, false);
});
