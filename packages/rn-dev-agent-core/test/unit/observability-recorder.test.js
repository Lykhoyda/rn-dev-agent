import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../../dist/observability/recorder.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('record assigns monotonic seq and snapshot returns chronological order', () => {
  const r = new Recorder(3);
  r.record({ tool: 'cdp_status', params: {}, status: 'PASS', latencyMs: 1 });
  r.record({ tool: 'device_press', params: { ref: 'e1' }, status: 'PASS', latencyMs: 2 });
  const snap = r.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[0].seq, 1);
  assert.equal(snap[1].seq, 2);
});
test('ring buffer evicts oldest beyond capacity', () => {
  const r = new Recorder(2);
  for (let i = 0; i < 5; i++)
    r.record({ tool: 'cdp_status', params: {}, status: 'PASS', latencyMs: 1 });
  const snap = r.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[1].seq, 5);
});
test('attach() returns a same-tick snapshot and delivers subsequent events (no gap)', () => {
  const r = new Recorder(10);
  r.record({ tool: 'cdp_status', params: {}, status: 'PASS', latencyMs: 1 });
  const got = [];
  const { snapshot, detach } = r.attach((e) => got.push(e.seq));
  assert.equal(snapshot.length, 1);
  r.record({ tool: 'device_press', params: {}, status: 'PASS', latencyMs: 1 });
  assert.deepEqual(got, [2]);
  detach();
  r.record({ tool: 'device_press', params: {}, status: 'PASS', latencyMs: 1 });
  assert.deepEqual(got, [2]);
});
test('record swallows errors (never throws into the caller)', () => {
  const r = new Recorder(2);
  assert.doesNotThrow(() => r.record(null));
});
test('captureScreenshot reads bytes at record time and serves by seq', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-'));
  const png = join(dir, 'shot.jpg');
  writeFileSync(png, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  const r = new Recorder(5);
  r.registerCapturedScreenshot(png); // GH #429: reads require a capture grant
  r.record({
    tool: 'device_screenshot',
    params: {},
    status: 'PASS',
    latencyMs: 5,
    result: { ok: true, data: { message: png } },
  });
  const shot = r.getScreenshot(1);
  assert.ok(shot);
  assert.equal(shot.contentType, 'image/jpeg');
  assert.equal(shot.buf.length, 4);
});
test('captureScreenshot ignores a missing/non-image file (fail-safe)', () => {
  const r = new Recorder(5);
  r.record({
    tool: 'device_screenshot',
    params: {},
    status: 'PASS',
    latencyMs: 5,
    result: { ok: true, data: { message: '/nonexistent/x.png' } },
  });
  assert.equal(r.getScreenshot(1), undefined);
});
test('captureScreenshot bytes survive deletion of the source file (captured at record time)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-'));
  const png = join(dir, 'shot.png');
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const r = new Recorder(5);
  r.registerCapturedScreenshot(png); // GH #429
  r.record({
    tool: 'device_screenshot',
    params: {},
    status: 'PASS',
    latencyMs: 5,
    result: { ok: true, data: { path: png } },
  });
  rmSync(png);
  const shot = r.getScreenshot(1);
  assert.ok(shot, 'bytes survive deletion');
  assert.equal(shot.contentType, 'image/png');
});
test('captureScreenshot skips an oversized file (>4MB)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-'));
  const big = join(dir, 'big.jpg');
  writeFileSync(big, Buffer.alloc(4_000_001, 0xff));
  const r = new Recorder(5);
  r.registerCapturedScreenshot(big); // GH #429
  r.record({
    tool: 'device_screenshot',
    params: {},
    status: 'PASS',
    latencyMs: 5,
    result: { ok: true, data: { message: big } },
  });
  assert.equal(r.getScreenshot(1), undefined);
});
test('captureScreenshot FIFO-evicts beyond shotCap', () => {
  const r = new Recorder(20); // shotCap = max(8, floor(20/10)) = 8
  const dir = mkdtempSync(join(tmpdir(), 'obs-'));
  const png = join(dir, 's.jpg');
  writeFileSync(png, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  for (let i = 0; i < 10; i++) {
    r.registerCapturedScreenshot(png); // GH #429: grants are single-use
    r.record({
      tool: 'device_screenshot',
      params: {},
      status: 'PASS',
      latencyMs: 1,
      result: { ok: true, data: { message: png } },
    });
  }
  assert.equal(r.getScreenshot(1), undefined, 'oldest evicted');
  assert.equal(r.getScreenshot(2), undefined, 'second oldest evicted');
  assert.ok(r.getScreenshot(10), 'newest kept');
});
test('a throwing subscriber does not break record or other subscribers', () => {
  const r = new Recorder(5);
  const got = [];
  r.attach(() => {
    throw new Error('boom');
  });
  r.attach((e) => got.push(e.seq));
  assert.doesNotThrow(() =>
    r.record({ tool: 'cdp_status', params: {}, status: 'PASS', latencyMs: 1 }),
  );
  assert.deepEqual(got, [1]);
});
test('captureScreenshot reads bytes from the REAL MCP envelope (content[0].text) — regression for the unwrap bug', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-'));
  const jpg = join(dir, 'real-envelope.jpg');
  writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  const r = new Recorder(5);
  r.registerCapturedScreenshot(jpg); // GH #429
  r.record({
    tool: 'device_screenshot',
    params: {},
    status: 'PASS',
    latencyMs: 5,
    result: {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { path: jpg } }) }],
    },
  });
  const shot = r.getScreenshot(1);
  assert.ok(shot, 'bytes captured from the real envelope');
  assert.equal(shot.contentType, 'image/jpeg');
  assert.equal(shot.buf.length, 4);
});
test('captureScreenshot skips a FAIL-status screenshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-'));
  const f = join(dir, 'f.jpg');
  writeFileSync(f, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  const r = new Recorder(5);
  r.record({
    tool: 'device_screenshot',
    params: {},
    status: 'FAIL',
    latencyMs: 1,
    error: 'x',
    result: { ok: false, data: { message: f } },
  });
  assert.equal(r.getScreenshot(1), undefined);
});
