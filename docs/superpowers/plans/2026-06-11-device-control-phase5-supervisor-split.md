# Device Control Phase 5 — Bridge Supervisor Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The MCP bridge survives Metro restarts — including `lsof -ti tcp:8081 | xargs kill -9` — by splitting into a thin stdio supervisor (zero network sockets, immune to port-based kills) and a respawnable worker that owns all CDP/Metro/runner connections (#264).

**Architecture:** `dist/supervisor.js` becomes the MCP entry point. It pipes newline-delimited JSON-RPC between Claude Code and a spawned worker (today's `dist/index.js`), caches the `initialize` handshake, and on worker death: errors out in-flight requests (`-32000`), respawns within a bounded budget (3 per rolling 60 s), replays the cached handshake to the fresh worker, and swallows the duplicate response. The single-instance `Lockfile` + parent-death watch move to the supervisor (the durable per-project singleton); the worker runs `--no-lock` and keeps the UDID device lock (session-scoped by design). All protocol logic lives in a pure, injectable state machine (`SupervisorCore`) so the hard cases are unit-tested without processes.

**Tech Stack:** TypeScript (Node >= 22, ESM), `node:child_process.spawn`, `node --test` (unit against `dist/`, integration with scripted fake workers), changesets.

**Spec:** `docs/superpowers/specs/2026-06-10-device-control-phase4-6-rethink-design.md` §2.
**Branch:** `feat/202-phase5-supervisor` off `main`.

**Workflow reminder (repo standard):** run the multi-LLM plan review (`/brainstorm` with this plan + `src/index.ts` lifecycle region + `lifecycle/lockfile.ts`) BEFORE Task 1; amend this plan with findings. TDD per task; signed, small commits; changeset; live gates before PR.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `scripts/cdp-bridge/src/lifecycle/stdio-frames.ts` | Create | `LineSplitter` — chunk→line buffering for newline-delimited JSON-RPC |
| `scripts/cdp-bridge/src/lifecycle/supervisor-core.ts` | Create | Pure state machine: handshake cache/replay, pending tracking, death errors, respawn budget, terminal mode, `bridgeEnvState` |
| `scripts/cdp-bridge/src/supervisor.ts` | Create | Entry wiring: escape hatch, spawn/pipes/signals, lockfile + parent-death watch ownership |
| `scripts/cdp-bridge/src/tools/status.ts` | Modify (~line 110) | `bridge: { supervised, workerRestarts, lastWorkerExit }` in `cdp_status` |
| `.claude-plugin/plugin.json` | Modify (~line 58) | MCP entry `dist/index.js` → `dist/supervisor.js` |
| `scripts/cdp-bridge/test/unit/gh-264-stdio-frames.test.js` | Create | LineSplitter unit tests |
| `scripts/cdp-bridge/test/unit/gh-264-supervisor-core.test.js` | Create | State-machine unit tests (the heart of the feature) |
| `scripts/cdp-bridge/test/fixtures/fake-worker.mjs` | Create | Scripted echo worker for integration tests |
| `scripts/cdp-bridge/test/fixtures/crashing-worker.mjs` | Create | Insta-crash worker for budget tests |
| `scripts/cdp-bridge/test/integration/gh-264-supervisor-respawn.test.js` | Create | Real-process supervisor tests (CI runs `test/integration/*.test.js`) |
| `scripts/cdp-bridge/eval/gate-264-supervisor.mjs` | Create (gitignored, local) | Live gate with the REAL worker |
| `CLAUDE.md`, `docs-site/.../architecture.mdx`, `docs-site/.../troubleshooting.mdx` | Modify | document the split + #264 fix |
| `.changeset/phase5-supervisor-split.md` | Create | release note |

Engineer notes:
- Unit tests import from `../../dist/...` — `npm run build` first; `npm test` = build + unit suite. CI runs unit AND integration suites (`.github/workflows/ci.yml`).
- MCP stdio framing is **newline-delimited JSON** (one JSON-RPC message per `\n`-terminated line) — that's what `StdioServerTransport` speaks; the supervisor never needs Content-Length framing.
- House rules: explicit type imports, comments only for constraints code can't show, fail-open.
- `index.ts` needs NO changes for locking — the worker is spawned with `--no-lock` (flag already exists, `index.ts:113`). The worker's parent-death watch stays: its initial PPID is the supervisor, so a dead supervisor → worker self-exits (and lockfile heartbeat is already null-safe under `--no-lock`).
- The worker's existing `SIGUSR2 → exit 1` path (`index.ts:1190`, documented "for future supervisor wiring") becomes REAL hot-reload: supervisor forwards SIGUSR2 → worker exits 1 → respawn + replay.

---

### Task 0: Diagnosis matrix (live, NO code) — spec §2 mandates this before Task 1

**Files:** none committed (uses a throwaway probe under `scripts/cdp-bridge/eval/`, gitignored)

- [ ] **Step 1: Write the probe** — create `scripts/cdp-bridge/eval/diag-264-matrix.mjs`:

```javascript
#!/usr/bin/env node
// #264 diagnosis: spawn the CURRENT single-process bridge, hold a session,
// print liveness + metro status every 2s while you kill Metro in another
// terminal four different ways.
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [new URL('../dist/index.js', import.meta.url).pathname, '--no-lock'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
let id = 0;
const send = (method, params = {}) =>
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
// Buffer partial lines across 'data' events — a JSON-RPC response split
// across stdout chunks must not be dropped as parse garbage (codex-pair MED).
let diagBuf = '';
child.stdout.on('data', (c) => {
  diagBuf += c.toString('utf8');
  const parts = diagBuf.split('\n');
  diagBuf = parts.pop() ?? '';
  for (const line of parts.filter(Boolean)) {
    try {
      const m = JSON.parse(line);
      const text = m.result?.content?.[0]?.text ?? '';
      const metro = /"(metro|status)"\s*:\s*"?([a-zA-Z0-9_-]+)/.exec(text)?.[0] ?? text.slice(0, 80);
      console.log(`[diag] response id=${m.id} ${metro}`);
    } catch { console.log(`[diag] raw: ${line.slice(0, 120)}`); }
  }
});
child.on('exit', (code, signal) => {
  console.log(`[diag] BRIDGE DIED: code=${code} signal=${signal} at ${new Date().toISOString()}`);
  process.exit(0);
});
send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'diag', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
setInterval(() => send('tools/call', { name: 'cdp_status', arguments: {} }), 2000);
console.log(`[diag] bridge pid ${child.pid} — now kill Metro per the matrix; Ctrl-C to stop`);
```

- [ ] **Step 2: Run the matrix.** Precondition: Metro running for the workspace test-app (`cd ../rn-dev-agent-workspace/test-app && npx expo start`), app loaded on the booted simulator. Then `cd scripts/cdp-bridge && npm run build && node eval/diag-264-matrix.mjs`, wait until `cdp_status` responses show a connected state, and in a second terminal run each variant (restarting Metro between variants):
  - (a) graceful stop: Ctrl-C in the Metro terminal
  - (b) kill by PID: `kill -9 <metro-pid>` (PID from `lsof -ti tcp:8081` — pick the node/expo process, NOT the diag bridge)
  - (c) kill-by-port: `lsof -ti tcp:8081 | xargs kill -9` (kills every PID on the port — including the bridge if it holds a socket)
  - (d) after each: start Metro fresh and watch whether `cdp_status` responses resume.

- [ ] **Step 3: Record findings in THIS plan file** under "Task 0 findings" below (amend the plan commit). Expected per spec: (a)/(b) leave the bridge process alive (if NOT — that's a worker crash bug: STOP, debug with superpowers:systematic-debugging, fix with a TDD test before proceeding; the known suspect class is unguarded `'error'` emitters on closed sockets in `metro/events-client.ts` and `cdp/recovery.ts`); (c) SIGKILLs the bridge (confirming the split is the only fix); (d) documents whether a surviving bridge reconnects.

#### Task 0 findings (fill in before Task 1)

- (a) graceful Metro stop: _pending_
- (b) Metro killed by PID: _pending_
- (c) kill-by-port: _pending_
- (d) reconnect after new Metro: _pending_

---

### Task 1: `LineSplitter` (stdio-frames.ts)

**Files:**
- Create: `scripts/cdp-bridge/src/lifecycle/stdio-frames.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-264-stdio-frames.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-264-stdio-frames.test.js`
Expected: FAIL — missing export `LineSplitter`

- [ ] **Step 3: Minimal implementation** — create `src/lifecycle/stdio-frames.ts`:

```typescript
// GH#264: newline-delimited JSON-RPC framing (what StdioServerTransport
// speaks). Callers must decode chunks to strings BEFORE push() — splitting
// Buffers byte-wise could cut a multi-byte UTF-8 codepoint in half.
export class LineSplitter {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts.filter((line) => line.length > 0);
  }

  flush(): string | null {
    const tail = this.buf;
    this.buf = '';
    return tail.length > 0 ? tail : null;
  }
}
```

- [ ] **Step 4: Run to verify pass** — same command, expect PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/lifecycle/stdio-frames.ts scripts/cdp-bridge/test/unit/gh-264-stdio-frames.test.js
git commit -m "feat(#264): LineSplitter — newline-delimited JSON-RPC framing"
```

---

### Task 2: `SupervisorCore` — handshake cache, pending tracking, death errors

**Files:**
- Create: `scripts/cdp-bridge/src/lifecycle/supervisor-core.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-264-supervisor-core.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SupervisorCore,
  workerDeathErrorLine,
  terminalErrorLine,
  workerExitDetail,
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
```

- [ ] **Step 2: Run to verify failure** — `npm run build && node --test test/unit/gh-264-supervisor-core.test.js` → FAIL (missing exports).

- [ ] **Step 3: Implement** — create `src/lifecycle/supervisor-core.ts`:

```typescript
export type JsonRpcId = string | number;

export type SupervisorAction =
  | { kind: 'toWorker'; line: string }
  | { kind: 'toClient'; line: string }
  | { kind: 'spawn' }
  | { kind: 'exit'; code: number };

export interface SupervisorCoreOpts {
  maxRespawns?: number;
  windowMs?: number;
  now?: () => number;
  /** Resolved bridge log path (logger.logFilePath) for the terminal error; null when the current LOG_LEVEL writes no file. */
  logPath?: string | null;
}

interface ParsedMsg {
  id?: JsonRpcId;
  method?: string;
  isResponse: boolean;
}

function parseLine(line: string): ParsedMsg | null {
  try {
    const m = JSON.parse(line) as { id?: JsonRpcId; method?: string; result?: unknown; error?: unknown };
    return { id: m.id, method: m.method, isResponse: m.method === undefined && (m.result !== undefined || m.error !== undefined) };
  } catch {
    return null;
  }
}

export function workerExitDetail(code: number | null, signal: string | null): string {
  return signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
}

export function workerDeathErrorLine(id: JsonRpcId, detail: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: `rn-dev-agent bridge worker restarted (${detail}) — retry the call` },
  });
}

