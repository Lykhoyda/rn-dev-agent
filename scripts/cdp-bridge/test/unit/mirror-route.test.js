import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ObservabilityServer } from '../../dist/observability/server.js';
import { Recorder } from '../../dist/observability/recorder.js';

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => resolve({ res, req }));
    req.on('error', reject);
  });
}

test('GET /api/device/mirror attaches to the manager and streams headers', async () => {
  const attached = [];
  const fakeMirror = {
    attach: (client) => {
      attached.push(client);
      client.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=rnmirror' });
      client.write('--rnmirror\r\n');
    },
    shutdown: () => {},
  };
  const server = new ObservabilityServer(new Recorder(), undefined, fakeMirror);
  const { port } = await server.start(0);
  const { res, req } = await get(port, '/api/device/mirror?t=123');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /multipart\/x-mixed-replace/);
  assert.equal(attached.length, 1);
  req.destroy();
  await server.stop();
});

test('GET /api/device/mirror without a manager → 404', async () => {
  const server = new ObservabilityServer(new Recorder());
  const { port } = await server.start(0);
  const { res, req } = await get(port, '/api/device/mirror');
  assert.equal(res.statusCode, 404);
  req.destroy();
  await server.stop();
});

test('server.stop() calls mirror.shutdown()', async () => {
  let shutdowns = 0;
  const fakeMirror = { attach: () => {}, shutdown: () => shutdowns++ };
  const server = new ObservabilityServer(new Recorder(), undefined, fakeMirror);
  await server.start(0);
  await server.stop();
  assert.equal(shutdowns, 1);
});
