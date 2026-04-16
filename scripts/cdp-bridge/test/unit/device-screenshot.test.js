import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScreenshotArgs } from '../../dist/tools/device-list.js';

// B113 (D636): make sure --format never sneaks back in.

test('buildScreenshotArgs never emits --format', () => {
  const cases = [
    {},
    { path: '/tmp/x.png' },
    { path: '/tmp/x.jpg' },
    { path: '/tmp/x.jpeg' },
    { format: 'png' },
    { format: 'jpeg' },
    { path: '/tmp/x.png', format: 'jpeg' },
  ];
  for (const args of cases) {
    const out = buildScreenshotArgs(args);
    assert.ok(!out.includes('--format'), `--format emitted for ${JSON.stringify(args)} → ${out.join(' ')}`);
  }
});

test('buildScreenshotArgs uses --out for the path, not positional', () => {
  const out = buildScreenshotArgs({ path: '/tmp/shot.jpg' });
  assert.deepEqual(out, ['screenshot', '--out', '/tmp/shot.jpg']);
});

test('buildScreenshotArgs defaults to .jpg when no path and no format given', () => {
  const now = () => 12345;
  const out = buildScreenshotArgs({}, now);
  assert.deepEqual(out, ['screenshot', '--out', '/tmp/rn-screenshot-12345.jpg']);
});

test('buildScreenshotArgs honors explicit format when no path given', () => {
  const now = () => 99;
  const out = buildScreenshotArgs({ format: 'png' }, now);
  assert.deepEqual(out, ['screenshot', '--out', '/tmp/rn-screenshot-99.png']);
});

test('buildScreenshotArgs: explicit path wins over format-derived default', () => {
  const out = buildScreenshotArgs({ path: '/explicit/out.png', format: 'jpeg' });
  // path is the source of truth — format hint is only used when path is absent
  assert.deepEqual(out, ['screenshot', '--out', '/explicit/out.png']);
});