export function terminalErrorLine(id: JsonRpcId, lastExit: string | null, logPath: string | null = null): string {
  const where = logPath
    ? `Check ${logPath}`
    : 'Set LOG_LEVEL=info and check the bridge log';
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: `rn-dev-agent bridge worker is crash-looping (last: ${lastExit ?? 'unknown'}); restart budget exhausted. ${where}, then restart the Claude Code session.`,
    },
  });
}

/** GH#264 Phase 5: `cdp_status.bridge` — the worker reads its supervision
 * facts from env vars the supervisor sets at each spawn. */
export function bridgeEnvState(env: NodeJS.ProcessEnv): {
  supervised: boolean;
  workerRestarts: number;
  lastWorkerExit: string | null;
} {
  return {
    supervised: env.RN_BRIDGE_SUPERVISED === '1',
    workerRestarts: Number(env.RN_BRIDGE_RESTARTS ?? '0') || 0,
    lastWorkerExit: env.RN_BRIDGE_LAST_EXIT ?? null,
  };
}

/**
 * GH#264 Phase 5: the supervisor's protocol brain, pure on purpose — every
 * I/O decision is returned as an action so process wiring stays in
 * supervisor.ts and the hard cases (death mid-request, replay, budget,
 * terminal mode) are unit-testable without spawning anything.
 *
 * Protocol facts this encodes:
 *  - MCP stdio is newline-delimited JSON-RPC; the client handshake is
 *    `initialize` (request) + `notifications/initialized` (notification).
 *    Both are cached verbatim and replayed to a fresh worker, which answers
 *    the replayed initialize — that duplicate response must be swallowed
 *    (Claude Code already got the original).
 *  - Requests in flight when the worker dies can never be answered; each
 *    gets a -32000 error so tool calls fail fast instead of hanging.
 *  - Client traffic that arrives mid-restart is queued (order-preserving)
 *    and flushed once the replayed handshake completes.
 */
