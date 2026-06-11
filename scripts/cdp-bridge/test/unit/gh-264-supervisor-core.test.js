import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  SupervisorCore,
  workerDeathErrorLine,
  terminalErrorLine,
  workerExitDetail,
  bridgeEnvState,
} from '../../dist/lifecycle/supervisor-core.js';

const req = (id, method) => JSON.stringify({ jsonrpc: '2.0', id, method, params: {} });
const res = (id, result = {}) => JSON.stringify({ jsonrpc: '2.0', id, result });
const note = (method) => JSON.stringify({ jsonrpc: '2.0', method });

test('GH#264 core: requests forward to worker, responses forward to client', () => {
  const core = new SupervisorCore();
  assert.deepEqual(core.onClientLine(req(1, 'initialize')), [{ kind: 'toWorker', line: req(1, 'initialize') }]);
  assert.deepEqual(core.onWorkerLine(res(1)), [{ kind: 'toClient', line: res(1) }]);
});

test('GH#264 core: non-JSON client line forwards verbatim (tolerant)', () => {
  const core = new SupervisorCore();
  assert.deepEqual(core.onClientLine('not json'), [{ kind: 'toWorker', line: 'not json' }]);
});

test('GH#264 core: worker death errors out in-flight requests with -32000 and respawns', () => {
  const core = new SupervisorCore();
  core.onClientLine(req(1, 'initialize'));
  core.onWorkerLine(res(1));
  core.onClientLine(note('notifications/initialized'));
  core.onClientLine(req(2, 'tools/call'));            // in flight — never answered
  const actions = core.onWorkerExit(null, 'SIGKILL', false);
  assert.deepEqual(actions[0], { kind: 'toClient', line: workerDeathErrorLine(2, 'signal SIGKILL') });
  assert.deepEqual(actions[1], { kind: 'spawn' });
  const parsed = JSON.parse(workerDeathErrorLine(2, 'signal SIGKILL'));
  assert.equal(parsed.error.code, -32000);
  assert.match(parsed.error.message, /retry/);
});

test('GH#264 core: worker death does NOT -32000 the initialize id (handshake is replayable, not retryable)', () => {
  const core = new SupervisorCore();
  core.onClientLine(req(1, 'initialize'));             // in flight — worker dies before answering
  const actions = core.onWorkerExit(null, 'SIGKILL', false);
  assert.ok(!actions.some((a) => a.kind === 'toClient'), 'no death error for the initialize id');
  assert.deepEqual(actions.at(-1), { kind: 'spawn' });
});

test('GH#264 core: crash BEFORE the first initialize response — fresh worker answer forwards to client (no swallow)', () => {
  const core = new SupervisorCore();
  core.onClientLine(req(1, 'initialize'));
  core.onWorkerExit(null, 'SIGKILL', false);
  const replay = core.onSpawned();
  assert.deepEqual(replay[0], { kind: 'toWorker', line: req(1, 'initialize') });
  // Claude Code never saw an initialize response — the fresh worker's answer
  // must reach it, not be swallowed.
  assert.deepEqual(core.onWorkerLine(res(1)), [{ kind: 'toClient', line: res(1) }]);
  assert.equal(core.state, 'running');
});

test('GH#264 core: replay cached initialize+initialized on respawn, swallow duplicate response, flush queue', () => {
  const core = new SupervisorCore();
  core.onClientLine(req(1, 'initialize'));
  core.onWorkerLine(res(1));
  core.onClientLine(note('notifications/initialized'));
  core.onWorkerExit(1, null, false);                   // crash → restarting
  core.onClientLine(req(3, 'tools/call'));             // arrives mid-restart → queued
  const replay = core.onSpawned();
  assert.deepEqual(replay, [
    { kind: 'toWorker', line: req(1, 'initialize') },
    { kind: 'toWorker', line: note('notifications/initialized') },
  ]);
  // duplicate initialize response from the fresh worker is swallowed; queue flushes
  assert.deepEqual(core.onWorkerLine(res(1)), [{ kind: 'toWorker', line: req(3, 'tools/call') }]);
  // and the queued request's eventual response forwards normally
  assert.deepEqual(core.onWorkerLine(res(3)), [{ kind: 'toClient', line: res(3) }]);
});

