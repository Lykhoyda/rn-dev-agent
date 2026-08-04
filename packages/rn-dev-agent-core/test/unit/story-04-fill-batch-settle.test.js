import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunIOSArgs, buildRunAndroidArgs } from '../../dist/agent-device-wrapper.js';

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

test('buildRunAndroidArgs preserves leading-dash fill and verify text', () => {
  const fill = buildRunAndroidArgs(['fill', '@e3', '-1']);
  const verify = buildRunAndroidArgs(['verify-input', '@e3', '-1']);
  assert.equal(fill.text, '-1');
  assert.equal(verify.text, '-1');
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

test('device_fill dispatches one exact native operation (no separate pre-tap press)', async () => {
  const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
  const { createDeviceFillHandler } = await import('../../dist/tools/device-interact.js');
  const { okResult } = await import('../../dist/utils.js');
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  const nodes = [
    {
      ref: '@e3',
      type: 'TextField',
      identifier: 'email',
      rect: { x: 100, y: 220, width: 200, height: 40 },
    },
  ];
  updateRefMapFromFlat(nodes, { snapshotGeneration: 3, keyboardVisible: false });
  const calls = [];
  _setRunAgentDeviceForTest(async (cliArgs, opts) => {
    calls.push({ cliArgs, opts });
    if (cliArgs[0] === 'snapshot') return okResult({ nodes });
    if (cliArgs[0] === 'verify-input') {
      return okResult({ verifyVerdict: 'exact', verifyStable: true });
    }
    return okResult({ typed: true });
  });
  try {
    const handler = createDeviceFillHandler(() => ({ isConnected: false }));
    const result = await handler({ ref: '@e3', text: 'hi', waitForKeyboardMs: 0 });
    assert.ok(!result.isError, result.content?.[0]?.text);
    assert.ok(!calls.some((c) => c.cliArgs[0] === 'press'), 'GH #581: no separate pre-tap press');
    const fill = calls.find((c) => c.cliArgs[0] === 'fill');
    assert.deepEqual(fill.opts.exactTarget, {
      inputRef: '@e3',
      focusX: 200,
      focusY: 240,
      focusWaitMs: 0,
    });
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.meta.verify, 'exact');
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
    clearRefMap();
  }
});