export class SupervisorCore {
  private readonly maxRespawns: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  private mode: 'running' | 'restarting' | 'terminal' = 'running';
  private cachedInitialize: string | null = null;
  private cachedInitialized: string | null = null;
  private initializeId: JsonRpcId | null = null;
  private initializeAnswered = false;
  private replaySwallowId: JsonRpcId | null = null;
  private pending = new Set<JsonRpcId>();
  private queue: string[] = [];
  private respawnTimes: number[] = [];
  private totalRestarts = 0;
  private readonly logPath: string | null;
  lastExit: string | null = null;

  constructor(opts: SupervisorCoreOpts = {}) {
    this.maxRespawns = opts.maxRespawns ?? 3;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.logPath = opts.logPath ?? null;
  }

  /** Monotonic lifetime restart count (telemetry, RN_BRIDGE_RESTARTS) — the
   * windowed respawnTimes array is only the crash-loop BUDGET and shrinks as
   * the window slides; surfacing it would make cdp_status counts go down. */
  get restartCount(): number {
    return this.totalRestarts;
  }

  get state(): 'running' | 'restarting' | 'terminal' {
    return this.mode;
  }

  onClientLine(line: string): SupervisorAction[] {
    const msg = parseLine(line);
    if (msg?.method === 'initialize') {
      this.cachedInitialize = line;
      this.initializeId = msg.id ?? null;
    }
    if (msg?.method === 'notifications/initialized') this.cachedInitialized = line;
    if (this.mode === 'terminal') {
      if (msg?.id !== undefined && !msg.isResponse) {
        return [{ kind: 'toClient', line: terminalErrorLine(msg.id, this.lastExit, this.logPath) }];
      }
      return [];
    }
    // initialize stays OUT of the pending-set: on worker death it is replayed
    // to the fresh worker (and its answer forwarded if the client never got
    // one) — a -32000 "retry" for it would wedge the MCP handshake.
    if (msg?.id !== undefined && !msg.isResponse && msg.method !== 'initialize') this.pending.add(msg.id);
    if (this.mode === 'restarting') {
      this.queue.push(line);
      return [];
    }
    return [{ kind: 'toWorker', line }];
  }

  onWorkerLine(line: string): SupervisorAction[] {
    const msg = parseLine(line);
    if (msg?.isResponse && msg.id !== undefined && msg.id === this.replaySwallowId) {
      this.replaySwallowId = null;
      this.mode = 'running';
      const flushed = this.queue.map((queued): SupervisorAction => ({ kind: 'toWorker', line: queued }));
      this.queue = [];
      return flushed;
    }
    // Pending-set + swallow logic key on CLIENT request ids. This bridge
    // server sends zero server-initiated requests today (no sampling/roots/
    // ping) — if that ever changes, worker-originated ids could collide here.
    if (msg?.isResponse && msg.id !== undefined) {
      this.pending.delete(msg.id);
      if (msg.id === this.initializeId) this.initializeAnswered = true;
    }
    return [{ kind: 'toClient', line }];
  }

  onWorkerExit(code: number | null, signal: string | null, shutdownRequested: boolean): SupervisorAction[] {
    if (shutdownRequested) return [{ kind: 'exit', code: 0 }];
    this.lastExit = workerExitDetail(code, signal);
    const errors: SupervisorAction[] = [...this.pending].map((id) => ({
      kind: 'toClient',
      line: workerDeathErrorLine(id, this.lastExit as string),
    }));
    this.pending.clear();
    // Unexpected-but-clean end: mirror it. Something intentionally finished
    // the worker (not a crash); respawning would fight that intent.
    if (code === 0 && !signal) return [...errors, { kind: 'exit', code: 0 }];
    const t = this.now();
    this.respawnTimes = this.respawnTimes.filter((ts) => t - ts < this.windowMs);
    if (this.respawnTimes.length >= this.maxRespawns) {
      this.mode = 'terminal';
      return errors;
    }
    this.respawnTimes.push(t);
    this.totalRestarts += 1;
    this.mode = 'restarting';
    return [...errors, { kind: 'spawn' }];
  }

  onSpawned(): SupervisorAction[] {
    if (this.mode !== 'restarting') return [];
    if (this.cachedInitialize !== null && this.initializeId !== null) {
      const replay: SupervisorAction[] = [{ kind: 'toWorker', line: this.cachedInitialize }];
      if (this.cachedInitialized !== null) replay.push({ kind: 'toWorker', line: this.cachedInitialized });
      if (this.initializeAnswered) {
        // Claude Code already has its initialize response — the fresh
        // worker's duplicate must be swallowed; queue flushes on swallow.
        this.replaySwallowId = this.initializeId;
        return replay;
      }
      // Crash before the first initialize response: the fresh worker's
      // answer is the REAL one — forward it. Nothing can be queued yet
      // (the client is still waiting on initialize), so run immediately.
      this.mode = 'running';
      return [...replay, ...this.drainQueue()];
    }
    this.mode = 'running';
    return this.drainQueue();
  }

  private drainQueue(): SupervisorAction[] {
    const flushed = this.queue.map((queued): SupervisorAction => ({ kind: 'toWorker', line: queued }));
    this.queue = [];
    return flushed;
  }
}
```

- [ ] **Step 4: Run to verify pass** — same command, expect PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/lifecycle/supervisor-core.ts scripts/cdp-bridge/test/unit/gh-264-supervisor-core.test.js
git commit -m "feat(#264): SupervisorCore — handshake replay, death errors, bounded respawn budget"
```

---

### Task 3: `supervisor.ts` entry + integration tests with scripted workers

**Files:**
- Create: `scripts/cdp-bridge/src/supervisor.ts`
- Create: `scripts/cdp-bridge/test/fixtures/fake-worker.mjs`, `scripts/cdp-bridge/test/fixtures/crashing-worker.mjs`
- Test: `scripts/cdp-bridge/test/integration/gh-264-supervisor-respawn.test.js`

