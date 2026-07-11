import { test } from 'node:test';
import assert from 'node:assert/strict';

// Story 10 (#391) — fill-ladder reorder. The Android unsafe-char/length
// short-circuit predated the in-tree runner (its chunked adb tier cannot
// represent emoji); the runner's ACTION_SET_TEXT is now the primary for ALL
// text, with adb demoted to a genuine last resort. SET_TEXT_REJECTED from the
// runner classifies as ladder descent, and iOS typing telemetry
// (typingBurst / keyboardWaitMs) threads into device_fill's meta.

const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
  await import('../../dist/agent-device-wrapper.js');
const { createDeviceFillHandler, classifyFillPrimaryError, extractTypingMeta } =
  await import('../../dist/tools/device-interact.js');
const { okResult, failResult } = await import('../../dist/utils.js');

const noCdp = () => {
  throw new Error('no cdp client in this test');
};

async function withAndroidFillSeam(onCall, run) {
  _setActiveSessionForTest({ platform: 'android', deviceId: 'test-serial', appId: 'com.test' });
  _setRunAgentDeviceForTest(onCall);
  try {
    return await run();
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
}

test('#391: Android emoji fill reaches the runner setText primary, not chunked adb', async () => {
  const calls = [];
  const result = await withAndroidFillSeam(
    async (cliArgs) => {
      calls.push(cliArgs);
      if (cliArgs[0] === 'press') return okResult({ tapped: true });
      if (cliArgs[0] === 'fill') {
        return okResult({
          typed: true,
          text: cliArgs[2],
          method: 'setText',
          setTextOutcome: 'accepted',
        });
      }
      return okResult({});
    },
    async () => {
      const handler = createDeviceFillHandler(noCdp);
      return handler({ ref: '@e1', text: 'héllo 👋🏽 世界' });
    },
  );
  assert.ok(!result.isError, `expected ok, got: ${result.content?.[0]?.text}`);
  const fill = calls.find((c) => c[0] === 'fill');
  assert.ok(fill, 'runner fill command was dispatched');
  assert.equal(fill[2], 'héllo 👋🏽 世界');
  assert.ok(
    !result.content[0].text.includes('adb-chunked-input'),
    'must not route through the chunked-adb workaround',
  );
});

test('#391: long text with adb-unsafe characters also stays on the runner primary', async () => {
  const text = 'user+tag@example.com — & 40 chars of $unsafe% text!';
  const calls = [];
  const result = await withAndroidFillSeam(
    async (cliArgs) => {
      calls.push(cliArgs);
      if (cliArgs[0] === 'press') return okResult({ tapped: true });
      if (cliArgs[0] === 'fill') return okResult({ typed: true, text: cliArgs[2] });
      return okResult({});
    },
    async () => {
      const handler = createDeviceFillHandler(noCdp);
      return handler({ ref: '@e2', text });
    },
  );
  assert.ok(!result.isError);
  const fill = calls.find((c) => c[0] === 'fill');
  assert.ok(fill, 'runner fill command was dispatched');
  assert.equal(fill[2], text);
});

test('#391: classifyFillPrimaryError — ok result returns primary', () => {
  assert.equal(classifyFillPrimaryError(okResult({ typed: true })), 'return-primary');
});

test('#391: classifyFillPrimaryError — SET_TEXT_REJECTED code descends the reject ladder', () => {
  const primary = failResult(
    'Focused field ignored both ACTION_SET_TEXT and the keyevent fallback.',
    'SET_TEXT_REJECTED',
  );
  assert.equal(classifyFillPrimaryError(primary), 'reject-ladder');
});

test('#391: classifyFillPrimaryError — no-focused-input descends the refocus ladder', () => {
  const primary = failResult(
    'No focused text input on screen. The TS device_fill handler should re-tap the target ref before calling type.',
  );
  assert.equal(classifyFillPrimaryError(primary), 'refocus-ladder');
});

test('#391: classifyFillPrimaryError — unrelated errors return primary untouched', () => {
  assert.equal(
    classifyFillPrimaryError(failResult('runner exploded', 'RN_ANDROID_RUNNER_DOWN')),
    'return-primary',
  );
});

test('#391: extractTypingMeta surfaces typingBurst + keyboardWaitMs from the runner envelope', () => {
  const result = okResult({ typed: true, typingBurst: true, keyboardWaitMs: 120 });
  assert.deepEqual(extractTypingMeta(result), { burst: true, keyboardWaitMs: 120 });
});

test('#391: extractTypingMeta returns null when the envelope has no typing telemetry', () => {
  assert.equal(extractTypingMeta(okResult({ typed: true })), null);
  assert.equal(extractTypingMeta(failResult('nope')), null);
});
