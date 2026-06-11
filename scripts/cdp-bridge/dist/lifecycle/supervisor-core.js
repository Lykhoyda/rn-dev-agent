function parseLine(line) {
    try {
        const m = JSON.parse(line);
        return { id: m.id, method: m.method, isResponse: m.method === undefined && (m.result !== undefined || m.error !== undefined) };
    }
    catch {
        return null;
    }
}
export function workerExitDetail(code, signal) {
    return signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
}
export function workerDeathErrorLine(id, detail) {
    return JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: `rn-dev-agent bridge worker restarted (${detail}) — retry the call` },
    });
}
export function terminalErrorLine(id, lastExit, logPath = null) {
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
export function bridgeEnvState(env) {
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
 *    (Claude Code already got the original) UNLESS the client never received
 *    one (crash before the first response), in which case it forwards.
 *  - Requests in flight when the worker dies can never be answered; each
 *    gets a -32000 error so tool calls fail fast instead of hanging. The
 *    initialize request itself is exempt: it is replayed, not retried.
 *  - Client traffic that arrives mid-restart is queued (order-preserving)
 *    and flushed once the replayed handshake completes.
 */
export class SupervisorCore {
    maxRespawns;
    windowMs;
    now;
    mode = 'running';
    cachedInitialize = null;
    cachedInitialized = null;
    initializeId = null;
    initializeAnswered = false;
    replaySwallowId = null;
    pending = new Set();
    queue = [];
    respawnTimes = [];
    totalRestarts = 0;
    hotReloadPending = false;
    logPath;
    lastExit = null;
    constructor(opts = {}) {
        this.maxRespawns = opts.maxRespawns ?? 3;
        this.windowMs = opts.windowMs ?? 60_000;
        this.now = opts.now ?? Date.now;
        this.logPath = opts.logPath ?? null;
    }
    /** Monotonic lifetime restart count (telemetry, RN_BRIDGE_RESTARTS) — the
     * windowed respawnTimes array is only the crash-loop BUDGET and shrinks as
     * the window slides; surfacing it would make cdp_status counts go down. */
    get restartCount() {
        return this.totalRestarts;
    }
    get state() {
        return this.mode;
    }
    onClientLine(line) {
        const msg = parseLine(line);
        if (msg?.method === 'initialize') {
            this.cachedInitialize = line;
            this.initializeId = msg.id ?? null;
        }
        if (msg?.method === 'notifications/initialized')
            this.cachedInitialized = line;
        if (this.mode === 'terminal') {
            if (msg?.id !== undefined && !msg.isResponse) {
                return [{ kind: 'toClient', line: terminalErrorLine(msg.id, this.lastExit, this.logPath) }];
            }
            return [];
        }
        // initialize stays OUT of the pending-set: on worker death it is replayed
        // to the fresh worker (and its answer forwarded if the client never got
        // one) — a -32000 "retry" for it would wedge the MCP handshake.
        if (msg?.id !== undefined && !msg.isResponse && msg.method !== 'initialize')
            this.pending.add(msg.id);
        if (this.mode === 'restarting') {
            this.queue.push(line);
            return [];
        }
        return [{ kind: 'toWorker', line }];
    }
    onWorkerLine(line) {
        const msg = parseLine(line);
        if (msg?.isResponse && msg.id !== undefined && msg.id === this.replaySwallowId) {
            this.replaySwallowId = null;
            this.mode = 'running';
            return this.drainQueue();
        }
        // Pending-set + swallow logic key on CLIENT request ids. This bridge
        // server sends zero server-initiated requests today (no sampling/roots/
        // ping) — if that ever changes, worker-originated ids could collide here.
        if (msg?.isResponse && msg.id !== undefined) {
            this.pending.delete(msg.id);
            if (msg.id === this.initializeId)
                this.initializeAnswered = true;
        }
        return [{ kind: 'toClient', line }];
    }
    /** PR #273 review (Gemini): SIGUSR2 hot-reload exits 1 — without this
     * one-shot flag the requested reload charged the crash budget, so three
     * reloads in 60s wedged the bridge into terminal mode. */
    onHotReloadRequested() {
        this.hotReloadPending = true;
    }
    onWorkerExit(code, signal, shutdownRequested) {
        if (shutdownRequested)
            return [{ kind: 'exit', code: 0 }];
        this.lastExit = workerExitDetail(code, signal);
        const errors = [...this.pending].map((id) => ({
            kind: 'toClient',
            line: workerDeathErrorLine(id, this.lastExit),
        }));
        this.pending.clear();
        if (this.hotReloadPending) {
            // Requested reload: respawn + replay + count in telemetry, but never
            // burn the anti-crash-loop budget — the exit was intentional.
            this.hotReloadPending = false;
            this.totalRestarts += 1;
            this.mode = 'restarting';
            return [...errors, { kind: 'spawn' }];
        }
        // Unexpected-but-clean end: mirror it. Something intentionally finished
        // the worker (not a crash); respawning would fight that intent.
        if (code === 0 && !signal)
            return [...errors, { kind: 'exit', code: 0 }];
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
    onSpawned() {
        if (this.mode !== 'restarting')
            return [];
        if (this.cachedInitialize !== null && this.initializeId !== null) {
            // The replayed `initialized` notification is written immediately after
            // the `initialize` request, BEFORE the fresh worker has answered it.
            // Safe because both drain in order off one stdin pipe and the SDK
            // server doesn't gate tool calls on `initialized` (verified v1.29.0) —
            // but it does rely on that in-order draining (PR #273 review note).
            const replay = [{ kind: 'toWorker', line: this.cachedInitialize }];
            if (this.cachedInitialized !== null)
                replay.push({ kind: 'toWorker', line: this.cachedInitialized });
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
    drainQueue() {
        const flushed = this.queue.map((queued) => ({ kind: 'toWorker', line: queued }));
        this.queue = [];
        return flushed;
    }
}
