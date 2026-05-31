import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilityServer } from '../../dist/observability/server.js';
import { Recorder } from '../../dist/observability/recorder.js';

test('server starts on 127.0.0.1 and reports a url+port, then stops', async () => {
  const srv = new ObservabilityServer(new Recorder(10));
  const { url, port } = await srv.start();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(port > 0);
  await srv.stop();
});
