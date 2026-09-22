import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  STARTUP_ROW_FIELDS,
  WIRE_VERSION,
  createWriter,
  exitCodeFor,
  missingResult,
  parseEnvelope,
  parseRequest,
  readRequest,
  startupRow,
  verdictAgrees,
} from '../../../dist/qa/wire.js';
import type { WireRequest } from '../../../dist/qa/wire.js';
import { buildLedger } from '../../../dist/qa/ledger.js';
import type { LedgerRow } from '../../../dist/qa/ledger.js';

const request: WireRequest = {
  runId: 'check-1',
  t0: 1_770_000_000_000,
  plan: '1. Tap "A"\n',
  platform: 'ios',
  appId: 'com.example.app',
  runDir: '/tmp/qaren/runs/check-1',
  lease: 'check-1:0123456789abcdef0123456789abcdef',
  target: {
    deviceId: 'UDID',
    metroPort: 8791,
    metroUrlForDevice: 'http://127.0.0.1:8791',
    worktree: '/tmp/app',
  },
};

const row = (line: number): LedgerRow => ({
  block: 'plan',
  line,
  text: `${line}. Tap "A"`,
  attempt: 1,
  kind: 'step',
  resolvedBy: 'exact',
  ref: '@e1',
  screenshot: `screenshots/0${line}-line${line}.png`,
  t: line * 100,
  outcome: 'pass',
});

test('envelopes round-trip with increasing seq after the request', async () => {
  const lines: string[] = [];
  const writer = createWriter((line) => lines.push(line), 'check-1');
  writer.row(startupRow());
  writer.row(row(1));
  const exit = writer.result(
    buildLedger([{ key: 'plan', outcome: 'pass', source: 'discovered' }], [row(1)]),
  );
  assert.equal(exit, 0);
  assert.equal(writer.seq, 4);
  const parsed = lines.map((l) => parseEnvelope(l.trim()));
  assert.deepEqual(
    parsed.map((e) => [e?.v, e?.runId, e?.seq, e?.type]),
    [
      [WIRE_VERSION, 'check-1', 2, 'row'],
      [WIRE_VERSION, 'check-1', 3, 'row'],
      [WIRE_VERSION, 'check-1', 4, 'result'],
    ],
  );
  assert.ok(
    lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n')),
    'one JSON object per line',
  );

  const requestLine = `${JSON.stringify({ v: 1, runId: 'check-1', seq: 1, type: 'request', payload: request })}\n`;
  assert.deepEqual(parseRequest(requestLine.trim()), request);
  assert.deepEqual(
    await readRequest(Readable.from([requestLine.slice(0, 20), requestLine.slice(20)])),
    request,
  );
});

test('the result verdict and the exit code agree', () => {
  const pass = buildLedger([], []);
  const fail = buildLedger([], [row(1)], { step: 1, seen: 'nothing' });
  assert.equal(exitCodeFor(pass), 0);
  assert.equal(exitCodeFor(fail), 1);
  assert.equal(
    exitCodeFor({
      verdict: 'REFUSED',
      code: 'METRO_ORIGIN_MISMATCH',
      message: 'port',
      lease: request.lease,
    }),
    4,
  );
  for (const [verdict, exit, agrees] of [
    ['PASS', 0, true],
    ['FAIL', 1, true],
    ['REFUSED', 4, true],
    ['PASS', 1, false],
    ['FAIL', 0, false],
    ['REFUSED', 0, false],
    ['PASS', 4, false],
  ] as const) {
    assert.equal(verdictAgrees(verdict, exit), agrees, `${verdict}/${exit}`);
  }
});

test('a missing result is a FAIL attributed to the last row, and the startup row carries the required fields', () => {
  const rows = [startupRow(), row(1), row(2)];
  const ledger = missingResult(rows, 'the child died');
  assert.equal(ledger.verdict, 'FAIL');
  assert.deepEqual(ledger.failure, {
    step: 2,
    seen: 'the child died',
    screenshot: 'screenshots/02-line2.png',
  });
  assert.equal(ledger.steps.length, 3);
  assert.equal(exitCodeFor(ledger), 1);

  const onlyStartup = missingResult([startupRow()], 'died at startup');
  assert.deepEqual(onlyStartup.failure, { step: 0, seen: 'died at startup' });
  const startup = startupRow() as unknown as Record<string, unknown>;
  for (const field of STARTUP_ROW_FIELDS) assert.ok(field in startup, field);
  assert.equal(startup.line, 0);
  assert.equal(startup.outcome, 'pass');
});

test('malformed envelopes and requests are rejected', () => {
  assert.equal(parseEnvelope('not json'), null);
  assert.equal(
    parseEnvelope(JSON.stringify({ v: 2, runId: 'x', seq: 1, type: 'row', payload: {} })),
    null,
  );
  assert.equal(
    parseEnvelope(JSON.stringify({ v: 1, runId: 'x', seq: 1, type: 'bogus', payload: {} })),
    null,
  );
  assert.throws(
    () => parseRequest(JSON.stringify({ v: 1, runId: 'x', seq: 1, type: 'row', payload: {} })),
    /expected a request/,
  );
  assert.throws(
    () =>
      parseRequest(
        JSON.stringify({
          v: 1,
          runId: 'x',
          seq: 1,
          type: 'request',
          payload: { ...request, target: undefined },
        }),
      ),
    /missing required fields/,
  );
  assert.throws(
    () =>
      parseRequest(
        JSON.stringify({ v: 1, runId: 'other', seq: 1, type: 'request', payload: request }),
      ),
    /names another run/,
  );
  assert.throws(
    () =>
      parseRequest(
        JSON.stringify({ v: 1, runId: 'check-1', seq: 2, type: 'request', payload: request }),
      ),
    /seq 1/,
  );
  assert.throws(
    () =>
      parseRequest(
        JSON.stringify({
          v: 1,
          runId: 'check-1',
          seq: 1,
          type: 'request',
          payload: { ...request, target: { ...request.target, metroPort: 70000 } },
        }),
      ),
    /missing required fields/,
  );
});

test('a multibyte character split across chunks still decodes', async () => {
  const line = `${JSON.stringify({ v: 1, runId: 'check-1', seq: 1, type: 'request', payload: { ...request, plan: '✓ "Tasks"\n' } })}\n`;
  const bytes = Buffer.from(line, 'utf8');
  const cut = bytes.indexOf(Buffer.from('✓', 'utf8')) + 1;
  const parsed = await readRequest(Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]));
  assert.equal(parsed.plan, '✓ "Tasks"\n');
});

test('nothing may follow the result line', () => {
  const writer = createWriter(() => undefined, 'check-1');
  writer.result(buildLedger([], []));
  assert.throws(() => writer.row(row(1)), /already written/);
  assert.throws(() => writer.result(buildLedger([], [])), /already written/);
});
