import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusDelayAfterPreTap } from '../../dist/tools/device-interact.js';
import { buildRunIOSArgs, buildRunAndroidArgs } from '../../dist/agent-device-wrapper.js';

const withSettle = JSON.stringify({
  ok: true,
  data: {},
  meta: { settle: { method: 'screen-static', settled: true } },
});
const withTimeoutSettle = JSON.stringify({
  ok: true,
  data: {},
  meta: { settle: { method: 'timeout', settled: false } },
});
const withoutSettle = JSON.stringify({ ok: true, data: {} });

test('explicit waitForKeyboardMs always wins', () => {
  assert.equal(focusDelayAfterPreTap(withSettle, 800), 800);
});

test('settle ran → skip the fixed focus delay', () => {
  assert.equal(focusDelayAfterPreTap(withSettle, undefined), 0);
  assert.equal(focusDelayAfterPreTap(withTimeoutSettle, undefined), 0);
});

test('no settle meta → legacy 150ms fallback', () => {
  assert.equal(focusDelayAfterPreTap(withoutSettle, undefined), 150);
  assert.equal(focusDelayAfterPreTap(undefined, undefined), 150);
  assert.equal(focusDelayAfterPreTap('not-json', undefined), 150);
});

test('buildRunIOSArgs fill honors --at-x/--at-y pin and skips @ref re-resolution', () => {
  // Ref map deliberately EMPTY: without the pin this would return _staleRef.
  const args = buildRunIOSArgs(
    ['fill', '@e3', 'hello world', '--at-x', '120', '--at-y', '240'],
    'com.test',
  );
  assert.equal(args.command, 'type');
  assert.equal(args.x, 120);
  assert.equal(args.y, 240);
  assert.equal(args.text, 'hello world');
  assert.equal(args._staleRef, undefined);
});

test('buildRunIOSArgs fill rejects non-finite pins (falls back to @ref path)', () => {
  const args = buildRunIOSArgs(
    ['fill', '@e3', 'hi', '--at-x', 'Infinity', '--at-y', '240'],
    'com.test',
  );
  assert.equal(args._staleRef, '@e3'); // empty ref map → stale sentinel, NOT bogus coords
});

test('buildRunAndroidArgs fill honors --at-x/--at-y pin', () => {
  const args = buildRunAndroidArgs(
    ['fill', '@e3', 'hello world', '--at-x', '80', '--at-y', '160'],
    'com.test',
  );
  assert.equal(args.command, 'type');
  assert.equal(args.x, 80);
  assert.equal(args.y, 160);
  assert.equal(args.text, 'hello world');
  assert.equal(args._staleRef, undefined);
});

test('batch delay: explicit always wins; settle on → 0, settle off → legacy 300', async () => {
  const { resolveBatchDelayMs } = await import('../../dist/tools/device-batch.js');
  assert.equal(resolveBatchDelayMs(500, {}), 500);
  assert.equal(resolveBatchDelayMs(0, { RN_SETTLE: '0' }), 0);
  assert.equal(resolveBatchDelayMs(undefined, {}), 0);
  assert.equal(resolveBatchDelayMs(undefined, { RN_SETTLE: '0' }), 300);
});

test('device_batch threads per-step settle opts into runNative (2500ms budget, settle:false hatch)', async () => {
  const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { createDeviceBatchHandler } = await import('../../dist/tools/device-batch.js');
  const { okResult } = await import('../../dist/utils.js');
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  const calls = [];
  _setRunAgentDeviceForTest(async (cliArgs, opts) => {
    calls.push({ cliArgs, opts });
    return okResult({ nodes: [] });
  });
  try {
    const handler = createDeviceBatchHandler();
    await handler({
      steps: [
        { action: 'press', ref: 'e1' },
        { action: 'press', ref: 'e2', settle: false },
      ],
      finalSnapshot: 'none',
      delayMs: 0,
    });
    const presses = calls.filter((c) => c.cliArgs[0] === 'press');
    assert.equal(presses.length, 2);
    assert.deepEqual(presses[0].opts, { settle: { timeoutMs: 2500 } });
    assert.deepEqual(presses[1].opts, { settle: { enabled: false } });
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});

test('exact fill carries descriptor identity without geometry or a separate pre-tap', async () => {
  const { buildRunIOSArgs } = await import('../../dist/agent-device-wrapper.js');
  const text = 'hi';
  const args = buildRunIOSArgs([
    'fill',
    '@exact-fill',
    '--text-base64',
    Buffer.from(text, 'utf8').toString('base64'),
    '--exact-id',
    'email',
    '--exact-type',
    'TextField',
  ]);
  assert.equal(args.command, 'type');
  assert.equal(args.text, text);
  assert.equal(args.exactIdentifier, 'email');
  assert.equal(args.exactType, 'TextField');
  assert.equal(args.x, undefined);
  assert.equal(args.y, undefined);
});
