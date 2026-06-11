import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineSplitter } from '../../dist/lifecycle/stdio-frames.js';

test('GH#264 LineSplitter: complete lines come out, partial tail is buffered', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('{"a":1}\n{"b":'), ['{"a":1}']);
  assert.deepEqual(s.push('2}\n'), ['{"b":2}']);
});

test('GH#264 LineSplitter: multiple lines in one chunk, empty lines skipped', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('one\n\ntwo\nthree\n'), ['one', 'two', 'three']);
});

// NOTE (plan-review): this only proves STRING-level buffering. Byte-level
// codepoint splits are handled one layer up — supervisor.ts calls
// stream.setEncoding('utf8') so Node's StringDecoder holds partial UTF-8
// sequences; the integration suite has a real Buffer-split test.
test('GH#264 LineSplitter: partial line across string chunks is buffered', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('{"x":"é'), []);
  assert.deepEqual(s.push('"}\n'), ['{"x":"é"}']);
});

test('GH#264 LineSplitter: flush returns the unterminated tail once', () => {
  const s = new LineSplitter();
  s.push('partial');
  assert.equal(s.flush(), 'partial');
  assert.equal(s.flush(), null);
});
