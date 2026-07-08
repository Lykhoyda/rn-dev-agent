import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHermesStack } from '../../dist/symbolicate.js';

// ── parseHermesStack ──────────────────────────────────────────────────

test('parseHermesStack parses "at func (url:line:col)" format', () => {
  const stack = `  at myFunction (http://127.0.0.1:8081/index.bundle:123:45)`;
  const frames = parseHermesStack(stack);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].methodName, 'myFunction');
  assert.equal(frames[0].file, 'http://127.0.0.1:8081/index.bundle');
  assert.equal(frames[0].lineNumber, 123);
  assert.equal(frames[0].column, 45);
});

test('parseHermesStack parses "func@url:line:col" format', () => {
  const stack = `anonymous@/app/index.js:10:5`;
  const frames = parseHermesStack(stack);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].methodName, 'anonymous');
  assert.equal(frames[0].lineNumber, 10);
});

test('parseHermesStack parses multiple frames', () => {
  const stack = [
    '  at render (http://localhost:8081/index.bundle:100:10)',
    '  at processChild (http://localhost:8081/index.bundle:200:20)',
    '  at performWork (http://localhost:8081/index.bundle:300:30)',
  ].join('\n');
  const frames = parseHermesStack(stack);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].methodName, 'render');
  assert.equal(frames[2].methodName, 'performWork');
});

test('parseHermesStack handles anonymous functions', () => {
  const stack = `  at (http://127.0.0.1:8081/index.bundle:50:1)`;
  const frames = parseHermesStack(stack);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].methodName, '<anonymous>');
});

test('parseHermesStack returns empty array for non-stack text', () => {
  const stack = 'Error: something went wrong\n  this is not a stack frame';
  assert.deepEqual(parseHermesStack(stack), []);
});

test('parseHermesStack returns empty array for empty string', () => {
  assert.deepEqual(parseHermesStack(''), []);
});
