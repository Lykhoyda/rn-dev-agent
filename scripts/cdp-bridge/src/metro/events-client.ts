import WebSocket from 'ws';

import { logger } from '../logger.js';
import { computeReconnectDelay } from '../cdp/reconnection.js';
import { RingBuffer } from '../ring-buffer.js';

/**
 * Metro `/events` WebSocket subscriber (M5 / Phase 90 Tier 2).
 *
 * Metro's Dev Server exposes a WebSocket at `ws://${host}:${port}/events` that
 * broadcasts all reporter events (bundle build_started / build_done / build_failed,
 * reload signals, and others). No registration required — every client sees
 * every event. This module connects once on CDP open and keeps the connection
 * alive across Metro restarts via the same exponential-backoff curve that
 * reconnection.ts uses for Hermes (M2 / D653).
 *
 * Concrete signals surfaced today:
 *   - `bundle_build_started` — a bundle is being compiled
 *   - `bundle_build_done` — bundle compiled successfully
 *   - `bundle_build_failed` — bundle had a build error (syntax, missing dep, etc)
 *
 * The client exposes:
 *   - `lastBuild`: the most recent build status ('started' | 'done' | 'failed' | null)
 *   - `buildErrors`: count of `bundle_build_failed` events observed since start
 *   - a `RingBuffer` of recent events queryable via `cdp_metro_events`
 */

export interface MetroEvent {
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface MetroEventsClientOptions {
  host?: string;
  port: number;
  /** Ring buffer capacity for captured events. Default: 100. */
  bufferCapacity?: number;
  /** Optional callback invoked for every event (useful for tests). */
  onEvent?: (event: MetroEvent) => void;
  logTag?: string;
  /** Max reconnect attempts per stop-start cycle. Default: unlimited (0 = off). */
  maxReconnectAttempts?: number;
}

export type BuildStatus = 'started' | 'done' | 'failed';

type State = 'stopped' | 'connecting' | 'open' | 'reconnecting';

export class MetroEventsClient {
  private readonly opts: Required<Omit<MetroEventsClientOptions, 'onEvent'>> & {
    onEvent?: (event: MetroEvent) => void;
  };
  private ws: WebSocket | null = null;
  private state: State = 'stopped';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private _lastBuild: { status: BuildStatus; timestamp: string } | null = null;
  private _buildErrors = 0;
  readonly events: RingBuffer<MetroEvent>;

  constructor(options: MetroEventsClientOptions) {
    this.opts = {
      host: options.host ?? '127.0.0.1',
      port: options.port,
      bufferCapacity: options.bufferCapacity ?? 100,
      logTag: options.logTag ?? 'Metro.events',
      maxReconnectAttempts: options.maxReconnectAttempts ?? 0,
      onEvent: options.onEvent,
    };
    this.events = new RingBuffer<MetroEvent>(this.opts.bufferCapacity);
  }

  get isConnected(): boolean {
    return this.state === 'open';
  }

  get lastBuild(): { status: BuildStatus; timestamp: string } | null {
    return this._lastBuild;
  }

  get buildErrors(): number {
    return this._buildErrors;
  }

  /** Port this client is attached to. Immutable after construction — if Metro hops ports, the caller must stop() and construct a fresh client. */
  get port(): number {
    return this.opts.port;
  }

  /**
   * Open the WS connection. Idempotent — calling while already open is a no-op.
   * Resolves when the connection is established OR when the initial attempt fails
   * (auto-reconnect continues in the background). Never throws — failures log and
   * schedule a retry.
   *
   * If a reconnect is already scheduled (state === 'reconnecting'), we pre-empt
   * the pending timer and attempt immediately. This prevents a parallel
   * `connectOnce()` race (multi-review catch: without the preempt, the scheduled
   * timer would fire after our successful open and create a second WebSocket).
   */
  async start(): Promise<void> {
    if (this.state === 'open' || this.state === 'connecting') return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.connectOnce();
  }

