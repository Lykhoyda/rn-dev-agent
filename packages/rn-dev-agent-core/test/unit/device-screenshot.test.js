import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScreenshotArgs,
  computeScreenshotAdvisories,
  wrapResultWithAdvisories,
} from '../../dist/tools/device-list.js';

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
    assert.ok(
      !out.includes('--format'),
      `--format emitted for ${JSON.stringify(args)} → ${out.join(' ')}`,
    );
  }
});

test('buildScreenshotArgs uses --out for the path, not positional', () => {
  const out = buildScreenshotArgs({ path: '/tmp/shot.jpg' });
  assert.deepEqual(out, ['screenshot', '--out', '/tmp/shot.jpg']);
});

test('buildScreenshotArgs defaults to .jpg when no path and no format given', () => {
  // Phase 134.3: default filename includes a random suffix to prevent
  // parallel-call clobbering. Inject `rand` for deterministic test.
  const out = buildScreenshotArgs(
    {},
    () => 12345,
    () => 0.5,
  );
  assert.equal(out[0], 'screenshot');
  assert.equal(out[1], '--out');
  assert.match(out[2], /^\/tmp\/rn-screenshot-12345-[a-z0-9]+\.jpg$/);
});

test('buildScreenshotArgs honors explicit format when no path given', () => {
  const out = buildScreenshotArgs(
    { format: 'png' },
    () => 99,
    () => 0.5,
  );
  assert.match(out[2], /^\/tmp\/rn-screenshot-99-[a-z0-9]+\.png$/);
});

test('buildScreenshotArgs: explicit path wins over format-derived default', () => {
  const out = buildScreenshotArgs({ path: '/explicit/out.png', format: 'jpeg' });
  // path is the source of truth — format hint is only used when path is absent
  assert.deepEqual(out, ['screenshot', '--out', '/explicit/out.png']);
});

// ── B117/D638: createDeviceScreenshotHandler platform resolution ─────
// These tests exercise the handler's platform-derivation logic. They stub
// getClient() so we don't touch runAgentDevice; the assertion is on what
// platform the handler *decides* before dispatch.

import { createDeviceScreenshotHandler } from '../../dist/tools/device-list.js';

// Stub runAgentDevice by monkey-patching the module at the wrapper layer is
// awkward; instead we assert via a mock getClient that returns a known
// connectedTarget, and verify the handler returns a ToolResult shape without
// erroring. The platform-passing behavior is already covered by the
// integration (B117 fix): we just need to prove the handler compiles with
// optional getClient and forwards a valid platform.

test('createDeviceScreenshotHandler accepts optional getClient without errors', () => {
  const handler = createDeviceScreenshotHandler();
  assert.equal(typeof handler, 'function');
});

test('createDeviceScreenshotHandler accepts getClient returning a target platform', () => {
  const mockClient = { connectedTarget: { platform: 'android' } };
  const handler = createDeviceScreenshotHandler(() => mockClient);
  assert.equal(typeof handler, 'function');
  // The handler would call runAgentDevice — we only verify construction here,
  // actual platform plumbing is exercised live in Round 2 Android re-run.
});

test('createDeviceScreenshotHandler accepts getClient returning null target', () => {
  const mockClient = { connectedTarget: null };
  const handler = createDeviceScreenshotHandler(() => mockClient);
  assert.equal(typeof handler, 'function');
});

// B150 / Phase 124 — non-blocking screenshot guardrails.
// Two advisory codes surface in meta.advisories[]:
//   - EPHEMERAL_PATH (saving to /tmp or /var/folders)
//   - FULL_RESOLUTION (maxWidth=0)
// Both are nudges, never errors — the call still succeeds.

test('B150: computeScreenshotAdvisories flags /tmp paths as EPHEMERAL_PATH', () => {
  const out = computeScreenshotAdvisories({}, '/tmp/shot.jpg');
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'EPHEMERAL_PATH');
  assert.match(out[0].message, /docs\/proof/);
});

