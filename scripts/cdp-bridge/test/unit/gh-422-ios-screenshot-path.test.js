import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseScreenshotPath } from '../../dist/tools/device-list.js';
import { Recorder } from '../../dist/observability/recorder.js';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── GH #422: iOS pixels always route raw (simctl honors the caller's path; the
// rn-fast-runner screenshot verb writes inside its sandbox and returns a
// relative tmp/ path the host can never serve). ──

test('iOS with no flow routes to simctl, not the runner (GH #422)', () => {
  assert.equal(chooseScreenshotPath({ flowActive: false, platform: 'ios' }), 'simctl');
});

test('Android with no flow keeps the runner (it honors outPath host-side)', () => {
  assert.equal(chooseScreenshotPath({ flowActive: false, platform: 'android' }), 'runner');
});

test('unknown platform with no flow keeps the runner (nothing to simctl on)', () => {
  assert.equal(chooseScreenshotPath({ flowActive: false, platform: null }), 'runner');
});

test('flow-active routing is unchanged: platform → simctl, unknown → fail', () => {
  assert.equal(chooseScreenshotPath({ flowActive: true, platform: 'ios' }), 'simctl');
  assert.equal(chooseScreenshotPath({ flowActive: true, platform: 'android' }), 'simctl');
  assert.equal(chooseScreenshotPath({ flowActive: true, platform: null }), 'fail');
});

// ── GH #422 defense-in-depth: the observe recorder must never resolve a
// relative screenshot path against the bridge cwd — a runner-internal
// "tmp/…" path silently blanked the panel (stat miss) or, worse, could read
// an unrelated cwd file that happens to share the name. ──

test('recorder rejects relative screenshot paths even when a cwd file matches (GH #422)', () => {
  const prevCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), 'gh422-'));
  const relPath = join('tmp', 'gh422-shot.png');
  try {
    process.chdir(sandbox);
    mkdirSync('tmp', { recursive: true });
    writeFileSync(relPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = new Recorder(10);
    r.record({
      tool: 'device_screenshot',
      params: {},
      status: 'PASS',
      latencyMs: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { message: relPath } }) }] },
    });
    assert.equal(r.getScreenshot(1), undefined);
  } finally {
    process.chdir(prevCwd);
    rmSync(sandbox, { recursive: true, force: true });
  }
});
