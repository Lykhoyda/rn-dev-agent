import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLogcatLine } from '../../dist/tools/collect-logs.js';

// Audit M4: a logcat line carries device-LOCAL wall-clock with no offset.
// `new Date("YYYY-MM-DDThh:mm:ss")` already parses as local, so getTime() is
// already the correct UTC epoch. The old code then ADDED the host UTC offset,
// double-shifting every Android entry by that offset and corrupting merge-sort
// ordering. The timestamp must equal the local-parsed instant, with no extra
// offset applied.

test('M4: logcat timestamp is not double-shifted by the host UTC offset', () => {
  // Format mirrors LOGCAT_RE: "MM-DD hh:mm:ss.mmm  PID  TID PRIO TAG: message"
  const line = '04-16 22:15:00.123  1234  1234 I MyTag: hello world';
  const year = 2026;

  const entry = parseLogcatLine(line, year);
  assert.ok(entry, 'a well-formed logcat line should parse');

  // The single correct interpretation: the same wall-clock, parsed as local.
  const expected = new Date(`${year}-04-16T22:15:00.123`).toISOString();
  assert.equal(entry.timestamp, expected);
});

test('M4: two adjacent log lines preserve monotonic ordering (no offset skew)', () => {
  const a = parseLogcatLine('04-16 22:15:00.000  1 1 I T: a', 2026);
  const b = parseLogcatLine('04-16 22:15:01.000  1 1 I T: b', 2026);
  assert.ok(new Date(a.timestamp).getTime() < new Date(b.timestamp).getTime());
});