- [ ] **Step 1: Create the fixtures**

`test/fixtures/fake-worker.mjs`:

```javascript
#!/usr/bin/env node
// GH#264 integration fixture: a newline-JSON-RPC echo server. Every result
// carries this process's pid so tests can prove which incarnation answered.
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'hang') return;                    // never answers — stays in flight
  if (msg.id === undefined) return;                     // notifications: no response
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: msg.id,
    result: { echo: msg.method, pid: process.pid, supervised: process.env.RN_BRIDGE_SUPERVISED ?? null, restarts: process.env.RN_BRIDGE_RESTARTS ?? null },
  }) + '\n');
});
```

`test/fixtures/crashing-worker.mjs`:

```javascript
#!/usr/bin/env node
// GH#264 integration fixture: dies immediately with a non-zero code.
process.exit(1);
```

- [ ] **Step 2: Write the failing integration tests**

`test/integration/gh-264-supervisor-respawn.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = resolve(__dirname, '../../dist/supervisor.js');
const FAKE = resolve(__dirname, '../fixtures/fake-worker.mjs');
const CRASHER = resolve(__dirname, '../fixtures/crashing-worker.mjs');

function startSupervisor(workerPath, extraEnv = {}) {
  const child = spawn(process.execPath, [SUPERVISOR, '--no-lock'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, RN_BRIDGE_WORKER_PATH: workerPath, ...extraEnv },
  });
  let buf = '';
  const pendingLines = [];
  const waiters = [];
  child.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      if (!p.length) continue;
      const w = waiters.shift();
      if (w) w(p); else pendingLines.push(p);
    }
  });
  const nextLine = () => new Promise((resolveLine, reject) => {
    const queued = pendingLines.shift();
    if (queued !== undefined) return resolveLine(queued);
    const t = setTimeout(() => reject(new Error('timeout waiting for supervisor stdout line')), 15_000);
    waiters.push((line) => { clearTimeout(t); resolveLine(line); });
  });
  let id = 0;
  const send = (method, params = {}) => {
    id += 1;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return id;
  };
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { child, nextLine, send, notify };
}

test('GH#264 supervisor: kill -9 worker → in-flight error, respawn, handshake replayed once, new pid serves', async () => {
  const s = startSupervisor(FAKE);
  try {
    const initId = s.send('initialize');
    const initRes = JSON.parse(await s.nextLine());
    assert.equal(initRes.id, initId);
    const pid1 = initRes.result.pid;
    assert.equal(initRes.result.supervised, '1');
    s.notify('notifications/initialized');

    const hangId = s.send('hang');                       // stays in flight
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
  const s = startSupervisor(FAKE);
  const initId = s.send('initialize');
  await s.nextLine();
  const exited = new Promise((resolveExit) => s.child.on('exit', (code) => resolveExit(code)));
  s.child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.ok(initId >= 1);
});

test('GH#264 supervisor: crash-looping worker exhausts budget → terminal error names last exit', async () => {
  const s = startSupervisor(CRASHER, { RN_BRIDGE_MAX_RESPAWNS: '2' });
  try {
    // The crasher dies pre-handshake repeatedly; after the budget the
    // supervisor stays alive and answers requests with the terminal error.
    await new Promise((r) => setTimeout(r, 1500));      // let the crash loop burn its budget
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
  const s = startSupervisor('/nonexistent/worker.js', { RN_BRIDGE_MAX_RESPAWNS: '2' });
  try {
    await new Promise((r) => setTimeout(r, 1500));      // spawn errors burn the budget
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
  const s = startSupervisor(FAKE);
  try {
    s.send('initialize');
    await s.nextLine();
    // Hand-build a request with multi-byte UTF-8 in the method, then write
    // its bytes in two chunks split INSIDE the é codepoint. setEncoding's
    // StringDecoder must reassemble it; without it the JSON corrupts to �.
    const raw = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'écho→test', params: {} }) + '\n', 'utf8');
    const splitAt = raw.indexOf(0xc3) + 1;              // first byte of the 2-byte é sequence
    s.child.stdin.write(raw.subarray(0, splitAt));
    await new Promise((r) => setTimeout(r, 50));         // force two distinct 'data' events
    s.child.stdin.write(raw.subarray(splitAt));
    const reply = JSON.parse(await s.nextLine());
    assert.equal(reply.id, 99);
    assert.equal(reply.result.echo, 'écho→test');
  } finally {
    s.child.kill('SIGTERM');
  }
});
```

- [ ] **Step 3: Run to verify failure** — `cd scripts/cdp-bridge && npm run build && node --test test/integration/gh-264-supervisor-respawn.test.js` → FAIL (`dist/supervisor.js` does not exist).

- [ ] **Step 4: Implement** — create `src/supervisor.ts`:

