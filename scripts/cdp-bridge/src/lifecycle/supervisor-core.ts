export type JsonRpcId = string | number;

export type SupervisorAction =
  | { kind: "toWorker"; line: string }
  | { kind: "toClient"; line: string }
  | { kind: "spawn" }
  | { kind: "exit"; code: number };

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
    const m = JSON.parse(line) as {
      id?: JsonRpcId;
      method?: string;
      result?: unknown;
      error?: unknown;
    };
    return {
      id: m.id,
      method: m.method,
      isResponse: m.method === undefined && (m.result !== undefined || m.error !== undefined),
    };
  } catch {
    return null;
  }
}

export function workerExitDetail(code: number | null, signal: string | null): string {
  return signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
}

export function workerDeathErrorLine(id: JsonRpcId, detail: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: `rn-dev-agent bridge worker restarted (${detail}) — retry the call`,
    },
  });
}

export function terminalErrorLine(
  id: JsonRpcId,
  lastExit: string | null,
  logPath: string | null = null,
): string {
  const where = logPath ? `Check ${logPath}` : "Set LOG_LEVEL=info and check the bridge log";
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: `rn-dev-agent bridge worker is crash-looping (last: ${lastExit ?? "unknown"}); restart budget exhausted. ${where}, then restart the Claude Code session.`,
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
    supervised: env.RN_BRIDGE_SUPERVISED === "1",
    workerRestarts: Number(env.RN_BRIDGE_RESTARTS ?? "0") || 0,
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
  private readonly maxRespawns: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  private mode: "running" | "restarting" | "terminal" = "running";
  private cachedInitialize: string | null = null;
  private cachedInitialized: string | null = null;
  private initializeId: JsonRpcId | null = null;
  private initializeAnswered = false;
  private replaySwallowId: JsonRpcId | null = null;
  private replayForwardId: JsonRpcId | null = null;
  private pending = new Set<JsonRpcId>();
  private queue: string[] = [];
  private respawnTimes: number[] = [];
  private totalRestarts = 0;
  private hotReloadPending = false;
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

  get state(): "running" | "restarting" | "terminal" {
    return this.mode;
  }

  onClientLine(line: string): SupervisorAction[] {
    const msg = parseLine(line);
    if (msg?.method === "initialize") {
      this.cachedInitialize = line;
      this.initializeId = msg.id ?? null;
    }
    if (msg?.method === "notifications/initialized") this.cachedInitialized = line;
    if (this.mode === "terminal") {
      if (msg?.id !== undefined && !msg.isResponse) {
        return [{ kind: "toClient", line: terminalErrorLine(msg.id, this.lastExit, this.logPath) }];
      }
      return [];
    }
    // Queued-while-restarting requests are NOT pending: they were never
    // delivered to a worker, so a worker death doesn't fail them — they
    // drain (once) to the next incarnation. Marking them pending would yield
    // a death error AND a queued replay: two responses for one JSON-RPC id.
    // `initialized` is cache-only here: the replay path delivers it after
    // the handshake response; queueing it too would send it twice.
    if (this.mode === "restarting") {
      if (msg?.method !== "notifications/initialized") this.queue.push(line);
      return [];
    }
    // initialize stays OUT of the pending-set: on worker death it is replayed
    // to the fresh worker (and its answer forwarded if the client never got
    // one) — a -32000 "retry" for it would wedge the MCP handshake.
    if (msg?.id !== undefined && !msg.isResponse && msg.method !== "initialize")
      this.pending.add(msg.id);
    return [{ kind: "toWorker", line }];
  }

  onWorkerLine(line: string): SupervisorAction[] {
    const msg = parseLine(line);
    if (msg?.isResponse && msg.id !== undefined && msg.id === this.replaySwallowId) {
      this.replaySwallowId = null;
      this.mode = "running";
      // Strict MCP ordering: the cached `initialized` notification follows
      // the fresh worker's initialize RESPONSE — never precedes it — then
      // the queued client traffic drains.
      const after: SupervisorAction[] = [];
      if (this.cachedInitialized !== null)
        after.push({ kind: "toWorker", line: this.cachedInitialized });
      return [...after, ...this.drainQueue()];
    }
    if (msg?.isResponse && msg.id !== undefined && msg.id === this.replayForwardId) {
      // The client never received an initialize answer — this one is the
      // real handshake response: forward it, then release queued traffic.
      this.replayForwardId = null;
      this.initializeAnswered = true;
      this.mode = "running";
      return [{ kind: "toClient", line }, ...this.drainQueue()];
    }
    // Pending-set + swallow logic key on CLIENT request ids. This bridge
    // server sends zero server-initiated requests today (no sampling/roots/
    // ping) — if that ever changes, worker-originated ids could collide here.
    if (msg?.isResponse && msg.id !== undefined) {
      this.pending.delete(msg.id);
      if (msg.id === this.initializeId) this.initializeAnswered = true;
    }
    return [{ kind: "toClient", line }];
  }

  /** SIGUSR2 hot-reload exits 1 — without this one-shot flag the requested
   * reload would charge the crash budget, so three reloads in 60s would wedge
   * the bridge into terminal mode. */
  onHotReloadRequested(): void {
    this.hotReloadPending = true;
  }

  onWorkerExit(
    code: number | null,
    signal: string | null,
    shutdownRequested: boolean,
  ): SupervisorAction[] {
    if (shutdownRequested) return [{ kind: "exit", code: 0 }];
    this.lastExit = workerExitDetail(code, signal);
    const errors: SupervisorAction[] = [...this.pending].map((id) => ({
      kind: "toClient",
      line: workerDeathErrorLine(id, this.lastExit as string),
    }));
    this.pending.clear();
    if (this.hotReloadPending) {
      // Requested reload: respawn + replay + count in telemetry, but never
      // burn the anti-crash-loop budget — the exit was intentional.
      this.hotReloadPending = false;
      this.totalRestarts += 1;
      this.mode = "restarting";
      return [...errors, { kind: "spawn" }];
    }
    // Unexpected-but-clean end: mirror it. Something intentionally finished
    // the worker (not a crash); respawning would fight that intent.
    if (code === 0 && !signal) return [...errors, { kind: "exit", code: 0 }];
    const t = this.now();
    this.respawnTimes = this.respawnTimes.filter((ts) => t - ts < this.windowMs);
    if (this.respawnTimes.length >= this.maxRespawns) {
      this.mode = "terminal";
      // initialize is exempt from pending (replayable), so a worker that
      // crash-loops to exhaustion before EVER answering it would otherwise go
      // terminal silently — the MCP host would hang on the handshake.
      if (this.initializeId !== null && !this.initializeAnswered) {
        errors.push({
          kind: "toClient",
          line: terminalErrorLine(this.initializeId, this.lastExit, this.logPath),
        });
      }
      // Queued never-delivered requests can no longer be served — error each
      // (they're not in pending, so the loop above missed them) and drop them.
      for (const queued of this.queue) {
        const msg = parseLine(queued);
        if (msg?.id !== undefined && !msg.isResponse && msg.method !== "initialize") {
          errors.push({
            kind: "toClient",
            line: terminalErrorLine(msg.id, this.lastExit, this.logPath),
          });
        }
      }
      this.queue = [];
      return errors;
    }
    this.respawnTimes.push(t);
    this.totalRestarts += 1;
    this.mode = "restarting";
    return [...errors, { kind: "spawn" }];
  }

  onSpawned(): SupervisorAction[] {
    if (this.mode !== "restarting") return [];
    if (this.cachedInitialize !== null && this.initializeId !== null) {
      // Only the `initialize` request replays here; the mode stays
      // `restarting` until the fresh worker answers it, so no client traffic
      // can reach a pre-handshake worker. The cached `initialized`
      // notification follows the response (strict MCP handshake ordering).
      const replay: SupervisorAction[] = [{ kind: "toWorker", line: this.cachedInitialize }];
      if (this.initializeAnswered) {
        // Claude Code already has its initialize response — the fresh
        // worker's duplicate must be swallowed; initialized + queue follow.
        this.replaySwallowId = this.initializeId;
      } else {
        // Crash before the first initialize response: the fresh worker's
        // answer is the REAL one — forwarded on arrival, then the queue.
        this.replayForwardId = this.initializeId;
      }
      return replay;
    }
    this.mode = "running";
    return this.drainQueue();
  }

  private drainQueue(): SupervisorAction[] {
    const flushed = this.queue.map((queued): SupervisorAction => {
      // Delivery is the moment a request becomes failable — pending from here.
      const msg = parseLine(queued);
      if (msg?.id !== undefined && !msg.isResponse && msg.method !== "initialize")
        this.pending.add(msg.id);
      return { kind: "toWorker", line: queued };
    });
    this.queue = [];
    return flushed;
  }
}
