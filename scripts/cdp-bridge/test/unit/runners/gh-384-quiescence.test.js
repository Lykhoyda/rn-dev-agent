import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReadySignalParser,
  parseReadySignal,
} from '../../../dist/runners/rn-fast-runner-client.js';

const READY = 'RN_FAST_RUNNER_LISTENER_READY\nRN_FAST_RUNNER_PORT=22088\n';

test('parser captures QUIESCENCE_BYPASS_ACTIVE marker before READY', () => {
  const result = parseReadySignal(
    `2026-07-02 10:00:00 Runner[1:2] RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE\n${READY}`,
  );
  assert.deepEqual(result, { ready: true, port: 22088, quiescence: 'active' });
});

test('parser captures DISABLED and UNAVAILABLE markers', () => {
  assert.deepEqual(
    parseReadySignal(`RN_FAST_RUNNER_QUIESCENCE_BYPASS_DISABLED\n${READY}`),
    { ready: true, port: 22088, quiescence: 'disabled' },
  );
  assert.deepEqual(
    parseReadySignal(`RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE\n${READY}`),
    { ready: true, port: 22088, quiescence: 'unavailable' },
  );
});

test('parser omits quiescence when no marker seen (old runner binary)', () => {
  assert.deepEqual(parseReadySignal(READY), { ready: true, port: 22088 });
});

test('parser handles marker split across chunk boundaries', () => {
  const parser = createReadySignalParser();
  assert.equal(parser.feed('RN_FAST_RUNNER_QUIESCENCE_BYPASS_AC'), null);
  assert.equal(parser.feed('TIVE\nRN_FAST_RUNNER_LISTENER_READY\n'), null);
  assert.deepEqual(parser.feed('RN_FAST_RUNNER_PORT=9999\n'), {
    ready: true,
    port: 9999,
    quiescence: 'active',
  });
});

test('failure markers still win over quiescence markers', () => {
  const result = parseReadySignal(
    'RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE\nRN_FAST_RUNNER_LISTENER_FAILED\n',
  );
  assert.deepEqual(result, { error: 'RN_FAST_RUNNER_LISTENER_FAILED' });
});
