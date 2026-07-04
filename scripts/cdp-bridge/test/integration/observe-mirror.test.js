// scripts/cdp-bridge/test/integration/observe-mirror.test.js
// End-to-end over real HTTP: ObservabilityServer + real MirrorManager + fake
// source. Two clients must both receive well-formed multipart JPEG parts;
// closing one must not stall the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ObservabilityServer } from '../../dist/observability/server.js';
import { Recorder } from '../../dist/observability/recorder.js';
import { MirrorManager } from '../../dist/observability/mirror/manager.js';

const jpeg = (fill) =>
  Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64, fill), Buffer.from([0xff, 0xd9])]);

test('two mirror clients stream frames over real HTTP', async () => {
  let sink = null;
  const source = {
    pipeline: 'idb',
    nominalFps: 20,
    start(s) {
      sink = s;
    },
    stop() {
      sink = null;
    },
  };
  const mirror = new MirrorManager({
    resolveTarget: async () => ({ ok: true, target: { platform: 'ios', deviceId: 'U' } }),
    createSource: async () => source,
    pushStatus: () => {},
    graceMs: 50,
  });
  const server = new ObservabilityServer(new Recorder(), undefined, mirror);
  const { port } = await server.start(0);

  const connect = () =>
    new Promise((resolve, reject) => {
      const chunks = [];
      const req = http.get({ host: '127.0.0.1', port, path: '/api/device/mirror' }, (res) => {
        assert.equal(res.statusCode, 200);
        res.on('data', (c) => chunks.push(c));
        resolve({ req, res, chunks });
      });
      req.on('error', reject);
    });

  const a = await connect();
  const b = await connect();
  // Wait for the async pipeline start to reach the fake source.
  for (let i = 0; i < 50 && !sink; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(sink, 'source started');

  sink.onFrame(jpeg(1));
  sink.onFrame(jpeg(2));
  await new Promise((r) => setTimeout(r, 100));

  for (const { chunks } of [a, b]) {
    const body = Buffer.concat(chunks).toString('latin1');
    const parts = body.split('--rnmirror').filter((p) => p.includes('Content-Type: image/jpeg'));
    assert.ok(parts.length >= 2, `client saw ${parts.length} frames`);
  }

  a.req.destroy();
  sink.onFrame(jpeg(3));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(
    Buffer.concat(b.chunks).includes(jpeg(3)),
    'surviving client still receives after peer disconnect',
  );

  b.req.destroy();
  await server.stop();
});
