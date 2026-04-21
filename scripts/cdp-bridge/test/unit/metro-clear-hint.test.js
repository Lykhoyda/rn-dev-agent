import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldShowMetroClearHint,
  METRO_CLEAR_HINT_THRESHOLD_MS,
  METRO_CLEAR_HINT_TEXT,
} from '../../dist/tools/metro-clear-hint.js';

// M11 / D665 — pure helper tests. Mirrors metro-mcp's troubleshooting
// "Empty Results or Stale Data" signal but surfaces it inline in tool
// results when the buffer has been empty for > threshold.

const NOW = 10_000_000;
const stub = (nowValue) => () => nowValue;

test('M11 probe: non-empty result returns false regardless of timing', () => {
  assert.equal(
    shouldShowMetroClearHint(
      { connectedAt: NOW - 120_000, now: stub(NOW) },
      false,
    ),
    false,
  );
});

test('M11 probe: null connectedAt returns false (not connected yet)', () => {
  assert.equal(
    shouldShowMetroClearHint(
      { connectedAt: null, now: stub(NOW) },
      true,
    ),
    false,
  );
});

test('M11 probe: empty + connected 30s ago returns false (below threshold)', () => {
  assert.equal(
    shouldShowMetroClearHint(
      { connectedAt: NOW - 30_000, now: stub(NOW) },
      true,
    ),
    false,
  );
});

test('M11 probe: empty + connected 61s ago returns true', () => {
  assert.equal(
    shouldShowMetroClearHint(
      { connectedAt: NOW - 61_000, now: stub(NOW) },
      true,
    ),
    true,
  );
});

test('M11 probe: empty + old connectedAt + recent lastEventAt returns false (recent event resets clock)', () => {
  assert.equal(
    shouldShowMetroClearHint(
      { connectedAt: NOW - 120_000, lastEventAt: NOW - 10_000, now: stub(NOW) },
      true,
    ),
    false,
  );
});

test('M11 probe: empty + recent connectedAt + old lastEventAt returns false (recent connect resets clock)', () => {
  assert.equal(
    shouldShowMetroClearHint(
      { connectedAt: NOW - 10_000, lastEventAt: NOW - 120_000, now: stub(NOW) },
      true,
    ),
    false,
  );
});

test('M11 probe: empty + both old returns true', () => {
  assert.equal(
    shouldShowMetroClearHint(
      { connectedAt: NOW - 120_000, lastEventAt: NOW - 120_000, now: stub(NOW) },
      true,
    ),
    true,
  );
});

test('M11 probe: exactly at threshold fires (>=, not strict >)', () => {
  assert.equal(
    shouldShowMetroClearHint(
      { connectedAt: NOW - METRO_CLEAR_HINT_THRESHOLD_MS, now: stub(NOW) },
      true,
    ),
    true,
  );
});

test('M11 probe: undefined lastEventAt falls back to connectedAt', () => {
  // lastEventAt undefined; connectedAt old → should fire
  assert.equal(
    shouldShowMetroClearHint(
      { connectedAt: NOW - 120_000, lastEventAt: undefined, now: stub(NOW) },
      true,
    ),
    true,
  );
});

test('M11 hint text contains both expo and react-native commands', () => {
  assert.match(METRO_CLEAR_HINT_TEXT, /npx expo start --clear/);
  assert.match(METRO_CLEAR_HINT_TEXT, /npx react-native start --reset-cache/);
});
