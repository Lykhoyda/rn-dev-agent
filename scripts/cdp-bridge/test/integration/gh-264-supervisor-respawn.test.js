import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startSupervisor } from '../helpers/supervisor-harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(__dirname, '../fixtures/fake-worker.mjs');
const CRASHER = resolve(__dirname, '../fixtures/crashing-worker.mjs');

test('GH#264 supervisor: kill -9 worker → in-flight error, respawn, handshake replayed once, new pid serves', async () => {
  const s = startSupervisor({ workerPath: FAKE });
  try {
    const initId = s.send('initialize');
    const initRes = JSON.parse(await s.nextLine());
    assert.equal(initRes.id, initId);
    const pid1 = initRes.result.pid;
    assert.equal(initRes.result.supervised, '1');
    s.notify('notifications/initialized');

    const hangId = s.send('hang'); // stays in flight
    process.kill(pid1, 'SIGKILL');

    const deathErr = JSON.parse(await s.nextLine());
    assert.equal(deathErr.id, hangId);
    assert.equal(deathErr.error.code, -32000);
    assert.match(deathErr.error.message, /SIGKILL/);

    const pingId = s.send('ping');
    const pingRes = JSON.parse(await s.nextLine());
    assert.equal(pingRes.id, pingId, 'duplicate initialize response must have been swallowed');
    assert.notEqual(pingRes.result.pid, pid1, 'served by a respawned worker');
    assert.equal(pingRes.result.restarts, '1');
  } finally {
    s.child.kill('SIGTERM');
  }
});

test('GH#264 supervisor: graceful SIGTERM exits 0 without respawn', async () => {
  const s = startSupervisor({ workerPath: FAKE });
  const initId = s.send('initialize');
  await s.nextLine();
  const exited = new Promise((resolveExit) => s.child.on('exit', (code) => resolveExit(code)));
  s.child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.ok(initId >= 1);
});

test('GH#264 supervisor: crash-looping worker exhausts budget → terminal error names last exit', async () => {
  const s = startSupervisor({ workerPath: CRASHER, env: { RN_BRIDGE_MAX_RESPAWNS: '2' } });
  try {
    // The crasher dies pre-handshake repeatedly; after the budget the
    // supervisor stays alive and answers requests with the terminal error.
    await new Promise((r) => setTimeout(r, 1500)); // let the crash loop burn its budget
    const qId = s.send('tools/list');
    const reply = JSON.parse(await s.nextLine());
    assert.equal(reply.id, qId);
    assert.equal(reply.error.code, -32000);
    assert.match(reply.error.message, /crash-looping/);
    assert.match(reply.error.message, /exit code 1/);
    assert.equal(s.child.exitCode, null, 'supervisor itself stays alive');
  } finally {
    s.child.kill('SIGTERM');
  }
});

test('GH#264 supervisor: unspawnable worker (ENOENT) does NOT crash the supervisor (plan-review BLOCKER)', async () => {
  const s = startSupervisor({
    workerPath: '/nonexistent/worker.js',
    env: { RN_BRIDGE_MAX_RESPAWNS: '2' },
  });
  try {
    await new Promise((r) => setTimeout(r, 1500)); // spawn errors burn the budget
    assert.equal(s.child.exitCode, null, 'supervisor survives spawn failures');
    const qId = s.send('tools/list');
    const reply = JSON.parse(await s.nextLine());
    assert.equal(reply.id, qId);
    assert.equal(reply.error.code, -32000);
    assert.match(reply.error.message, /crash-looping/);
  } finally {
    s.child.kill('SIGTERM');
  }
});

