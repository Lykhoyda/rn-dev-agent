// test/unit/gh-206-live-screenshot-endpoint.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../../dist/observability/recorder.js';
import { ObservabilityServer } from '../../dist/observability/server.js';

async function get(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { host: `127.0.0.1:${port}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ctype: res.headers.get('content-type'), buf };
}

test('GET /api/live-screenshot/<seq> serves current live frame; 404 when none', async () => {
  const rec = new Recorder();
  const srv = new ObservabilityServer(rec);
  const { port } = await srv.start(0);
  try {
    const miss = await get(port, '/api/live-screenshot/1');
    assert.equal(miss.status, 404, '404 before any live frame');

    rec.attach(() => {});
    rec.pushLive({ shot: { buf: Buffer.from([0xff, 0xd8, 0xff]), contentType: 'image/jpeg' } });

    const a = await get(port, '/api/live-screenshot/1');
    assert.equal(a.status, 200);
    assert.equal(a.ctype, 'image/jpeg');
    assert.deepEqual(a.buf, Buffer.from([0xff, 0xd8, 0xff]));
    const b = await get(port, '/api/live-screenshot/999');
    assert.equal(b.status, 200, 'stale seq still serves current frame');
  } finally {
    await srv.stop();
  }
});