  /**
   * Stop the client and cancel any pending reconnect. Idempotent — safe to call
   * from shutdown hooks and on disconnect flows. Does not flush the events buffer.
   *
   * Edge case (multi-review pass 2 catch): when `ws` is in `CONNECTING` state,
   * calling `close()` triggers the ws library's `abortHandshake()` which
   * asynchronously emits an `'error'` event ("WebSocket was closed before the
   * connection was established"). Because we `removeAllListeners()` first to
   * prevent our handlers from running after stop, the emitted error has no
   * listener — Node's EventEmitter contract crashes the process via
   * `uncaughtException`. Workaround: re-attach a no-op error listener AFTER
   * removing all listeners, BEFORE calling close. Reachable in practice via
   * port-swap in `ensureMetroEventsClient`, SIGTERM during initial CDP setup,
   * or the fire-and-forget race in `CDPClient.setup()`.
   */
  stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.removeAllListeners(); } catch { /* ignore */ }
      // Swallow the handshake-abort error that fires on close() against a
      // CONNECTING socket. No-op on already-OPEN or already-CLOSED sockets.
      this.ws.on('error', () => { /* post-stop error: swallow */ });
      try { this.ws.close(1000, 'client stopping'); } catch { /* ignore */ }
      this.ws = null;
    }
    this.state = 'stopped';
    this.reconnectAttempt = 0;
  }

  /** Reset the build-error counter. Useful when the user acknowledges errors. */
  clearBuildErrors(): void {
    this._buildErrors = 0;
  }

  private async connectOnce(): Promise<void> {
    this.state = 'connecting';
    const url = `ws://${this.opts.host}:${this.opts.port}/events`;

    return new Promise<void>((resolve) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      // Multi-review catch: on ECONNREFUSED / handshake failures, the `ws` library
      // fires BOTH `error` and `close` for the same failure. Without this `outcome`
      // guard, each event scheduled a reconnect independently → 2 timers pending,
      // `reconnectAttempt` incrementing 2× per real cycle, the M2 backoff curve
      // effectively doubled.  The guard also covers the win-race between happy-path
      // open and a stray late `close` (which shouldn't happen in practice but
      // costs us nothing to defend against).
      let outcome: 'open' | 'failed' | null = null;

      const onOpen = (): void => {
        if (outcome !== null) return;
        outcome = 'open';
        this.state = 'open';
        this.reconnectAttempt = 0;
        logger.info(this.opts.logTag, `connected to ${url}`);
        resolve();
      };

      const onFail = (reason: string): void => {
        if (outcome !== null) return;
        outcome = 'failed';
        logger.debug(this.opts.logTag, `connect failed: ${reason}`);
        this.scheduleReconnect();
        resolve();
      };

      ws.once('open', onOpen);
      ws.once('error', (err) => onFail(err instanceof Error ? err.message : String(err)));
      ws.on('message', (data) => this.onMessage(data));
      ws.on('close', (code) => {
        // If the connection never opened, treat close as a connection failure.
        // Otherwise, route to the long-lived close handler (schedules reconnect
        // via its own path — which is also guarded by scheduleReconnect's
        // `reconnectTimer` no-double-schedule check below).
        if (outcome === null) {
          onFail(`close code ${code} before open`);
        } else {
          this.onClose(code);
        }
      });
    });
  }

  private onMessage(data: WebSocket.RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      logger.debug(this.opts.logTag, 'dropped non-JSON event message');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;

    const raw = parsed as Record<string, unknown>;
    const type = typeof raw.type === 'string' ? raw.type : 'unknown';

    const event: MetroEvent = {
      type,
      timestamp: new Date().toISOString(),
      payload: raw,
    };
    this.events.push(event);

    // Update convenience accessors for build state — these power cdp_status.metro
    if (type === 'bundle_build_started') {
      this._lastBuild = { status: 'started', timestamp: event.timestamp };
    } else if (type === 'bundle_build_done') {
      this._lastBuild = { status: 'done', timestamp: event.timestamp };
    } else if (type === 'bundle_build_failed') {
      this._lastBuild = { status: 'failed', timestamp: event.timestamp };
      this._buildErrors++;
    }

    this.opts.onEvent?.(event);
  }

  private onClose(code: number): void {
    if (this.state === 'stopped') return;
    this.ws = null;
    logger.debug(this.opts.logTag, `ws closed (code=${code})`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.state === 'stopped') return;
    // Defense-in-depth against duplicate schedules. The connectOnce `outcome` flag
    // handles the initial-connect error+close race; this handles any other duplicate
    // pathway (e.g. stop()+start() reusing the instance while a timer is mid-flight).
    if (this.reconnectTimer !== null) return;

    this.reconnectAttempt++;

    if (this.opts.maxReconnectAttempts > 0 && this.reconnectAttempt > this.opts.maxReconnectAttempts) {
      logger.warn(this.opts.logTag, `max reconnect attempts (${this.opts.maxReconnectAttempts}) exceeded, giving up`);
      this.state = 'stopped';
      return;
    }

    this.state = 'reconnecting';
    const delayMs = computeReconnectDelay(this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state === 'stopped') return;
      void this.connectOnce();
    }, delayMs);
  }
}
