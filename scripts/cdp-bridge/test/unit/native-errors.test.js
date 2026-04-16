import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIOSLog,
  parseAndroidLog,
  readNativeErrors,
} from '../../dist/tools/native-errors.js';

// B114/D642: native-log fallback. Parser is pure; reader accepts injected
// runners so tests don't spawn simctl/adb.

// ── parseIOSLog ─────────────────────────────────────────────────────

test('parseIOSLog extracts "Cannot find native module" lines', () => {
  const input = [
    '2026-04-16 22:15:00.123 Error [123] com.foo: Cannot find native module "ExponentPedometer"',
    '2026-04-16 22:15:01.456 Df [124] com.foo: normal log, should skip',
  ].join('\n');
  const out = parseIOSLog(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'ios-simctl-log');
  assert.equal(out[0].timestamp, '2026-04-16 22:15:00.123');
  assert.match(out[0].message, /ExponentPedometer/);
});

test('parseIOSLog tags RCTFatal as fatal level', () => {
  const input = '2026-04-16 22:15:00.123 Error RCTFatal: JavaScript failed';
  const out = parseIOSLog(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, 'fatal');
});

test('parseIOSLog tags regular errors as error level', () => {
  const input = '2026-04-16 22:15:00.123 Error Module AppRegistry is not a registered callable module';
  const out = parseIOSLog(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, 'error');
});

test('parseIOSLog dedupes identical messages', () => {
  const input = [
    '2026-04-16 22:15:00.123 Cannot find native module "Foo"',
    '2026-04-16 22:15:01.456 Cannot find native module "Foo"',
    '2026-04-16 22:15:02.789 Cannot find native module "Foo"',
  ].join('\n');
  const out = parseIOSLog(input);
  assert.equal(out.length, 1);
});

test('parseIOSLog returns empty array when no matches', () => {
  const input = '2026-04-16 22:15:00.123 routine boot message';
  assert.deepEqual(parseIOSLog(input), []);
  assert.deepEqual(parseIOSLog(''), []);
});

// ── parseAndroidLog ──────────────────────────────────────────────────

test('parseAndroidLog extracts FATAL EXCEPTION lines', () => {
  const input = [
    '04-16 22:15:00.123 E/AndroidRuntime(123): FATAL EXCEPTION: main',
    '04-16 22:15:01.456 I/System: normal log',
  ].join('\n');
  const out = parseAndroidLog(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'android-logcat');
  assert.equal(out[0].level, 'fatal');
  assert.equal(out[0].timestamp, '04-16 22:15:00.123');
});

test('parseAndroidLog tags ReactNative errors as error level', () => {
  const input = '04-16 22:15:00.123 E/ReactNative: Cannot find native module "ExponentPedometer"';
  const out = parseAndroidLog(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, 'error');
});

test('parseAndroidLog catches "Could not connect to development server"', () => {
  const input = '04-16 22:15:00.123 E/ReactNative: Could not connect to development server';
  const out = parseAndroidLog(input);
  assert.equal(out.length, 1);
  assert.match(out[0].message, /development server/);
});

// ── readNativeErrors — dispatch + injection ──────────────────────────

test('readNativeErrors dispatches to iOS runner by default', async () => {
  const mockOut = '2026-04-16 22:15:00.123 Error Cannot find native module "Foo"';
  const entries = await readNativeErrors({
    runIOS: async () => mockOut,
    runAndroid: async () => { throw new Error('should not run'); },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, 'ios-simctl-log');
});

test('readNativeErrors dispatches to Android runner for platform=android', async () => {
  const mockOut = '04-16 22:15:00.123 E/ReactNative: FATAL EXCEPTION: main';
  const entries = await readNativeErrors({
    platform: 'android',
    runIOS: async () => { throw new Error('should not run'); },
    runAndroid: async () => mockOut,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, 'android-logcat');
});

test('readNativeErrors returns empty on runner failure (no xcrun/adb installed)', async () => {
  const entries = await readNativeErrors({
    runIOS: async () => { throw new Error('xcrun not found'); },
  });
  assert.deepEqual(entries, []);
});

test('readNativeErrors respects limit', async () => {
  const lines = [];
  for (let i = 0; i < 20; i++) {
    lines.push(`2026-04-16 22:15:${String(i).padStart(2, '0')}.000 Error Cannot find native module "Mod${i}"`);
  }
  const entries = await readNativeErrors({
    limit: 5,
    runIOS: async () => lines.join('\n'),
  });
  assert.equal(entries.length, 5);
});
