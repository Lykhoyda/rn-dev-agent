import WebSocket from 'ws';
import { logger } from '../logger.js';
import { computeReconnectDelay } from '../cdp/reconnection.js';
import { RingBuffer } from '../ring-buffer.js';
export class MetroEventsClient {
    opts;
    ws = null;
    state = 'stopped';
    reconnectTimer = null;
    reconnectAttempt = 0;
    _lastBuild = null;
    _buildErrors = 0;
    events;
    constructor(options) {
        this.opts = {
            host: options.host ?? '127.0.0.1',
            port: options.port,
            bufferCapacity: options.bufferCapacity ?? 100,
            logTag: options.logTag ?? 'Metro.events',
            maxReconnectAttempts: options.maxReconnectAttempts ?? 0,
            onEvent: options.onEvent,
        };
        this.events = new RingBuffer(this.opts.bufferCapacity);
    }
    get isConnected() {
        return this.state === 'open';
    }
    get lastBuild() {
        return this._lastBuild;
    }
    get buildErrors() {
        return this._buildErrors;
    }
    /** Port this client is attached to. Immutable after construction — if Metro hops ports, the caller must stop() and construct a fresh client. */
    get port() {
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
    async start() {
        if (this.state === 'open' || this.state === 'connecting')
            return;
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
    stop() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
            }
            catch { /* ignore */ }
            // Swallow the handshake-abort error that fires on close() against a
            // CONNECTING socket. No-op on already-OPEN or already-CLOSED sockets.
            this.ws.on('error', () => { });
            try {
                this.ws.close(1000, 'client stopping');
            }
            catch { /* ignore */ }
            this.ws = null;
        }
        this.state = 'stopped';
        this.reconnectAttempt = 0;
    }
    /** Reset the build-error counter. Useful when the user acknowledges errors. */
    clearBuildErrors() {
        this._buildErrors = 0;
    }
    async connectOnce() {
        this.state = 'connecting';
        const url = `ws://${this.opts.host}:${this.opts.port}/events`;
        return new Promise((resolve) => {
            const ws = new WebSocket(url);
            this.ws = ws;
            // Multi-review catch: on ECONNREFUSED / handshake failures, the `ws` library
            // fires BOTH `error` and `close` for the same failure. Without this `outcome`
            // guard, each event scheduled a reconnect independently → 2 timers pending,
            // `reconnectAttempt` incrementing 2× per real cycle, the M2 backoff curve
            // effectively doubled.  The guard also covers the win-race between happy-path
            // open and a stray late `close` (which shouldn't happen in practice but
            // costs us nothing to defend against).
            let outcome = null;
            const onOpen = () => {
                if (outcome !== null)
                    return;
                outcome = 'open';
                this.state = 'open';
                this.reconnectAttempt = 0;
                logger.info(this.opts.logTag, `connected to ${url}`);
                resolve();
            };
            const onFail = (reason) => {
                if (outcome !== null)
                    return;
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
                }
                else {
                    this.onClose(code);
                }
            });
        });
    }
    onMessage(data) {
        let parsed;
        try {
            parsed = JSON.parse(data.toString());
        }
        catch {
            logger.debug(this.opts.logTag, 'dropped non-JSON event message');
            return;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            return;
        const raw = parsed;
        const type = typeof raw.type === 'string' ? raw.type : 'unknown';
        const event = {
            type,
            timestamp: new Date().toISOString(),
            payload: raw,
        };
        this.events.push(event);
        // Update convenience accessors for build state — these power cdp_status.metro
        if (type === 'bundle_build_started') {
            this._lastBuild = { status: 'started', timestamp: event.timestamp };
        }
        else if (type === 'bundle_build_done') {
            this._lastBuild = { status: 'done', timestamp: event.timestamp };
        }
        else if (type === 'bundle_build_failed') {
            this._lastBuild = { status: 'failed', timestamp: event.timestamp };
            this._buildErrors++;
        }
        this.opts.onEvent?.(event);
    }
    onClose(code) {
        if (this.state === 'stopped')
            return;
        this.ws = null;
        logger.debug(this.opts.logTag, `ws closed (code=${code})`);
        this.scheduleReconnect();
    }
    scheduleReconnect() {
        if (this.state === 'stopped')
            return;
        // Defense-in-depth against duplicate schedules. The connectOnce `outcome` flag
        // handles the initial-connect error+close race; this handles any other duplicate
        // pathway (e.g. stop()+start() reusing the instance while a timer is mid-flight).
        if (this.reconnectTimer !== null)
            return;
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
            if (this.state === 'stopped')
                return;
            void this.connectOnce();
        }, delayMs);
    }
}