```typescript
#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lockfile, formatLockConflictMessage } from './lifecycle/lockfile.js';
import { startParentDeathWatch } from './lifecycle/parent-watch.js';
import { LineSplitter } from './lifecycle/stdio-frames.js';
import { SupervisorCore, type SupervisorAction } from './lifecycle/supervisor-core.js';
import { logger } from './logger.js';

// GH#264 Phase 5: the component that owns stdio with Claude Code must hold
// ZERO network sockets — `lsof -ti tcp:8081 | xargs kill -9` (a documented
// Metro-recovery step) kills every pid on the port, which used to include
// the whole MCP server. All networked state lives in the spawned worker
// (./index.js); this process only pipes stdio, owns the single-instance
// lock, and respawns the worker when it dies.
const here = dirname(fileURLToPath(import.meta.url));

if (process.env.RN_BRIDGE_SUPERVISOR === '0') {
  // Escape hatch: legacy single-process bridge (debugging / bisecting).
  await import('./index.js');
} else {
  const workerPath = process.env.RN_BRIDGE_WORKER_PATH ?? join(here, 'index.js');
  const noLock = process.argv.includes('--no-lock');

  let lockfile: Lockfile | null = null;
  if (!noLock) {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string };
    lockfile = new Lockfile({ version: pkg.version });
    const lockResult = lockfile.acquire();
    if (lockResult.status === 'conflict') {
      process.stderr.write(formatLockConflictMessage(lockResult) + '\n');
      process.exit(11);
    }
    process.on('exit', () => lockfile?.release());
  }

  const core = new SupervisorCore({
    maxRespawns: Number(process.env.RN_BRIDGE_MAX_RESPAWNS ?? '3') || 3,
    logPath: logger.logFilePath,
  });
  const clientLines = new LineSplitter();
  const workerLines = new LineSplitter();
  let worker: ChildProcess | null = null;
  let shutdownRequested = false;

  function apply(actions: SupervisorAction[]): void {
    for (const action of actions) {
      if (action.kind === 'toWorker') worker?.stdin?.write(action.line + '\n');
      else if (action.kind === 'toClient') process.stdout.write(action.line + '\n');
      else if (action.kind === 'spawn') {
        spawnWorker();
        apply(core.onSpawned());
      } else process.exit(action.code);
    }
  }

  function spawnWorker(): void {
    const child = spawn(process.execPath, [workerPath, '--no-lock'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        RN_BRIDGE_SUPERVISED: '1',
        RN_BRIDGE_RESTARTS: String(core.restartCount),
        ...(core.lastExit ? { RN_BRIDGE_LAST_EXIT: core.lastExit } : {}),
      },
    });
    worker = child;
    process.stderr.write(`rn-bridge-supervisor: worker pid ${child.pid}\n`);
    // 'error' + 'exit' can both fire (or only 'error' for ENOENT) — funnel
    // both into ONE death-handling pass per child or the budget double-counts.
    let handled = false;
    const onDeath = (code: number | null, signal: NodeJS.Signals | null, cause: string): void => {
      if (handled) return;
      handled = true;
      if (cause) process.stderr.write(`rn-bridge-supervisor: worker ${cause}\n`);
      if (worker === child) worker = null;
      apply(core.onWorkerExit(code, signal, shutdownRequested));
    };
    child.stdin?.on('error', () => { /* EPIPE on a dying worker — exit handler covers it */ });
    child.on('error', (err) => onDeath(null, null, `spawn failed: ${err.message}`));
    if (child.stdout) {
      // setEncoding makes Node's StringDecoder hold partial UTF-8 sequences —
      // a multi-byte codepoint split across 'data' events must not corrupt
      // the JSON (plan-review BLOCKER; the SDK's own ReadBuffer does the same).
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const line of workerLines.push(chunk)) apply(core.onWorkerLine(line));
      });
    }
    child.on('exit', (code, signal) => onDeath(code, signal, ''));
  }

  function beginShutdown(why: string): void {
    if (shutdownRequested) return;
    shutdownRequested = true;
    process.stderr.write(`rn-bridge-supervisor: shutdown (${why})\n`);
    const child = worker;
    if (!child || child.exitCode !== null) process.exit(0);
    child.kill('SIGTERM');
    const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 3000);
    force.unref();
    child.on('exit', () => process.exit(0));
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const line of clientLines.push(chunk)) apply(core.onClientLine(line));
  });
  process.stdin.on('end', () => beginShutdown('stdin closed — host disconnected'));
  process.on('SIGTERM', () => beginShutdown('SIGTERM'));
  process.on('SIGINT', () => beginShutdown('SIGINT'));
  process.on('SIGHUP', () => beginShutdown('SIGHUP'));
  // Hot reload, now real: forward to the worker, whose documented SIGUSR2
  // path exits 1 — the supervisor respawns it with the handshake replayed.
  process.on('SIGUSR2', () => worker?.kill('SIGUSR2'));

  startParentDeathWatch({
    onOrphaned: () => beginShutdown('parent host gone (PPID changed)'),
    onHeartbeat: () => {
      try {
        if (lockfile && !lockfile.touch()) beginShutdown('single-instance lock reclaimed by another bridge');
      } catch { /* best-effort heartbeat */ }
    },
  });

  spawnWorker();
}
```

- [ ] **Step 5: Run to verify pass** — `npm run build && node --test test/integration/gh-264-supervisor-respawn.test.js` → PASS (5 tests). Then the full unit suite: `npm test` → all green (~1927).

- [ ] **Step 6: Commit**

```bash
git add scripts/cdp-bridge/src/supervisor.ts scripts/cdp-bridge/test/fixtures/fake-worker.mjs scripts/cdp-bridge/test/fixtures/crashing-worker.mjs scripts/cdp-bridge/test/integration/gh-264-supervisor-respawn.test.js
git commit -m "feat(#264): supervisor entry — spawn/pipe/respawn worker, lock + parent-watch ownership"
```

---

### Task 4: `cdp_status.bridge` visibility

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/status.ts` (~line 110, inside `buildStatusResult`'s returned object)
- Test: `scripts/cdp-bridge/test/unit/gh-264-supervisor-core.test.js` (append — `bridgeEnvState` is already exported)

- [ ] **Step 1: Write the failing test** — append to `gh-264-supervisor-core.test.js`:

```javascript
import { bridgeEnvState } from '../../dist/lifecycle/supervisor-core.js';

test('GH#264 bridgeEnvState: unsupervised by default, parses supervisor-set env', () => {
  assert.deepEqual(bridgeEnvState({}), { supervised: false, workerRestarts: 0, lastWorkerExit: null });
  assert.deepEqual(
    bridgeEnvState({ RN_BRIDGE_SUPERVISED: '1', RN_BRIDGE_RESTARTS: '2', RN_BRIDGE_LAST_EXIT: 'signal SIGKILL' }),
    { supervised: true, workerRestarts: 2, lastWorkerExit: 'signal SIGKILL' },
  );
  assert.equal(bridgeEnvState({ RN_BRIDGE_RESTARTS: 'garbage' }).workerRestarts, 0);
});
```

(If `bridgeEnvState` was already exported in Task 2 this passes immediately — that's fine; the REAL red/green of this task is the `status.ts` wiring assertion below.)

- [ ] **Step 2: Wire into `buildStatusResult`** — in `src/tools/status.ts`, add to the imports:

```typescript
import { bridgeEnvState } from '../lifecycle/supervisor-core.js';
```

and add to the returned status object (next to `reconnect` / `autoConnect`, ~line 110):

```typescript
    bridge: bridgeEnvState(process.env),
```

- [ ] **Step 3: Wiring assertion** (same repo pattern as `gh-202-kill-legacy-wiring.test.js` — source-text test). Append to `gh-264-supervisor-core.test.js`:

```javascript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const statusSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../src/tools/status.ts'), 'utf8');

