import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObservabilityServer } from '../../dist/observability/server.js';
import { Recorder } from '../../dist/observability/recorder.js';

// Node's undici (global fetch) silently drops a forged Host header, so the
// DNS-rebinding guard can only be exercised over a raw socket where the
// Host header survives. Returns the response status code.
function rawStatus(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('server starts on 127.0.0.1 and reports a url+port, then stops', async () => {
  const srv = new ObservabilityServer(new Recorder(10));
  const { url, port } = await srv.start();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(port > 0);
  await srv.stop();
});

test('rejects a foreign Host header (DNS-rebinding) and cross-site Sec-Fetch-Site', async () => {
  const srv = new ObservabilityServer(new Recorder(10));
  const { port } = await srv.start();
  const badStatus = await rawStatus(port, '/api/stream', { Host: 'evil.example' });
  assert.equal(badStatus, 403);
  const xsite = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(xsite.status, 403);
  await srv.stop();
});

test('GET /api/stream replays snapshot then streams live events', async () => {
  const rec = new Recorder(10);
  rec.record({ tool: 'cdp_status', params: {}, status: 'PASS', latencyMs: 1 });
  const srv = new ObservabilityServer(rec);
  const { port } = await srv.start();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let txt = dec.decode((await reader.read()).value);
  rec.record({ tool: 'device_press', params: {}, status: 'PASS', latencyMs: 1 });
  for (let i = 0; i < 5 && !txt.includes('device_press'); i++) txt += dec.decode((await reader.read()).value);
  assert.ok(txt.includes('cdp_status'));
  assert.ok(txt.includes('device_press'));
  await reader.cancel();
  await srv.stop();
});

test('GET /api/screenshot/:seq serves bytes from the recorder buffer only', async () => {
  const rec = new Recorder(10);
  const p = join(mkdtempSync(join(tmpdir(), 'obs-')), 's.jpg');
  writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  rec.record({ tool: 'device_screenshot', params: {}, status: 'PASS', latencyMs: 1, result: { ok: true, data: { message: p } } });
  const srv = new ObservabilityServer(rec);
  const { port } = await srv.start();
  const ok = await fetch(`http://127.0.0.1:${port}/api/screenshot/1`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  const miss = await fetch(`http://127.0.0.1:${port}/api/screenshot/999`);
  assert.equal(miss.status, 404);
  await srv.stop();
});
