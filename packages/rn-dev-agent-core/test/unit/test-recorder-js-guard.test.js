// M6 / Phase 112: structural guards on the injected JS strings.
//
// These tests can't run the JS — Hermes is required for that. Instead they
// pin invariants by asserting source-string contents. Catch silent regressions
// when someone "improves" the IIFE and accidentally drops the eviction policy
// or the renderer-loop port.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEV_CHECK_JS,
  START_RECORDING_JS,
  STOP_RECORDING_JS,
  READ_EVENTS_JS,
  buildAnnotationJs,
} from '../../dist/cdp/test-recorder-helpers.js';

test('M6 JS guard: DEV_CHECK_JS probes __DEV__', () => {
  assert.match(DEV_CHECK_JS, /__DEV__/);
  assert.match(DEV_CHECK_JS, /=== true/);
});

test('M6 JS guard: START preserves origFreeze and overrides Object.freeze', () => {
  assert.match(START_RECORDING_JS, /var origFreeze = Object\.freeze/);
  assert.match(START_RECORDING_JS, /Object\.freeze = function\(obj\)/);
  assert.match(START_RECORDING_JS, /return origFreeze\.call\(this, obj\)/);
});

test('M6 JS guard: START installs __METRO_MCP_REC_CLEANUP__ and restores both hooks', () => {
  assert.match(START_RECORDING_JS, /globalThis\.__METRO_MCP_REC_CLEANUP__ = function/);
  assert.match(START_RECORDING_JS, /Object\.freeze = origFreeze/);
  assert.match(START_RECORDING_JS, /hook\.onCommitFiberRoot = origCommit/);
});

test('M6 JS guard: START uses obj.__mcpRec idempotency flag', () => {
  assert.match(START_RECORDING_JS, /!obj\.__mcpRec/);
  assert.match(START_RECORDING_JS, /obj\.__mcpRec = true/);
});

test('M6 JS guard: START contains the M8 1..5 renderer loop', () => {
  assert.match(START_RECORDING_JS, /for \(var ri = 1; ri <= 5; ri\+\+\)/);
  assert.match(START_RECORDING_JS, /hook\.getFiberRoots\(ri\)/);
});

test('M6 JS guard: START documents the finger-direction deviation vs metro-mcp', () => {
  // The deviation comment lives at the top of the file (header) and inline.
  assert.match(START_RECORDING_JS, /finger went UP/);
  // Sign convention asserts: dy>0 → up, dx>0 → left
  assert.match(START_RECORDING_JS, /dy > 0 \? 'up'\s*:\s*'down'/);
  assert.match(START_RECORDING_JS, /dx > 0 \? 'left'\s*:\s*'right'/);
});

test('M6 JS guard: START enforces 500-event cap with eviction', () => {
  assert.match(START_RECORDING_JS, /MAX_EVENTS = 500/);
  assert.match(START_RECORDING_JS, /__METRO_MCP_REC_TRUNCATED__ = true/);
  // Eviction prefers swipe/type over taps + navigates
  assert.match(START_RECORDING_JS, /'swipe' \|\| evts\[i\]\.type === 'type'/);
});

test('M6 JS guard: START wraps all 7 metro-mcp handlers', () => {
  for (const handler of [
    'onPress',
    'onLongPress',
    'onChangeText',
    'onSubmitEditing',
    'onScrollBeginDrag',
    'onScrollEndDrag',
    'onMomentumScrollEnd',
  ]) {
    assert.ok(
      START_RECORDING_JS.includes(handler),
      `handler ${handler} should appear in START_RECORDING_JS`,
    );
  }
});

test('M6 JS guard: START walks fibers for already-mounted scroll containers', () => {
  assert.match(START_RECORDING_JS, /isScrollFiber/);
  assert.match(START_RECORDING_JS, /forceUpdate/);
  assert.match(START_RECORDING_JS, /overrideProps/);
  assert.match(START_RECORDING_JS, /__mcpInit/);
});

test('M6 JS guard: STOP calls cleanup and reads truncated flag', () => {
  assert.match(STOP_RECORDING_JS, /__METRO_MCP_REC_CLEANUP__/);
  assert.match(STOP_RECORDING_JS, /__METRO_MCP_REC_TRUNCATED__/);
});

test('M6 JS guard: READ_EVENTS_JS surfaces active + truncated + events', () => {
  assert.match(READ_EVENTS_JS, /__METRO_MCP_REC_ACTIVE__/);
  assert.match(READ_EVENTS_JS, /__METRO_MCP_REC_EVENTS__/);
});

test('M6 JS guard: buildAnnotationJs gates on REC_ACTIVE and JSON-encodes the note', () => {
  const js = buildAnnotationJs('hello "world"');
  assert.match(js, /__METRO_MCP_REC_ACTIVE__/);
  assert.match(js, /note:\s*"hello \\"world\\""/);
});

test('M6 JS guard: buildAnnotationJs reads the cached nav ref', () => {
  const js = buildAnnotationJs('test');
  assert.match(js, /__METRO_MCP_NAV_REF_CACHE__/);
});

// Review fix (Gemini, conf 80): session token to prevent stale wrappers from
// previous start-stop cycles emitting events with stale closure state in the
// next session. Each wrapper checks its captured sessionId against the
// current global before firing.
test('M6 JS guard: START installs a session token + wrappers gate on it', () => {
  assert.match(START_RECORDING_JS, /__METRO_MCP_REC_SESSION__\s*=\s*sessionId/);
  assert.match(START_RECORDING_JS, /globalThis\.__METRO_MCP_REC_SESSION__\s*===\s*sessionId/);
});
