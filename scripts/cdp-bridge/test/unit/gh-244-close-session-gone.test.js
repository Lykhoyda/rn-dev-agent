import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDeviceSession,
  isBenignSessionGoneError,
} from '../../dist/tools/device-session-close.js';

const okClose = () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { closed: true } }) }] });
// Mirror the real runAgentDevice failure envelope: failResult(message, { code, hint }) puts the
// code under meta (utils.ts:67-73), so meta.code — not a top-level code — is authoritative.
const errClose = (error, code) => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: false, error, ...(code ? { meta: { code } } : {}) }) }],
  isError: true,
});

test('#244 no in-memory session → ok no-op; underlying close NOT called', async () => {
  const calls = { clear: 0, stop: 0, release: 0, close: 0 };
  const r = await closeDeviceSession({
    hasActiveSession: () => false,
    closeUnderlyingSession: async () => { calls.close++; return okClose(); },
    clearActiveSession: () => { calls.clear++; },
    stopFastRunner: () => { calls.stop++; },
    releaseDeviceLock: () => { calls.release++; },
  });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /No active session to close/);
  assert.equal(calls.close, 0);
});

test('#244 close succeeds → ok; cleanup all called once', async () => {
  const calls = { clear: 0, stop: 0, release: 0, close: 0 };
  const r = await closeDeviceSession({
    hasActiveSession: () => true,
    closeUnderlyingSession: async () => { calls.close++; return okClose(); },
    clearActiveSession: () => { calls.clear++; },
    stopFastRunner: () => { calls.stop++; },
    releaseDeviceLock: () => { calls.release++; },
  });
  assert.equal(r.isError, undefined);
  assert.deepEqual(calls, { clear: 1, stop: 1, release: 1, close: 1 });
});

test('#244 SESSION_NOT_FOUND after a flow → ok with sessionAlreadyGone; cleanup all called', async () => {
  const calls = { clear: 0, stop: 0, release: 0, close: 0 };
  const r = await closeDeviceSession({
    hasActiveSession: () => true,
    closeUnderlyingSession: async () => { calls.close++; return errClose('No active session', 'SESSION_NOT_FOUND'); },
    clearActiveSession: () => { calls.clear++; },
    stopFastRunner: () => { calls.stop++; },
    releaseDeviceLock: () => { calls.release++; },
  });
  assert.equal(r.isError, undefined);
  const env = JSON.parse(r.content[0].text);
  assert.equal(env.data.sessionAlreadyGone, true);
  assert.deepEqual(calls, { clear: 1, stop: 1, release: 1, close: 1 });
});

test('#244 unrelated close error → surfaced as-is; cleanup NOT called', async () => {
  const calls = { clear: 0, stop: 0, release: 0, close: 0 };
  const r = await closeDeviceSession({
    hasActiveSession: () => true,
    closeUnderlyingSession: async () => { calls.close++; return errClose('adb: device offline', 'BAD_RESPONSE'); },
    clearActiveSession: () => { calls.clear++; },
    stopFastRunner: () => { calls.stop++; },
    releaseDeviceLock: () => { calls.release++; },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /device offline/);
  assert.deepEqual(calls, { clear: 0, stop: 0, release: 0, close: 1 });
});

test('#244 isBenignSessionGoneError matches only gone-session shapes', () => {
  assert.equal(isBenignSessionGoneError(errClose('No active session', 'SESSION_NOT_FOUND')), true); // meta.code
  assert.equal(isBenignSessionGoneError(errClose('session not found')), true);                      // message fallback
  assert.equal(isBenignSessionGoneError(errClose('adb: device offline', 'BAD_RESPONSE')), false);
  assert.equal(isBenignSessionGoneError(okClose()), false);
  // precision: an unrelated failure whose HINT mentions the phrase must NOT be swallowed
  const withHint = {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'adb: device offline', meta: { code: 'BAD_RESPONSE', hint: 'no active session? call open first' } }) }],
    isError: true,
  };
  assert.equal(isBenignSessionGoneError(withHint), false);
});