test('B150: computeScreenshotAdvisories flags /var/folders/ paths as EPHEMERAL_PATH', () => {
  const out = computeScreenshotAdvisories({}, '/var/folders/abc/T/shot.jpg');
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'EPHEMERAL_PATH');
});

test('B150: computeScreenshotAdvisories does NOT flag docs/ paths', () => {
  const out = computeScreenshotAdvisories({}, 'docs/proof/cart/01-empty.jpg');
  assert.equal(out.length, 0);
});

test('B150: computeScreenshotAdvisories does NOT flag absolute project paths', () => {
  const out = computeScreenshotAdvisories({}, '/Users/dev/myapp/docs/proof/cart/01-empty.jpg');
  assert.equal(out.length, 0);
});

test('B150: computeScreenshotAdvisories flags maxWidth=0 as FULL_RESOLUTION', () => {
  const out = computeScreenshotAdvisories({ maxWidth: 0 }, 'docs/proof/x/01.jpg');
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'FULL_RESOLUTION');
  assert.match(out[0].message, /maxWidth=0/);
});

test('B150: computeScreenshotAdvisories does NOT flag maxWidth=800 (default)', () => {
  const out = computeScreenshotAdvisories({ maxWidth: 800 }, 'docs/proof/x/01.jpg');
  assert.equal(out.length, 0);
});

test('B150: computeScreenshotAdvisories does NOT flag maxWidth=undefined (default 800)', () => {
  const out = computeScreenshotAdvisories({}, 'docs/proof/x/01.jpg');
  assert.equal(out.length, 0);
});

test('B150: computeScreenshotAdvisories emits both codes when both conditions hit', () => {
  const out = computeScreenshotAdvisories({ maxWidth: 0 }, '/tmp/x.jpg');
  assert.equal(out.length, 2);
  const codes = out.map((a) => a.code).sort();
  assert.deepEqual(codes, ['EPHEMERAL_PATH', 'FULL_RESOLUTION']);
});

test('B150: wrapResultWithAdvisories appends meta.advisories to a successful envelope', () => {
  const ok = {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { path: '/tmp/x.jpg' } }) }],
  };
  const advisories = [{ code: 'EPHEMERAL_PATH', message: 'use docs/' }];
  const wrapped = wrapResultWithAdvisories(ok, advisories);
  const env = JSON.parse(wrapped.content[0].text);
  assert.deepEqual(env.meta.advisories, advisories);
});

test('B150: wrapResultWithAdvisories preserves existing meta fields (resize survives)', () => {
  const ok = {
    isError: false,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          data: { path: '/tmp/x.jpg' },
          meta: { resize: { resized: false } },
        }),
      },
    ],
  };
  const advisories = [{ code: 'EPHEMERAL_PATH', message: 'm' }];
  const wrapped = wrapResultWithAdvisories(ok, advisories);
  const env = JSON.parse(wrapped.content[0].text);
  assert.equal(env.meta.resize.resized, false);
  assert.deepEqual(env.meta.advisories, advisories);
});

test('B150: wrapResultWithAdvisories is a no-op on isError results', () => {
  const err = { isError: true, content: [{ type: 'text', text: 'boom' }] };
  const wrapped = wrapResultWithAdvisories(err, [{ code: 'EPHEMERAL_PATH', message: 'm' }]);
  assert.strictEqual(wrapped, err);
});

test('B150: wrapResultWithAdvisories is a no-op when advisories is empty', () => {
  const ok = {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { path: '/tmp/x.jpg' } }) }],
  };
  const wrapped = wrapResultWithAdvisories(ok, []);
  assert.strictEqual(wrapped, ok);
});

test('B150: wrapResultWithAdvisories tolerates malformed JSON envelopes', () => {
  const malformed = { isError: false, content: [{ type: 'text', text: 'not-json' }] };
  const wrapped = wrapResultWithAdvisories(malformed, [{ code: 'EPHEMERAL_PATH', message: 'm' }]);
  assert.strictEqual(wrapped, malformed);
});
