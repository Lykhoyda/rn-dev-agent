// GH #429: Recorder screenshot-ingestion hardening. The recorder must only
// read files the capture pipeline itself just wrote (trusted registration,
// single-use), never an arbitrary absolute path that appears in an
// observation — and the read itself must be fd-bound (no stat→read TOCTOU,
// no symlink follow, hard byte cap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Recorder, recorder } from '../../dist/observability/recorder.js';
import {
  captureAndResizeScreenshot,
  _setRunAgentDeviceForTest,
  _resetRunAgentDeviceForTest,
} from '../../dist/tools/device-list.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function shotObs(p) {
  return {
    tool: 'device_screenshot',
    params: {},
    status: 'PASS',
    latencyMs: 1,
    result: { ok: true, data: { path: p } },
  };
}

test('#429 unregistered absolute image path is refused (no arbitrary local file read)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh429-'));
  const p = join(dir, 'not-ours.png');
  writeFileSync(p, PNG);
  const r = new Recorder(5);
  r.record(shotObs(p));
  assert.equal(r.getScreenshot(1), undefined);
});

test('#429 capture-registered path is served', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh429-'));
  const p = join(dir, 'shot.jpg');
  writeFileSync(p, JPEG);
  const r = new Recorder(5);
  r.registerCapturedScreenshot(p);
  r.record(shotObs(p));
  const shot = r.getScreenshot(1);
  assert.ok(shot, 'registered capture must be served');
  assert.equal(shot.contentType, 'image/jpeg');
  assert.equal(shot.buf.length, JPEG.length);
});

test('#429 registration is single-use (stale-path replay is refused)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh429-'));
  const p = join(dir, 'shot.png');
  writeFileSync(p, PNG);
  const r = new Recorder(5);
  r.registerCapturedScreenshot(p);
  r.record(shotObs(p));
  r.record(shotObs(p));
  assert.ok(r.getScreenshot(1), 'first observation consumes the registration');
  assert.equal(r.getScreenshot(2), undefined, 'replayed path must not be re-read');
});

test('#429 symlink at a registered path is refused (no symlink follow)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh429-'));
  const target = join(dir, 'target.png');
  const link = join(dir, 'link.png');
  writeFileSync(target, PNG);
  symlinkSync(target, link);
  const r = new Recorder(5);
  r.registerCapturedScreenshot(link);
  r.record(shotObs(link));
  assert.equal(r.getScreenshot(1), undefined);
});

test('#429 oversized file is refused even when registered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh429-'));
  const p = join(dir, 'huge.png');
  writeFileSync(p, Buffer.alloc(4_000_001));
  const r = new Recorder(5);
  r.registerCapturedScreenshot(p);
  r.record(shotObs(p));
  assert.equal(r.getScreenshot(1), undefined);
});

test('#429 registry is bounded — oldest registration is evicted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh429-'));
  const first = join(dir, 'first.png');
  writeFileSync(first, PNG);
  const r = new Recorder(5);
  r.registerCapturedScreenshot(first);
  for (let i = 0; i < 64; i++) r.registerCapturedScreenshot(join(dir, `filler-${i}.png`));
  r.record(shotObs(first));
  assert.equal(r.getScreenshot(1), undefined, 'evicted registration must not be readable');
});

test('#429 wiring: captureAndResizeScreenshot registers its output with the singleton recorder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh429-'));
  const p = join(dir, 'wired.png');
  writeFileSync(p, PNG);
  _setRunAgentDeviceForTest(async () => ({
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { path: p } }) }],
  }));
  try {
    const res = await captureAndResizeScreenshot({ path: p, maxWidth: 0 });
    assert.ok(!res.isError, 'stubbed capture must succeed');
    recorder.record(shotObs(p));
    const events = recorder.snapshot();
    const seq = events[events.length - 1].seq;
    assert.ok(recorder.getScreenshot(seq), 'pipeline-captured path must be served');
  } finally {
    _resetRunAgentDeviceForTest();
  }
});
