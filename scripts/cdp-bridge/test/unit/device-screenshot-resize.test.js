import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resizeWithSips,
  parseSipsDimensions,
  buildSipsResizeArgs,
  resetSipsProbeForTesting,
  DEFAULT_MAX_WIDTH,
  DEFAULT_QUALITY,
} from '../../dist/tools/device-screenshot-resize.js';
import {
  deriveScreenshotPath,
  resolveScreenshotPath,
  wrapResultWithResize,
} from '../../dist/tools/device-list.js';

beforeEach(() => resetSipsProbeForTesting());

// ── parseSipsDimensions ───────────────────────────────────────────────

test('parseSipsDimensions extracts width and height from sips -g output', () => {
  const stdout = `/tmp/test.jpg
  pixelWidth: 1179
  pixelHeight: 2556`;
  assert.deepEqual(parseSipsDimensions(stdout), { width: 1179, height: 2556 });
});

test('parseSipsDimensions returns null when fields missing', () => {
  assert.equal(parseSipsDimensions(''), null);
  assert.equal(parseSipsDimensions('pixelWidth: 100'), null);
  assert.equal(parseSipsDimensions('pixelHeight: 100'), null);
  assert.equal(parseSipsDimensions('garbage output'), null);
});

// ── buildSipsResizeArgs ───────────────────────────────────────────────

test('buildSipsResizeArgs adds quality flag for .jpg paths', () => {
  assert.deepEqual(
    buildSipsResizeArgs('/tmp/x.jpg', 800, 85),
    ['--resampleWidth', '800', '-s', 'formatOptions', '85', '/tmp/x.jpg'],
  );
});

test('buildSipsResizeArgs adds quality flag for .jpeg paths', () => {
  assert.deepEqual(
    buildSipsResizeArgs('/tmp/x.jpeg', 800, 85),
    ['--resampleWidth', '800', '-s', 'formatOptions', '85', '/tmp/x.jpeg'],
  );
});

test('buildSipsResizeArgs omits quality flag for .png paths', () => {
  assert.deepEqual(
    buildSipsResizeArgs('/tmp/x.png', 800, 85),
    ['--resampleWidth', '800', '/tmp/x.png'],
  );
});

test('buildSipsResizeArgs omits quality flag when quality is undefined', () => {
  assert.deepEqual(
    buildSipsResizeArgs('/tmp/x.jpg', 800, undefined),
    ['--resampleWidth', '800', '/tmp/x.jpg'],
  );
});

// ── deriveScreenshotPath ──────────────────────────────────────────────

test('deriveScreenshotPath returns explicit path when provided', () => {
  assert.equal(deriveScreenshotPath({ path: '/tmp/foo.jpg' }), '/tmp/foo.jpg');
});

test('deriveScreenshotPath defaults to .jpg when no path/format', () => {
  assert.equal(deriveScreenshotPath({}, () => 12345), '/tmp/rn-screenshot-12345.jpg');
});

test('deriveScreenshotPath honors format=png when no path', () => {
  assert.equal(deriveScreenshotPath({ format: 'png' }, () => 99), '/tmp/rn-screenshot-99.png');
});

// ── resolveScreenshotPath ─────────────────────────────────────────────

test('resolveScreenshotPath uses data.path when present and absolute', () => {
  const result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { path: '/tmp/actual.png' } }) }] };
  assert.equal(resolveScreenshotPath(result, '/tmp/fallback.jpg'), '/tmp/actual.png');
});

test('resolveScreenshotPath uses fallback when data.path is missing', () => {
  const result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: {} }) }] };
  assert.equal(resolveScreenshotPath(result, '/tmp/fallback.jpg'), '/tmp/fallback.jpg');
});

test('resolveScreenshotPath uses fallback when data.path is relative', () => {
  const result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { path: 'tmp/relative.png' } }) }] };
  assert.equal(resolveScreenshotPath(result, '/tmp/fallback.jpg'), '/tmp/fallback.jpg');
});

test('resolveScreenshotPath uses fallback on malformed envelope', () => {
  const result = { content: [{ type: 'text', text: 'not json' }] };
  assert.equal(resolveScreenshotPath(result, '/tmp/fallback.jpg'), '/tmp/fallback.jpg');
});

// ── wrapResultWithResize ──────────────────────────────────────────────

test('wrapResultWithResize adds resize meta and updates path on success', () => {
  const result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { path: '/tmp/foo.jpg' } }) }] };
  const resize = {
    resized: true,
    path: '/tmp/foo.jpg',
    originalDims: { width: 1179, height: 2556 },
    newDims: { width: 800, height: 1734 },
    originalBytes: 800_000,
    newBytes: 200_000,
  };
  const wrapped = wrapResultWithResize(result, resize);
  const env = JSON.parse(wrapped.content[0].text);
  assert.equal(env.meta.resize.resized, true);
  assert.deepEqual(env.meta.resize.fromDims, { width: 1179, height: 2556 });
  assert.deepEqual(env.meta.resize.toDims, { width: 800, height: 1734 });
  assert.equal(env.meta.resize.fromBytes, 800_000);
  assert.equal(env.meta.resize.toBytes, 200_000);
  assert.equal(env.meta.resize.savedPercent, 75);
  assert.equal(env.data.path, '/tmp/foo.jpg');
});

