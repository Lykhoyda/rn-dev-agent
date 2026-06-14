// test/unit/gh-211-maestro-step-parser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSteps, stripAnsi } from '../../dist/domain/maestro-step-parser.js';

// Real maestro-runner format (same shape as the gh-263 fixtures).
const FAILED_RUN = `  ✓ launchApp (2.3s)
  ✓ tapOn: id="a" (2.8s)
  ✓ tapOn: id="b" (3.0s)
  ✓ assertVisible: text="x" (1.1s)
  ✗ tapOn: id="c" (12.7s)
✗ rn-maestro-run 23.8s`;

test('parseSteps: verb/status/durationMs/index; summary line excluded', () => {
  const steps = parseSteps(FAILED_RUN);
  assert.equal(steps.length, 5);
  assert.deepEqual(steps[0], { index: 0, name: 'launchApp', verb: 'launchApp', status: 'pass', durationMs: 2300 });
  assert.deepEqual(steps[1], { index: 1, name: 'tapOn: id="a"', verb: 'tapOn', status: 'pass', durationMs: 2800 });
  assert.deepEqual(steps[4], { index: 4, name: 'tapOn: id="c"', verb: 'tapOn', status: 'fail', durationMs: 12700 });
  assert.ok(!steps.some((s) => s.verb === 'rn-maestro-run')); // `✗ rn-maestro-run 23.8s` has no (N.Ns)
});

test('parseSteps: verb has trailing colon stripped', () => {
  assert.equal(parseSteps('  ✓ tapOn: id="a" (1.0s)')[0].verb, 'tapOn');
});

test('parseSteps: verb is first token — verb name inside a selector value is not the verb', () => {
  assert.equal(parseSteps('  ✓ assertVisible: text="tapOn now" (1.0s)')[0].verb, 'assertVisible');
});

test('parseSteps: count lines / bare text are not steps', () => {
  assert.deepEqual(parseSteps('  3 steps passing\n  1 steps failing\nRunning on iPhone'), []);
});

test('parseSteps: embedded (N.Ns) in a selector — trailing duration wins', () => {
  const steps = parseSteps('  ✓ assertVisible: text="took (2.0s)" (1.0s)');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].durationMs, 1000);
  assert.equal(steps[0].name, 'assertVisible: text="took (2.0s)"');
});

test('parseSteps: empty / garbage / non-string → [] (never throws)', () => {
  assert.deepEqual(parseSteps(''), []);
  assert.deepEqual(parseSteps('not maestro output'), []);
  assert.deepEqual(parseSteps(undefined), []);
});

test('stripAnsi: removes SGR codes; ANSI-wrapped glyph line still parses', () => {
  const ESC = String.fromCharCode(27); // ANSI escape byte (0x1b)
  const colored = `  ${ESC}[32m✓${ESC}[0m tapOn: id="a" (1.0s)`;
  assert.equal(stripAnsi(colored).includes(ESC), false);
  const steps = parseSteps(colored);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].verb, 'tapOn');
});
