import WebSocket from 'ws';
import { logger } from '../logger.js';
import { computeReconnectDelay } from '../cdp/reconnection.js';
import { RingBuffer } from '../ring-buffer.js';
/**
 * B129 (D658): detect whether an HTTP GET /events response body is an Expo
 * manifest rather than a bare-Metro reporter stream upgrade response.
 *
 * Expo CLI's /events endpoint returns a JSON body with the shape:
 *   {
 *     id: "<uuid>",
 *     createdAt: "...",
 *     runtimeVersion: "exposdk:52.0.0",
 *     launchAsset: { key, contentType, url },
 *     extra: { expoClient: { name, ... }, eas: { ... } }
 *   }
 *
 * Bare Metro returns either a WebSocket upgrade error (400/426) or, for
 * newer Metro versions, a short ReporterEvent stream on HTTP (same shape
 * as metro-mcp's reference impl). Neither contains `runtimeVersion` or
 * `launchAsset` keys.
 *
 * Exported for unit testing without a live HTTP server.
 */
export function detectExpoManifestResponse(body) {
    // Short-circuit on non-JSON — bare Metro may return an empty body or
    // an upgrade-required message, neither of which should trip this.
    const trimmed = body.trim();
    if (!trimmed || trimmed[0] !== '{')
        return false;
    try {
        const parsed = JSON.parse(trimmed);
        // The two most distinctive Expo-manifest keys. `runtimeVersion` is
        // specific to Expo (bare RN doesn't have it); `launchAsset` with a
        // `url` field is the Expo bundle-serving protocol.
        const hasRuntimeVersion = typeof parsed.runtimeVersion === 'string';
        const hasLaunchAsset = typeof parsed.launchAsset === 'object' &&
            parsed.launchAsset !== null &&
            typeof parsed.launchAsset.url === 'string';
        return hasRuntimeVersion || hasLaunchAsset;
    }
    catch {
        return false; // not JSON — probably a bare-Metro response, let WS try
    }
}
export class MetroEventsClient {
    opts;
    ws = null;
    state = 'stopped';
    reconnectTimer = null;
    reconnectAttempt = 0;
    _lastBuild = null;
    _buildErrors = 0;
    // B129 (D658): set when the /events endpoint is detected as incompatible
    // (e.g. Expo CLI serving the manifest protocol on this path). Once set,
    // start() is a no-op — no point opening a WS that will deliver no events.
    _incompatibleReason = null;
    events;
    constructor(options) {
        this.opts = {
            host: options.host ?? '127.0.0.1',
            port: options.port,
            bufferCapacity: options.bufferCapacity ?? 100,
            logTag: options.logTag ?? 'Metro.events',
            maxReconnectAttempts: options.maxReconnectAttempts ?? 0,
            skipIncompatibilityProbe: options.skipIncompatibilityProbe ?? false,
            onEvent: options.onEvent,
            fetchFn: options.fetchFn,
        };
        this.events = new RingBuffer(this.opts.bufferCapacity);
    }
    get isConnected() {
        return this.state === 'open';
    }
    /**
     * B129 (D658): reason the /events stream is unusable, if any. When set,
     * `isConnected` is false and no events will ever flow. Surface this to
     * the user via cdp_status.metro so they know why lastBuild stays null.
     */
    get incompatibleReason() {
        return this._incompatibleReason;
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
        if (this.state === 'incompatible')
            return; // B129: don't retry incompatible endpoints
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        // B129 (D658): probe /events via HTTP GET BEFORE opening the WS. On Expo
        // CLI projects, /events serves the Expo manifest protocol instead of
        // Metro's ReporterEvent stream — the WS handshake succeeds but no
        // reporter events ever arrive. Detect this shape up front and short-
        // circuit with an actionable state.
        if (!this.opts.skipIncompatibilityProbe) {
            const reason = await this.probeIncompatibility();
            if (reason) {
                this._incompatibleReason = reason;
                this.state = 'incompatible';
                logger.info(this.opts.logTag, `events endpoint incompatible (${reason}) — not opening WS`);
                return;
            }
        }
        await this.connectOnce();
    }
    /**
     * B129 (D658): HTTP GET probe to detect non-Metro /events responses.
     * Returns the incompatibility reason if detected, null if the endpoint
     * appears compatible or the probe itself failed (fall through to WS —
     * connection failures will retry via existing reconnect logic).
     */
    async probeIncompatibility() {
        const fetchFn = this.opts.fetchFn ?? (typeof fetch === 'function' ? fetch : null);
        if (!fetchFn)
            return null; // no fetch in runtime; skip probe rather than fail
        try {
            const url = `http://${this.opts.host}:${this.opts.port}/events`;
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 1500);
            try {
                const resp = await fetchFn(url, { signal: ctrl.signal });
                if (!resp.ok)
                    return null; // non-200 — probably bare Metro or unreachable; let WS attempt
                const text = await resp.text();
                return detectExpoManifestResponse(text) ? 'expo-cli-incompatible' : null;
            }
            finally {
                clearTimeout(timer);
            }
        }
        catch {
            // Probe failed (timeout, network error, CORS). Don't mark incompatible —
            // a bare-Metro /events HTTP GET may also error out (WS-only upgrade);
            // falling through to WS handshake is the safe default.
            return null;
        }
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
        // B129/D658 multi-review follow-up (L1): also clear the incompatibility
        // flag so `stop()` + `start()` on the same instance re-probes. The
        // incompatibility is a property of the endpoint at probe time; if the
        // caller stops and restarts us (e.g. after switching Metro from Expo to
        // bare), they should get a fresh probe, not a stale result.
        this._incompatibleReason = null;
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
