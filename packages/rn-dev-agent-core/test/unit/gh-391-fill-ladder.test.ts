import { test } from 'node:test';
import assert from 'node:assert/strict';

// Story 10 (#391) — fill-ladder reorder. The Android unsafe-char/length
// short-circuit predated the in-tree runner (its chunked adb tier cannot
// represent emoji); the runner's ACTION_SET_TEXT is now the primary for ALL
// text, with adb demoted to a genuine last resort. SET_TEXT_REJECTED from the
// runner classifies as ladder descent, and iOS typing telemetry
// (typingBurst / keyboardWaitMs) threads into device_fill's meta.

const { buildRunAndroidArgs } = await import('../../dist/agent-device-wrapper.js');
const { classifyFillPrimaryError, extractTypingMeta, isAdbInputTextSafe } =
  await import('../../dist/tools/device-interact.js');
const { okResult, failResult } = await import('../../dist/utils.js');

test('#391: Android exact fill decodes full Unicode for direct ACTION_SET_TEXT', () => {
  const text = 'héllo 👋🏽 世界';
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  const args = buildRunAndroidArgs([
    'fill',
    '@exact-fill',
    '--text-base64',
    encoded,
    '--exact-id',
    'email',
    '--exact-type',
    'android.widget.EditText',
  ]);
  assert.equal(args.text, text);
  assert.equal(args.exactIdentifier, 'email');
  assert.equal(args.exactType, 'android.widget.EditText');
});

test('#391: long adb-unsafe text remains one exact native command', () => {
  const text = 'user+tag@example.com — & 40 chars of $unsafe% text!';
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  const args = buildRunAndroidArgs([
    'fill',
    '@exact-fill',
    '--text-base64',
    encoded,
    '--exact-id',
    'email',
    '--exact-type',
    'android.widget.EditText',
  ]);
  assert.equal(args.command, 'type');
  assert.equal(args.text, text);
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

test('#391: isAdbInputTextSafe gates the adb tier to printable ASCII', () => {
  assert.equal(isAdbInputTextSafe('user+tag@example.com #42 (a-z)!'), true);
  assert.equal(isAdbInputTextSafe(''), true);
  assert.equal(isAdbInputTextSafe('héllo'), false);
  assert.equal(isAdbInputTextSafe('👋🏽'), false);
  assert.equal(isAdbInputTextSafe('世界'), false);
  assert.equal(isAdbInputTextSafe('tab\tand\nnewline'), false);
});