test('GH#264 core: death BEFORE any initialize respawns without replay and flushes nothing', () => {
  const core = new SupervisorCore();
  const actions = core.onWorkerExit(1, null, false);
  assert.deepEqual(actions, [{ kind: 'spawn' }]);
  assert.deepEqual(core.onSpawned(), []);
  assert.equal(core.state, 'running');
});

test('GH#264 core: respawn budget — 3 per rolling 60s, then terminal mode with explanatory errors', () => {
  let t = 0;
  const core = new SupervisorCore({ maxRespawns: 3, windowMs: 60_000, now: () => t });
  core.onClientLine(req(1, 'initialize'));
  core.onWorkerLine(res(1));
  for (let i = 0; i < 3; i++) {
    t += 1000;
    const a = core.onWorkerExit(1, null, false);
    assert.deepEqual(a.at(-1), { kind: 'spawn' }, `respawn ${i + 1} allowed`);
    core.onSpawned();
    core.onWorkerLine(res(1)); // swallow replay response
  }
  t += 1000;
  const final = core.onWorkerExit(1, null, false);
  assert.ok(!final.some((a) => a.kind === 'spawn'), 'budget exhausted — no 4th respawn');
  assert.equal(core.state, 'terminal');
  const reply = core.onClientLine(req(9, 'tools/call'));
  assert.equal(reply.length, 1);
  const err = JSON.parse(reply[0].line);
  assert.equal(err.error.code, -32000);
  assert.match(err.error.message, /crash-looping/);
  assert.match(err.error.message, /exit code 1/);
  // notifications in terminal mode are dropped silently
  assert.deepEqual(core.onClientLine(note('notifications/cancelled')), []);
});

test('GH#264 core: crashes spaced beyond the window never exhaust the budget', () => {
  let t = 0;
  const core = new SupervisorCore({ maxRespawns: 3, windowMs: 60_000, now: () => t });
  for (let i = 0; i < 10; i++) {
    t += 61_000;
    const a = core.onWorkerExit(1, null, false);
    assert.deepEqual(a.at(-1), { kind: 'spawn' }, `respawn ${i + 1} allowed (window slid)`);
    core.onSpawned();
  }
});

test('GH#264 core: clean exit 0 (no signal, not shutdown) exits the supervisor instead of respawning', () => {
  const core = new SupervisorCore();
  assert.deepEqual(core.onWorkerExit(0, null, false), [{ kind: 'exit', code: 0 }]);
});

test('GH#264 core: supervisor-initiated shutdown exits 0 with no death errors', () => {
  const core = new SupervisorCore();
  core.onClientLine(req(5, 'tools/call'));
  assert.deepEqual(core.onWorkerExit(null, 'SIGTERM', true), [{ kind: 'exit', code: 0 }]);
});

test('GH#264 workerExitDetail: signal wins over code', () => {
  assert.equal(workerExitDetail(null, 'SIGKILL'), 'signal SIGKILL');
  assert.equal(workerExitDetail(1, null), 'exit code 1');
});

test('GH#264 terminalErrorLine: names last exit and the RESOLVED bridge log path', () => {
  const err = JSON.parse(terminalErrorLine(7, 'signal SIGKILL', '/var/folders/x/bridge.log'));
  assert.equal(err.id, 7);
  assert.match(err.error.message, /signal SIGKILL/);
  assert.match(err.error.message, /\/var\/folders\/x\/bridge\.log/);
  // No log file at the current LOG_LEVEL → point at the env var instead of a
  // path that does not exist (plan-review: tmpdir() was wrong — logger.ts
  // resolves CLAUDE_PLUGIN_DATA / ~/.claude/logs first, and warn writes none).
  const noLog = JSON.parse(terminalErrorLine(7, 'exit code 1', null));
  assert.match(noLog.error.message, /LOG_LEVEL/);
});

test('GH#264 core: workerRestarts is monotonic lifetime telemetry, distinct from the windowed budget', () => {
  let t = 0;
  const core = new SupervisorCore({ maxRespawns: 3, windowMs: 60_000, now: () => t });
  for (let i = 0; i < 5; i++) {
    t += 61_000;                                        // window always slides — budget never exhausts
    core.onWorkerExit(1, null, false);
    core.onSpawned();
  }
  assert.equal(core.restartCount, 5, 'monotonic — does not shrink as the window slides');
});

