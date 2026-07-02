import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeHandler, startObserveServer } from '../../dist/tools/observe.js';
import { recorder } from '../../dist/observability/recorder.js';

// Pin a unique port for this file so parallel test files can't collide on the
// default 7333 (which would flake via the EADDRINUSE ephemeral fallback).
process.env.RN_AGENT_OBSERVE_PORT = '51733';

function parse(res) {
  return JSON.parse(res.content[0].text);
}

test('restart on a running server keeps the recorder timeline and serves again', async () => {
  recorder.record({ tool: 'device_press', params: { testID: 'x' }, status: 'PASS', latencyMs: 5 });
  const before = recorder.snapshot().length;
  assert.ok(before >= 1, 'recorder has at least the seeded event');

  const start = parse(await observeHandler({ action: 'start' }));
  assert.equal(start.ok, true);
  assert.equal(start.data.port, 51733);

  const restart = parse(await observeHandler({ action: 'restart' }));
  assert.equal(restart.ok, true);
  assert.equal(restart.data.running, true);
  assert.match(restart.data.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  // The module-global recorder survives the HTTP server restart.
  assert.equal(recorder.snapshot().length, before);

  // The restarted server actually serves.
  const status = parse(await observeHandler({ action: 'status' }));
  assert.equal(status.data.running, true);

  await observeHandler({ action: 'stop' });
});

test('restart when nothing is running starts fresh', async () => {
  const restart = parse(await observeHandler({ action: 'restart' }));
  assert.equal(restart.ok, true);
  assert.equal(restart.data.running, true);
  await observeHandler({ action: 'stop' });
});

test('startObserveServer is idempotent and returns the same port', async () => {
  const a = await startObserveServer();
  const b = await startObserveServer();
  assert.equal(a.port, b.port);
  await observeHandler({ action: 'stop' });
});

test('stop closes the listening port while the process stays alive', async () => {
  const start = parse(await observeHandler({ action: 'start' }));
  assert.equal(start.data.running, true);
  const url = start.data.url;
  // Listening while running: any HTTP status proves the socket is open
  // (200 = SPA served, 503 = SPA bundle not built in this checkout).
  const before = await fetch(`${url}/`, { signal: AbortSignal.timeout(2000) });
  assert.ok([200, 503].includes(before.status), `unexpected status ${before.status}`);
  const stop = parse(await observeHandler({ action: 'stop' }));
  assert.equal(stop.data.running, false);
  // After a tool-level stop — with this process still alive — the port must
  // refuse connections (fetch rejects with ECONNREFUSED under the hood).
  await assert.rejects(fetch(`${url}/`, { signal: AbortSignal.timeout(2000) }));
});