test('GH#264 supervisor: non-ASCII JSON split mid-codepoint across raw Buffer writes stays intact (plan-review BLOCKER)', async () => {
  const s = startSupervisor({ workerPath: FAKE });
  try {
    s.send('initialize');
    await s.nextLine();
    // Hand-build a request with multi-byte UTF-8 in the method, then write
    // its bytes in two chunks split INSIDE the é codepoint. setEncoding's
    // StringDecoder must reassemble it; without it the JSON corrupts to �.
    const raw = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'écho→test', params: {} }) + '\n',
      'utf8',
    );
    const splitAt = raw.indexOf(0xc3) + 1; // first byte of the 2-byte é sequence
    s.child.stdin.write(raw.subarray(0, splitAt));
    await new Promise((r) => setTimeout(r, 50)); // force two distinct 'data' events
    s.child.stdin.write(raw.subarray(splitAt));
    const reply = JSON.parse(await s.nextLine());
    assert.equal(reply.id, 99);
    assert.equal(reply.result.echo, 'écho→test');
  } finally {
    s.child.kill('SIGTERM');
  }
});

test('GH#264 supervisor: SIGUSR2 hot-reload respawns without burning the crash budget (PR #273 review)', async () => {
  // fake-worker has no SIGUSR2 handler, so default disposition terminates it
  // (signal exit) — the supervisor must treat that as the REQUESTED reload.
  const s = startSupervisor({ workerPath: FAKE, env: { RN_BRIDGE_MAX_RESPAWNS: '1' } });
  try {
    const initId = s.send('initialize');
    const initRes = JSON.parse(await s.nextLine());
    assert.equal(initRes.id, initId);
    const pid1 = initRes.result.pid;
    s.notify('notifications/initialized');

    // Two hot-reloads with budget=1: if reloads charged the budget, the
    // second would push the core into terminal mode.
    for (let round = 1; round <= 2; round++) {
      s.child.kill('SIGUSR2');
      await new Promise((r) => setTimeout(r, 700)); // respawn + replay
      const qId = s.send('ping');
      const reply = JSON.parse(await s.nextLine());
      assert.equal(reply.id, qId, `round ${round}: session still serves`);
      assert.ok(!reply.error, `round ${round}: no terminal error`);
      assert.notEqual(reply.result.pid, pid1, `round ${round}: fresh worker`);
      assert.equal(
        reply.result.restarts,
        String(round),
        `round ${round}: telemetry counts reloads`,
      );
    }
  } finally {
    s.child.kill('SIGTERM');
  }
});

const PARTIAL = resolve(__dirname, '../fixtures/partial-then-echo-worker.mjs');

test("GH#264 supervisor: dead worker's partial stdout frame does not contaminate the respawned worker (PR #273 Codex P2)", async () => {
  // Incarnation 0 writes a partial JSON frame (no newline) and dies; the
  // splitter must not prefix the fresh worker's first line with that tail —
  // otherwise the replayed-initialize answer corrupts and garbage reaches
  // the client.
  const s = startSupervisor({ workerPath: PARTIAL });
  try {
    const initId = s.send('initialize');
    // First incarnation never answers (partial frame only) and exits 1;
    // the respawned echo incarnation answers the REPLAYED initialize.
    const initRes = JSON.parse(await s.nextLine());
    assert.equal(initRes.id, initId, "first full line is the fresh worker's initialize answer");
    assert.equal(initRes.result.echo, 'initialize');
    assert.equal(initRes.result.restarts, '1');

    const qId = s.send('ping');
    const reply = JSON.parse(await s.nextLine());
    assert.equal(reply.id, qId);
    assert.equal(reply.result.echo, 'ping');
  } finally {
    s.child.kill('SIGTERM');
  }
});

const REAL_WORKER = resolve(__dirname, '../../dist/index.js');

test('GH#264 worker SIGUSR2 exits 1 (hot-reload contract, behavioral)', async () => {
  // The supervisor's hot-reload relies on the REAL worker's SIGUSR2 path
  // exiting 1 (respawn), never 0 (which the clean-exit policy mirrors by
  // shutting the supervisor down). Pin the contract by driving dist/index.js.
  const w = spawn(process.execPath, [REAL_WORKER, '--no-lock'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  await new Promise((r) => setTimeout(r, 1200)); // let handlers register
  const exited = new Promise((resolveExit) => w.on('exit', (code) => resolveExit(code)));
  w.kill('SIGUSR2');
  assert.equal(await exited, 1, 'SIGUSR2 must exit 1 so the supervisor respawns');
});