test('GH#264 bridgeEnvState: unsupervised by default, parses supervisor-set env', () => {
  assert.deepEqual(bridgeEnvState({}), { supervised: false, workerRestarts: 0, lastWorkerExit: null });
  assert.deepEqual(
    bridgeEnvState({ RN_BRIDGE_SUPERVISED: '1', RN_BRIDGE_RESTARTS: '2', RN_BRIDGE_LAST_EXIT: 'signal SIGKILL' }),
    { supervised: true, workerRestarts: 2, lastWorkerExit: 'signal SIGKILL' },
  );
  assert.equal(bridgeEnvState({ RN_BRIDGE_RESTARTS: 'garbage' }).workerRestarts, 0);
});

const statusSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../src/tools/status.ts'), 'utf8');

test('GH#264 cdp_status wires bridgeEnvState into the status result', () => {
  assert.match(statusSrc, /bridge:\s*bridgeEnvState\(process\.env\)/);
});

// Supervision facts are env-derived and must be visible exactly when the
// bridge is unhealthy — the connect-failure paths (APP_DETACHED, picker,
// generic) carry them alongside reconnect/autoConnect (live-gate finding:
// a sim with no Hermes target hid bridge.* entirely).
test('GH#264 cdp_status failure paths also carry bridge supervision facts', () => {
  const wired = (statusSrc.match(/bridge:\s*bridgeEnvState\(process\.env\)/g) ?? []).length;
  assert.ok(wired >= 4, `expected bridge on success + 3 failure paths, found ${wired}`);
});

// Plan-review pin: the supervisor's hot-reload forwards SIGUSR2 to the worker
// and relies on the worker's documented `SIGUSR2 → shutdown(1)` (exit code 1
// → respawn). If someone "fixes" that to shutdown(0), the clean-exit-0 policy
// would make SIGUSR2 silently kill the whole session instead of reloading.
const indexSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../src/index.ts'), 'utf8');

test('GH#264 worker SIGUSR2 stays exit-1 (hot-reload contract with the supervisor)', () => {
  assert.match(indexSrc, /SIGUSR2[\s\S]{0,200}?shutdown\(1\)/);
});

// Review finding (Gemini, PR #273): SIGUSR2 hot-reload exits 1, which charged
// the crash budget — 3 intentional reloads in 60s wedged the bridge into
// terminal mode. A requested reload respawns + replays + counts in restart
// telemetry, but never burns the anti-crash-loop budget.
test('GH#264 core: hot-reload exits never charge the respawn budget (no terminal wedge)', () => {
  let t = 0;
  const core = new SupervisorCore({ maxRespawns: 3, windowMs: 60_000, now: () => t });
  core.onClientLine(req(1, 'initialize'));
  core.onWorkerLine(res(1));
  for (let i = 0; i < 5; i++) {
    t += 1000;
    core.onHotReloadRequested();
    const a = core.onWorkerExit(1, null, false);
    assert.deepEqual(a.at(-1), { kind: 'spawn' }, `hot-reload ${i + 1} respawns`);
    core.onSpawned();
    core.onWorkerLine(res(1));                          // swallow replay response
  }
  assert.equal(core.state, 'running');
  assert.equal(core.restartCount, 5, 'reloads still count as restarts (telemetry)');
  // a REAL crash right after still has its full budget
  t += 1000;
  assert.deepEqual(core.onWorkerExit(1, null, false).at(-1), { kind: 'spawn' });
});

test('GH#264 core: hot-reload flag is one-shot — a later real crash charges the budget', () => {
  let t = 0;
  const core = new SupervisorCore({ maxRespawns: 1, windowMs: 60_000, now: () => t });
  core.onHotReloadRequested();
  t += 1000;
  core.onWorkerExit(1, null, false);                    // the requested reload — free
  core.onSpawned();
  t += 1000;
  core.onWorkerExit(1, null, false);                    // real crash #1 — charges
  core.onSpawned();
  t += 1000;
  const a = core.onWorkerExit(1, null, false);          // real crash #2 — budget (1) gone
  assert.ok(!a.some((x) => x.kind === 'spawn'));
  assert.equal(core.state, 'terminal');
});