test('wrapResultWithResize adds reason meta when not resized', () => {
  const result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { path: '/tmp/foo.jpg' } }) }] };
  const wrapped = wrapResultWithResize(result, { resized: false, path: '/tmp/foo.jpg', reason: 'sips-unavailable' });
  const env = JSON.parse(wrapped.content[0].text);
  assert.equal(env.meta.resize.resized, false);
  assert.equal(env.meta.resize.reason, 'sips-unavailable');
});

test('wrapResultWithResize is a no-op on error results', () => {
  const errorResult = { content: [{ type: 'text', text: '{}' }], isError: true };
  const wrapped = wrapResultWithResize(errorResult, { resized: true, path: '/x' });
  assert.equal(wrapped, errorResult);
});

// ── resizeWithSips: degradation paths (no real sips invocation needed) ─

test('resizeWithSips skips when maxWidth=0', async () => {
  const out = await resizeWithSips('/tmp/anything.jpg', { maxWidth: 0 });
  assert.equal(out.resized, false);
  assert.equal(out.reason, 'maxWidth-zero');
  assert.equal(out.path, '/tmp/anything.jpg');
});

test('resizeWithSips returns sips-unavailable when sips probe fails', async () => {
  const exec = makeFakeExec({ '--version': () => { throw new Error('sips not found'); } });
  const out = await resizeWithSips('/tmp/x.jpg', {}, { exec });
  assert.equal(out.resized, false);
  assert.equal(out.reason, 'sips-unavailable');
});

test('resizeWithSips returns no-dimensions when sips -g returns garbage', async () => {
  const exec = makeFakeExec({
    '--version': () => ({ stdout: 'sips 10.4.4', stderr: '' }),
    '-g': () => ({ stdout: 'garbage output', stderr: '' }),
  });
  const out = await resizeWithSips('/tmp/x.jpg', {}, { exec });
  assert.equal(out.resized, false);
  assert.equal(out.reason, 'no-dimensions');
});

test('resizeWithSips returns already-smaller when image width <= maxWidth', async () => {
  const exec = makeFakeExec({
    '--version': () => ({ stdout: 'sips 10.4.4', stderr: '' }),
    '-g': () => ({ stdout: 'pixelWidth: 600\npixelHeight: 800', stderr: '' }),
  });
  const out = await resizeWithSips('/tmp/x.jpg', { maxWidth: 800 }, { exec });
  assert.equal(out.resized, false);
  assert.equal(out.reason, 'already-smaller');
  assert.deepEqual(out.originalDims, { width: 600, height: 800 });
});

test('resizeWithSips happy path: invokes sips resample, returns dims + bytes', async () => {
  let getCalls = 0;
  const exec = makeFakeExec({
    '--version': () => ({ stdout: 'sips 10.4.4', stderr: '' }),
    '-g': () => {
      getCalls++;
      return getCalls === 1
        ? { stdout: 'pixelWidth: 1200\npixelHeight: 2600', stderr: '' }
        : { stdout: 'pixelWidth: 800\npixelHeight: 1734', stderr: '' };
    },
    '--resampleWidth': () => ({ stdout: '', stderr: '' }),
  });
  const fileSize = (() => { let i = 0; return () => (++i === 1 ? 800_000 : 200_000); })();
  const out = await resizeWithSips('/tmp/x.jpg', { maxWidth: 800 }, { exec, fileSize });
  assert.equal(out.resized, true);
  assert.deepEqual(out.originalDims, { width: 1200, height: 2600 });
  assert.deepEqual(out.newDims, { width: 800, height: 1734 });
  assert.equal(out.originalBytes, 800_000);
  assert.equal(out.newBytes, 200_000);
});

test('resizeWithSips returns sips-failed when resample throws', async () => {
  const exec = makeFakeExec({
    '--version': () => ({ stdout: 'sips 10.4.4', stderr: '' }),
    '-g': () => ({ stdout: 'pixelWidth: 1200\npixelHeight: 2600', stderr: '' }),
    '--resampleWidth': () => { throw new Error('disk full'); },
  });
  const out = await resizeWithSips('/tmp/x.jpg', { maxWidth: 800 }, { exec });
  assert.equal(out.resized, false);
  assert.equal(out.reason, 'sips-failed');
  assert.deepEqual(out.originalDims, { width: 1200, height: 2600 });
});

test('resizeWithSips uses defaults when opts not provided', () => {
  // Verify the exported defaults are the documented values. 800 was picked
  // empirically — see DECISIONS.md D647 / device-screenshot-resize.ts header
  // for the iPhone 17 Pro measurement table.
  assert.equal(DEFAULT_MAX_WIDTH, 800);
  assert.equal(DEFAULT_QUALITY, 85);
});

// ── helpers ───────────────────────────────────────────────────────────

function makeFakeExec(handlers) {
  return async (cmd, args) => {
    if (cmd !== 'sips') throw new Error(`unexpected command: ${cmd}`);
    for (const flag of Object.keys(handlers)) {
      if (args.includes(flag)) {
        const result = handlers[flag](args);
        if (result instanceof Error) throw result;
        return result;
      }
    }
    throw new Error(`no handler for sips ${args.join(' ')}`);
  };
}
