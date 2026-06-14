// test/unit/gh-211-maestro-step-parser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSteps, stripAnsi, findFailedStep, lastObservedStep, summarizeReason, buildStepSummary,
  classifyExecError, formatFailureHeadline,
} from '../../dist/domain/maestro-step-parser.js';

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

test('findFailedStep: last ✗ step; null when all pass', () => {
  assert.equal(findFailedStep(parseSteps(FAILED_RUN)).name, 'tapOn: id="c"');
  assert.equal(findFailedStep(parseSteps('  ✓ launchApp (1.0s)')), null);
});

test('lastObservedStep: steps.at(-1); null when empty', () => {
  assert.equal(lastObservedStep(parseSteps(FAILED_RUN)).name, 'tapOn: id="c"');
  assert.equal(lastObservedStep([]), null);
});

test('summarizeReason: sanitized {kind, selector}; NEVER carries raw', () => {
  const r = summarizeReason(`Element with id 'submit' not found`);
  assert.deepEqual(r, { kind: 'SELECTOR_NOT_FOUND', selector: 'submit' });
  assert.equal('raw' in r, false);
});

test('summarizeReason: unrecognized output → null', () => {
  assert.equal(summarizeReason('some unrecognized output'), null);
});

test('buildStepSummary: failed=false → failedStep/reason null even with a transient ✗', () => {
  const s = buildStepSummary(FAILED_RUN, { failed: false });
  assert.equal(s.failedStep, null);
  assert.equal(s.reason, null);
  assert.equal(s.steps.length, 5);
  assert.equal(s.lastStep.name, 'tapOn: id="c"');
});

test('buildStepSummary: failed=true → failedStep + reason populated', () => {
  const out = FAILED_RUN + `\nElement with id 'c' not found`;
  const s = buildStepSummary(out, { failed: true });
  assert.equal(s.failedStep.name, 'tapOn: id="c"');
  assert.deepEqual(s.reason, { kind: 'SELECTOR_NOT_FOUND', selector: 'c' });
});

test('buildStepSummary: timeout partial (no ✗) → failedStep null, lastStep = last ✓', () => {
  const partial = `  ✓ launchApp (2.0s)\n  ✓ tapOn: id="a" (2.5s)`;
  const s = buildStepSummary(partial, { failed: true });
  assert.equal(s.failedStep, null);
  assert.equal(s.lastStep.name, 'tapOn: id="a"');
});

test('classifyExecError: timeout (killed, no code) → timedOut, not truncated', () => {
  assert.deepEqual(
    classifyExecError({ killed: true, signal: 'SIGTERM', code: null }),
    { timedOut: true, outputTruncated: false },
  );
});

test('classifyExecError: maxBuffer overflow → truncated, not timedOut', () => {
  assert.deepEqual(
    classifyExecError({ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
    { timedOut: false, outputTruncated: true },
  );
});

test('classifyExecError: normal non-zero exit → neither; null safe', () => {
  assert.deepEqual(classifyExecError({ killed: false, code: 1 }), { timedOut: false, outputTruncated: false });
  assert.deepEqual(classifyExecError(null), { timedOut: false, outputTruncated: false });
});

test('catch-path assembly: timeout → timedOut, partial steps, failedStep null', () => {
  const err = { killed: true, code: null, stdout: '  ✓ launchApp (2.0s)\n  ✓ tapOn: id="a" (2.5s)', stderr: '' };
  const combined = (err.stdout + '\n' + err.stderr).trim();
  const cls = classifyExecError(err);
  const summary = buildStepSummary(combined, { failed: true });
  assert.equal(cls.timedOut, true);
  assert.equal(cls.outputTruncated, false);
  assert.equal(summary.failedStep, null);
  assert.equal(summary.lastStep.name, 'tapOn: id="a"');
});

test('formatFailureHeadline: structured & raw-free; raw fallback only for system errors', () => {
  const t = buildStepSummary('  ✓ launchApp (2.0s)\n  ✓ tapOn: id="a" (2.5s)', { failed: true });
  assert.equal(
    formatFailureHeadline(t, { timedOut: true, outputTruncated: false }, 'Command failed: …'),
    'Maestro flow timed out after step "tapOn: id="a""',
  );
  const f = buildStepSummary('  ✗ tapOn: id="c" (12.7s)\nElement with id \'c\' not found', { failed: true });
  assert.equal(
    formatFailureHeadline(f, { timedOut: false, outputTruncated: false }, 'x'),
    'Maestro flow failed at step "tapOn: id="c"" (SELECTOR_NOT_FOUND: c)',
  );
  const empty = { steps: [], failedStep: null, reason: null, lastStep: null };
  assert.equal(
    formatFailureHeadline(empty, { timedOut: false, outputTruncated: false }, 'spawn ENOENT'),
    'Maestro flow failed: spawn ENOENT',
  );
  assert.equal(
    formatFailureHeadline(empty, { timedOut: false, outputTruncated: true }, 'x'),
    'Maestro flow output exceeded the 10MB buffer',
  );
});