test('GH#264 cdp_status wires bridgeEnvState into the status result', () => {
  assert.match(statusSrc, /bridge:\s*bridgeEnvState\(process\.env\)/);
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
```

- [ ] **Step 4: Run** — `npm test` → all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/status.ts scripts/cdp-bridge/test/unit/gh-264-supervisor-core.test.js
git commit -m "feat(#264): cdp_status.bridge — supervised / workerRestarts / lastWorkerExit"
```

---

### Task 5: Flip the MCP entry point

**Files:**
- Modify: `.claude-plugin/plugin.json` (~line 58)

- [ ] **Step 1: Edit** — in `.claude-plugin/plugin.json`, `mcpServers.cdp.args`, change:

```json
        "${CLAUDE_PLUGIN_ROOT}/scripts/cdp-bridge/dist/index.js"
```

to:

```json
        "${CLAUDE_PLUGIN_ROOT}/scripts/cdp-bridge/dist/supervisor.js"
```

- [ ] **Step 2: Sanity-run the shipped shape** — `cd scripts/cdp-bridge && npm run build`, then verify the supervisor boots the REAL worker and answers a real handshake end-to-end:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | timeout 20 node dist/supervisor.js --no-lock | head -1
```

Expected: one JSON line containing `"serverInfo"` (the worker's initialize response, piped through). The process exits when stdin closes (stdin-EOF shutdown path).

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/plugin.json
git commit -m "feat(#264): MCP entry point → dist/supervisor.js (RN_BRIDGE_SUPERVISOR=0 escape hatch)"
```

---

### Task 6: Worker hardening — graceful Metro loss must degrade, not crash (from Task 0 findings)

**Files:** depends on Task 0 findings — expected: none (findings (a)/(b) green) or targeted fixes in `scripts/cdp-bridge/src/metro/events-client.ts` / `src/cdp/recovery.ts`

- [ ] **Step 1: Decide from Task 0 findings.**
  - If (a) graceful stop and (b) kill-by-PID both left the bridge alive: record "no hardening needed" in the commit message of Task 7 and skip to Task 7 — the supervisor covers (c) by design and there is nothing to fix in-process.
  - If either crashed the bridge: that crash is a worker bug the supervisor would mask (a respawn per Metro restart = lost ring buffers for no reason). Reproduce it under `node --test` by driving the failing module directly (the Task 0 console output names the throwing module/stack), write the failing test in `test/unit/gh-264-metro-loss-hardening.test.js`, fix the unguarded path (the known class: an `'error'` event on an already-stopped WS in `metro/events-client.ts`, or a rejected promise escaping `cdp/recovery.ts` — both have prior art for the guard pattern in those same files), and commit:

```bash
git add scripts/cdp-bridge/src/metro/events-client.ts scripts/cdp-bridge/test/unit/gh-264-metro-loss-hardening.test.js
git commit -m "fix(#264): <named crash path> survives Metro loss (Task 0 finding)"
```

This task intentionally cannot pre-write its code — it exists because spec §2 Task 0 gates it. If Task 0 found nothing, it is a no-op.

---

### Task 7: Docs + changeset

**Files:**
- Modify: `CLAUDE.md` (Architecture section + Troubleshooting list)
- Modify: `docs-site/src/content/docs/architecture.mdx`, `docs-site/src/content/docs/troubleshooting.mdx`
- Create: `.changeset/phase5-supervisor-split.md`

- [ ] **Step 1: CLAUDE.md** — in the Architecture section (after the "MCP Server (cdp-bridge)" heading intro), add:

```markdown
Since #202 Phase 5 (#264), the MCP entry point is a **supervisor split**: `dist/supervisor.js` owns stdio with Claude Code and holds ZERO network sockets, so `lsof -ti tcp:8081 | xargs kill -9` (a documented Metro-recovery step) can no longer kill the bridge. It spawns the real server (`dist/index.js --no-lock`) as a worker, caches the MCP `initialize` handshake, and on worker death errors out in-flight calls (`-32000`, "retry the call"), respawns (max 3 per rolling 60 s, then a terminal crash-loop error naming the worker's last exit), and replays the handshake. The single-instance `Lockfile` + parent-death watch live in the supervisor; the worker keeps the UDID device lock. In-memory state (arbiter lease, ring buffers, CDP connection) is rebuilt on respawn by design. `cdp_status` → `bridge: { supervised, workerRestarts, lastWorkerExit }`. Escape hatch: `RN_BRIDGE_SUPERVISOR=0` runs the legacy single process. `SIGUSR2` to the supervisor = real hot-reload (worker restart + handshake replay).
```

- [ ] **Step 2: CLAUDE.md Troubleshooting** — add a row:

```markdown
- **MCP server died when Metro was restarted (all tools gone until session restart)** → Fixed since #202 Phase 5 (#264): the stdio supervisor holds no network sockets, so port-based kills (`lsof -ti tcp:8081 | xargs kill -9`) only take the worker, which respawns automatically (`cdp_status` → `bridge.workerRestarts`). If tools error with "worker is crash-looping", check `$TMPDIR/rn-dev-agent-cdp-bridge.log` and restart the session. `RN_BRIDGE_SUPERVISOR=0` opts back into the legacy single-process bridge.
```

- [ ] **Step 3: docs-site** — `architecture.mdx`: add the same supervisor paragraph (condensed) to the bridge architecture section. `troubleshooting.mdx`: add the Metro-restart row (match the existing Aside/tip style of the page).

- [ ] **Step 4: Changeset** — create `.changeset/phase5-supervisor-split.md`:

```markdown
---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

#202 Phase 5 / #264 — the bridge now survives Metro restarts (supervisor split).

The MCP entry point is now `dist/supervisor.js`: a thin stdio shim holding zero network sockets (immune to `lsof -ti tcp:8081 | xargs kill -9`, which used to SIGKILL the whole server and cost the session all 77 tools). It spawns the real bridge as a worker, and on worker death: errors in-flight calls with `-32000` ("retry the call"), respawns it (max 3 per rolling 60 s, then a terminal crash-loop error), and replays the cached MCP `initialize` handshake so the session continues seamlessly. Visibility: `cdp_status` → `bridge: { supervised, workerRestarts, lastWorkerExit }`. Opt out with `RN_BRIDGE_SUPERVISOR=0` (legacy single process). `SIGUSR2` now performs a real hot-reload (worker restart + handshake replay).
```

- [ ] **Step 5: Build docs-site to validate MDX** — `cd docs-site && npm run build` → success.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs-site/src/content/docs/architecture.mdx docs-site/src/content/docs/troubleshooting.mdx .changeset/phase5-supervisor-split.md
git commit -m "docs(#264): supervisor split — architecture, troubleshooting, changeset"
```

---

### Task 8: Full verification + dist + live gates

**Files:**
- Create: `scripts/cdp-bridge/eval/gate-264-supervisor.mjs` (gitignored, local-only)

- [ ] **Step 1: Full suite + dist** — `cd scripts/cdp-bridge && npm run test:all` (unit + integration). Stage the rebuilt `dist/` (now includes `supervisor.js`, `lifecycle/stdio-frames.js`, `lifecycle/supervisor-core.js`, modified `tools/status.js`):

```bash
git add scripts/cdp-bridge/dist
git commit -m "chore(#264): rebuilt dist (supervisor entry)"
```

- [ ] **Step 2: Live gate 1 — REAL worker, kill -9, same-session recovery.** Create `eval/gate-264-supervisor.mjs`:

```javascript
#!/usr/bin/env node
// Live gate for #264: supervisor + REAL dist/index.js worker. Kill the worker
// with SIGKILL (same signal class as kill-by-port) and prove the SAME MCP
// session keeps working: next cdp_status succeeds and reports workerRestarts=1.
//
// --no-lock is INTENTIONAL (codex-pair MED): this gate runs alongside the
// developer's live Claude session whose bridge holds the project lock; the
// gate validates respawn/replay, NOT singleton behavior. Lock ownership in
// the supervisor is validated separately by the lock-conflict step below.
import { spawn } from 'node:child_process';
const sup = spawn(process.execPath, [new URL('../dist/supervisor.js', import.meta.url).pathname, '--no-lock'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let workerPid = null;
sup.stderr.on('data', (c) => {
  const m = /worker pid (\d+)/.exec(c.toString());
  if (m) workerPid = Number(m[1]);
  process.stderr.write(c);
});
let buf = '';
const waiters = [];
sup.stdout.on('data', (c) => {
  buf += c.toString();
  const parts = buf.split('\n');
  buf = parts.pop() ?? '';
  for (const p of parts) if (p.length) waiters.shift()?.(JSON.parse(p));
});
const nextMsg = () => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), 30_000);
  waiters.push((m) => { clearTimeout(t); resolve(m); });
});
let id = 0;
const send = (method, params = {}) => { sup.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n'); return id; };

send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gate', version: '0' } });
const init = await nextMsg();
if (!init.result?.serverInfo) { console.error('GATE FAIL: no serverInfo from real worker'); process.exit(1); }
sup.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

send('tools/call', { name: 'cdp_status', arguments: {} });
const before = await nextMsg();
const beforeText = before.result?.content?.[0]?.text ?? '';
if (!/"supervised"\s*:\s*true/.test(beforeText)) { console.error('GATE FAIL: bridge.supervised not true pre-kill'); process.exit(1); }

const pid1 = workerPid;
console.log(`killing worker pid ${pid1} with SIGKILL`);
process.kill(pid1, 'SIGKILL');
await new Promise((r) => setTimeout(r, 2500));          // respawn + replay

send('tools/call', { name: 'cdp_status', arguments: {} });
const after = await nextMsg();
const afterText = after.result?.content?.[0]?.text ?? '';
if (after.error) { console.error(`GATE FAIL: post-kill cdp_status errored: ${after.error.message}`); process.exit(1); }
if (!/"workerRestarts"\s*:\s*1/.test(afterText)) { console.error('GATE FAIL: workerRestarts != 1 after kill'); console.error(afterText.slice(0, 400)); process.exit(1); }
if (workerPid === pid1) { console.error('GATE FAIL: worker pid unchanged'); process.exit(1); }
console.log(`GATE PASS: worker ${pid1} → ${workerPid}, same MCP session, workerRestarts=1`);
sup.kill('SIGTERM');
```

Run: `node eval/gate-264-supervisor.mjs` → `GATE PASS`.

- [ ] **Step 2b: Lock-ownership check (the path gate 1 intentionally bypasses).** The supervisor now owns the single-instance project lock; prove the conflict path works end-to-end in an isolated project dir so the live session's bridge is not involved:

```bash
cd "$(mktemp -d)" && node /Users/anton_personal/GitHub/claude-react-native-dev-plugin/scripts/cdp-bridge/dist/supervisor.js & SUP1=$!
sleep 2
node /Users/anton_personal/GitHub/claude-react-native-dev-plugin/scripts/cdp-bridge/dist/supervisor.js; echo "second supervisor exit: $?"
kill $SUP1
```

Expected: the second supervisor prints the lock-conflict message and exits `11` (same contract as the pre-split bridge, `index.ts` lock path). Record the output in the PR body. If the Lockfile keys on project cwd, both must run from the SAME temp dir (adjust accordingly — check `lifecycle/lockfile.ts` key derivation when running this).

- [ ] **Step 3: Live gate 2 — the actual #264 repro (kill-by-port with Metro).** Manual, reusing the Task 0 setup (Metro running, app on simulator): run `node eval/diag-264-matrix.mjs` but pointed at the SUPERVISOR (`RN_BRIDGE_WORKER_PATH` unset, change the spawned path to `../dist/supervisor.js` or copy the file to `eval/diag-264-supervisor.mjs`), confirm `cdp_status` shows a connected state, then `lsof -ti tcp:8081 | xargs kill -9`. Expected: the worker dies (it held the :8081 sockets), the supervisor survives (it holds none), the next periodic `cdp_status` succeeds with `metro` down/disconnected, and after `npx expo start` the bridge reconnects — all WITHOUT the probe process (the "session") seeing a dead server. Record the console transcript for the PR body.

- [ ] **Step 4: Record both gate outputs in the PR body.** Nothing to commit (eval/ is gitignored).

---

### Task 9: Finish the branch

- [ ] **Step 1: Push + PR**

```bash
git push -u origin feat/202-phase5-supervisor
gh pr create --title "feat(#264): Phase 5 — bridge supervisor split (survive Metro restarts)" --body "<summary + spec §2 link + Task 0 findings + both gate outputs>"
```

PR body must reference spec §2, #264 (Closes #264), the Task 0 findings table, and both live-gate transcripts.

- [ ] **Step 2: Multi-review + CI + merge per repo workflow.** Run `/multi-review` (or Gemini + available second reviewer) on the diff; wait for all CI checks; read review comments + resolve threads; merge. Update #202 (Phase 5 done, Phase 6 remaining) and close #264 via the PR.

---

## Self-review notes (done at authoring time)

- **Spec §2 coverage:** Task 0 diagnosis matrix → Task 0 (with the gating rule + findings table); supervisor entry + byte forwarding + initialize cache/replay + duplicate-swallow + in-flight `-32000` → Tasks 2–3; bounded respawn (3/60 s rolling) + terminal error naming last exit + log path → Task 2 (`terminalErrorLine` names `$TMPDIR/rn-dev-agent-cdp-bridge.log`); lock ownership move (project Lockfile + parent watch → supervisor; worker `--no-lock`; UDID device lock stays in worker — no code change needed, it already lives in worker-side `device-lock.ts`) → Task 3; worker-side hardening from findings → Task 6; `cdp_status.bridge` → Task 4; entry-point flip + `RN_BRIDGE_SUPERVISOR=0` escape hatch → Tasks 3+5; accepted-loss documentation (arbiter lease, ring buffers rebuilt on respawn) → Task 7 docs; unit tests with scripted fake worker (death mid-request, double-init swallow, backoff cap) → Tasks 2–3; live gates (kill -9 same-session recovery; real kill-by-port against Metro) → Task 8. Non-goals (supervisor SIGKILL survival, state persistence, worker pooling) intentionally absent.
- **Type consistency:** `SupervisorAction`/`SupervisorCore`/`bridgeEnvState`/`workerDeathErrorLine`/`terminalErrorLine`/`workerExitDetail` defined once in Task 2, consumed by Tasks 3–4 with matching signatures; `LineSplitter.push(string): string[]` consistent between Tasks 1 and 3.
- **Known design points (reviewers: weigh in):** (1) line-based forwarding (not raw bytes) is required for the swallow/error logic and is safe because MCP stdio is newline-delimited JSON; partial tails are buffered. (2) Worker stderr is `inherit` — worker logs keep flowing to the host's stderr as today. (3) An unexpected-but-clean worker exit 0 exits the supervisor (mirrors intent) rather than respawning — verified safe: the worker only self-exits 0 via stdin-EOF or orphan-watch, both of which mean the supervisor is already going away. (4) `RN_BRIDGE_WORKER_PATH` env exists for test injection only; not documented for users. (5) The crash-loop budget test relies on a 1.5 s sleep — the crasher burns its budget in well under that on any machine; if flaky in CI, poll for the terminal reply instead.

## Amendments applied from the multi-LLM plan review (2026-06-11)

Reviewed by Gemini + the coordinator's independent Claude research, both source-verified against the plan code, `@modelcontextprotocol/sdk@1.29.0` internals, and `index.ts`/`logger.ts` (Codex was cut off mid-run — silent-detachment, not quota; its partial work corroborated the UTF-8 finding). Applied:

1. **BLOCKER — `child.on('error')` in `spawnWorker`**: an ENOENT/fd-exhaustion spawn error had no listener → uncaughtException → dead supervisor, bypassing the whole bounded-budget design exactly when Task 5 flips all users to the new entry. Now funneled (with the `exit` event) through one `onDeath` pass per child; new integration test with a nonexistent `RN_BRIDGE_WORKER_PATH`.
2. **BLOCKER — `setEncoding('utf8')`** on `process.stdin` + `worker.stdout` instead of per-chunk `Buffer.toString()`: a multi-byte codepoint split across `data` events corrupted to U+FFFD, breaking JSON for non-ASCII payloads (component trees, store state). The SDK's own `ReadBuffer` does the equivalent. Task 1's string-only "codepoint-safe" test claim demoted; new integration test splits a real Buffer inside an `é` sequence.
3. **SHOULD-FIX — `initialize` stays out of the pending-set** + `initializeAnswered` tracking: a crash before the first initialize response previously produced a `-32000` for the handshake AND swallowed the fresh worker's real answer — wedging the session at startup. Now: no death error for initialize; the replayed response is forwarded (not swallowed) when the client never got one. Two new unit tests.
4. **SHOULD-FIX — terminal error names the RESOLVED log path** (`logger.logFilePath` threaded via `SupervisorCoreOpts.logPath`), not a hard-coded `tmpdir()` file that usually doesn't exist (logger resolves `CLAUDE_PLUGIN_DATA`/`~/.claude/logs` first and writes nothing at the default `warn` level — message falls back to a `LOG_LEVEL=info` hint).
5. **SHOULD-FIX — SIGUSR2 = exit-1 pinned** by a source-text test: hot-reload depends on the worker's `shutdown(1)`; a future change to `shutdown(0)` would make SIGUSR2 hit the clean-exit-0 branch and silently kill the session.
6. **SHOULD-FIX — `workerRestarts` is now a monotonic `totalRestarts`** (lifetime telemetry), separate from the windowed `respawnTimes` budget which legitimately shrinks as the window slides. New unit test.
7. **NICE — `apply()`'s `spawn` branch now calls `onSpawned()`** (replay sequencing decoupled from the `exit` listener); **NICE — comment** at the pending-set noting it assumes no server-initiated requests (verified: this bridge sends none today — a future sampling/roots capability must revisit).

Verified non-issues (recorded so they aren't re-litigated): the SDK does NOT gate `tools/call` on `notifications/initialized` (replay order is belt-and-suspenders); client request ids are per-session monotonic (no reuse against the pending-set); the `RN_BRIDGE_SUPERVISOR=0` escape hatch composes with `index.ts`'s own lock acquisition; worker writes nothing to stdout before the handshake (logger → stderr/file only).

**Round 2 — codex-pair per-edit review (2026-06-11):** (8) Task 0 diagnosis probe now buffers partial stdout lines across data events (a split JSON-RPC response was dropped as parse garbage — unreliable Task 0 evidence). (9) Live gate 1's `--no-lock` labeled intentional (it runs beside the live session's locked bridge and validates respawn/replay only) + new Step 2b lock-conflict gate proving the supervisor's singleton path end-to-end (second instance → exit 11) in an isolated dir.
