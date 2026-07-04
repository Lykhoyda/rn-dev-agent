import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusDelayAfterPreTap } from '../../dist/tools/device-interact.js';
import { buildRunIOSArgs, buildRunAndroidArgs } from '../../dist/agent-device-wrapper.js';

const withSettle = JSON.stringify({
  ok: true, data: {}, meta: { settle: { method: 'screen-static', settled: true } },
});
const withTimeoutSettle = JSON.stringify({
  ok: true, data: {}, meta: { settle: { method: 'timeout', settled: false } },
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
  const args = buildRunIOSArgs(['fill', '@e3', 'hi', '--at-x', 'Infinity', '--at-y', '240'], 'com.test');
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

test('device_fill pins press and fill to pre-resolved coords', async () => {
  const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
  const { createDeviceFillHandler } = await import('../../dist/tools/device-interact.js');
  const { okResult } = await import('../../dist/utils.js');
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  updateRefMapFromFlat([
    {
      ref: '@e3', type: 'TextField', identifier: 'email',
      rect: { x: 100, y: 220, width: 200, height: 40 },
    },
  ]);
  const calls = [];
  _setRunAgentDeviceForTest(async (cliArgs, opts) => {
    calls.push({ cliArgs, opts });
    return okResult({});
  });
  try {
    const handler = createDeviceFillHandler(() => ({ isConnected: false }));
    await handler({ ref: '@e3', text: 'hi', waitForKeyboardMs: 0 });
    const press = calls.find((c) => c.cliArgs[0] === 'press');
    assert.deepEqual(press.cliArgs, ['press', '200', '240']); // center of seeded rect
    const fill = calls.find((c) => c.cliArgs[0] === 'fill');
    assert.ok(fill.cliArgs.includes('--at-x') && fill.cliArgs.includes('--at-y'), 'fill not pinned');
    assert.deepEqual(
      fill.cliArgs.slice(fill.cliArgs.indexOf('--at-x'), fill.cliArgs.indexOf('--at-x') + 4),
      ['--at-x', '200', '--at-y', '240'],
    );
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
    clearRefMap();
  }
});
