import WebSocket from 'ws';
import { RingBuffer } from './ring-buffer.js';
import { detectBridge } from './bridge-detector.js';
import { logger } from './logger.js';
import { performSetup, reinjectHelpers as reinjectHelpersFn } from './cdp/setup.js';
import { resetState, setActiveFlag, clearActiveFlag, sleep } from './cdp/state.js';
import { defaultTimeout, timeoutForMethod } from './cdp/timeout-config.js';
import { sendWithTimeout as sendMsg, rejectAllPending as rejectPending, handleMessage as handleMsg } from './cdp/transport.js';
import { wireEventHandlers, parseNetworkHookMessage as parseNetHook } from './cdp/event-handlers.js';
import { discoverForList } from './cdp/discovery.js';
import { helperExpr as helperExprFn, bridgeWithFallback as bridgeWithFallbackFn } from './cdp/helper-expr.js';
import { autoConnect as autoConnectFn, discoverAndConnect as discoverAndConnectFn, } from './cdp/connect.js';
import { handleClose as handleCloseFn, reconnect as reconnectFn, softReconnect as softReconnectFn, startBackgroundPoll as startBgPoll, stopBackgroundPoll as stopBgPoll, } from './cdp/reconnection.js';
export class CDPClient {
    ws = null;
    msgId = 0;
    slotId = 0;
    pending = new Map();
    eventHandlers = new Map();
    _consoleBuffer;
    _networkBuffer;
    _port;
    reconnecting = false;
    disposed = false;
    _helpersInjected = false;
    _networkMode = 'none';
    _isPaused = false;
    _connectedTarget = null;
    _state = 'disconnected';
    _connectionGeneration = 0;
    _softReconnectRequested = false;
    _bgPollTimer = null;
    _bridgeDetected = false;
    _bridgeVersion = null;
    _logBuffer;
    _logDomainEnabled = false;
    _profilerAvailable = false;
    _heapProfilerAvailable = false;
    // Tier 3: scriptParsed cache (D592)
    _scripts = new Map();
    // Tier 3: reconnection state visibility (D596)
    _lastReconnectAttempt = null;
    _reconnectAttemptCount = 0;
    constructor(port) {
        this._port = port ?? 8081;
        this._consoleBuffer = new RingBuffer(200);
        this._networkBuffer = new RingBuffer(100, { indexKey: (e) => e.id });
        this._logBuffer = new RingBuffer(50);
    }
    get state() { return this._state; }
    get isConnected() { return !this.disposed && this._state === 'connected' && this.ws?.readyState === WebSocket.OPEN; }
    get isPaused() { return this._isPaused; }
    get helpersInjected() { return this._helpersInjected; }
    get metroPort() { return this._port; }
    get connectedTarget() { return this._connectedTarget; }
    get networkMode() { return this._networkMode; }
    get consoleBuffer() { return this._consoleBuffer; }
    get networkBuffer() { return this._networkBuffer; }
    get connectionGeneration() { return this._connectionGeneration; }
    get bridgeDetected() { return this._bridgeDetected; }
    get bridgeVersion() { return this._bridgeVersion; }
    get logBuffer() { return this._logBuffer; }
    get logDomainEnabled() { return this._logDomainEnabled; }
    get profilerAvailable() { return this._profilerAvailable; }
    get heapProfilerAvailable() { return this._heapProfilerAvailable; }
    get scripts() { return this._scripts; }
    get reconnectState() {
        return { active: this.reconnecting, lastAttempt: this._lastReconnectAttempt, attemptCount: this._reconnectAttemptCount };
    }
    helperExpr(call) {
        return helperExprFn(call, this._bridgeDetected);
    }
    bridgeWithFallback(call) {
        return bridgeWithFallbackFn(call, this._bridgeDetected);
    }
    async reinjectHelpers(waitTimeout) {
        if (!this.isConnected)
            return false;
        const ok = await reinjectHelpersFn((expr) => this.evaluate(expr), waitTimeout);
        this._helpersInjected = ok;
        if (ok) {
            setActiveFlag(this._port, this._connectedTarget);
            detectBridge(this).then((r) => { this._bridgeDetected = r.present; this._bridgeVersion = r.version; }).catch(() => { });
        }
        return ok;
    }
    async autoConnect(portHint, filtersOrPlatform) {
        const filters = typeof filtersOrPlatform === 'string'
            ? { platform: filtersOrPlatform }
            : (filtersOrPlatform ?? {});
        return autoConnectFn(this.buildConnectCtx(), portHint, filters);
    }
    async listTargets(portHint) {
        return discoverForList(this._port, portHint);
    }
    _connectFilters = {};
    async discoverAndConnect(portHint, filters) {
        return discoverAndConnectFn(this.buildConnectCtx(), portHint, filters);
    }
    async softReconnect() {
        return softReconnectFn(this.buildReconnectCtx());
    }
    async disconnect() {
        // B76/D644: idempotent guard — graceful-shutdown may race with a tool-triggered
        // disconnect (e.g. cdp_restart calling disconnect() while SIGTERM fires). Second
        // caller sees already-disposed and returns cleanly.
        if (this.disposed)
            return;
        this.disposed = true;
        resetState(this.buildResettableState());
        clearActiveFlag();
        this.stopBackgroundPoll();
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close();
            }
            this.ws = null;
        }
        this.rejectAllPending(new Error('Client disconnected'));
    }
    get effectivePlatform() {
        return this._connectedTarget?.platform ?? null;
    }
    async evaluate(expression, awaitPromise = false) {
        if (awaitPromise) {
            return this.evaluateAsync(expression);
        }
        const timeout = defaultTimeout(this.effectivePlatform);
        const result = await this.sendWithTimeout('Runtime.evaluate', {
            expression,
            returnByValue: true,
        }, timeout);
        if (result?.exceptionDetails) {
            return {
                error: result.exceptionDetails.text ??
                    result.exceptionDetails.exception?.description ??
                    'Unknown evaluation error',
            };
        }
        return { value: result?.result?.value };
    }
    async evaluateAsync(expression) {
        // Hermes CDP doesn't support awaitPromise — use global slot + polling
        // Values are JSON-serialized inside Hermes to handle non-serializable objects
        // A deferred cleanup timer ensures the slot is removed even if the caller times out
        const timeout = defaultTimeout(this.effectivePlatform);
        const slot = '__rn_agent_async_' + (++this.slotId) + '_' + Date.now();
        const ASYNC_CLEANUP_MS = timeout * 2;
        const wrapper = `(function() {
      function safeVal(v) {
        try { return JSON.stringify(v); } catch(e) { return JSON.stringify(String(v)); }
      }
      var p = ${expression};
      if (p && typeof p.then === 'function') {
        p.then(function(v) { globalThis['${slot}'] = { v: safeVal(v) }; })
         .catch(function(e) { globalThis['${slot}'] = { e: (e && e.message) || String(e) }; });
      } else {
        globalThis['${slot}'] = { v: safeVal(p) };
      }
      setTimeout(function() { delete globalThis['${slot}']; }, ${ASYNC_CLEANUP_MS});
    })()`;
        const initResult = await this.sendWithTimeout('Runtime.evaluate', {
            expression: wrapper,
            returnByValue: true,
        }, timeout);
        if (initResult?.exceptionDetails) {
            return {
                error: initResult.exceptionDetails.text ??
                    initResult.exceptionDetails.exception?.description ??
                    'Unknown evaluation error',
            };
        }
        // B45 fix: Use absolute deadline to guarantee total wall-clock stays within timeout.
        // Each poll gets only the remaining time (min 500ms) to avoid overshooting.
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const remaining = deadline - Date.now();
            if (remaining < 500)
                break;
            const pollTimeout = Math.min(remaining - 100, 1500);
            const check = await this.sendWithTimeout('Runtime.evaluate', {
                expression: `globalThis['${slot}']`,
                returnByValue: true,
            }, pollTimeout);
            const val = check?.result?.value;
            if (val && typeof val === 'object') {
                void this.sendWithTimeout('Runtime.evaluate', {
                    expression: `delete globalThis['${slot}']`,
                    returnByValue: true,
                }, 1000).catch(() => { });
                if ('e' in val)
                    return { error: String(val.e) };
                try {
                    return { value: JSON.parse(val.v) };
                }
                catch {
                    return { value: val.v };
                }
            }
            await sleep(100);
        }
        void this.sendWithTimeout('Runtime.evaluate', {
            expression: `delete globalThis['${slot}']`,
            returnByValue: true,
        }, 1000).catch(() => { });
        return { error: 'Promise did not resolve within ' + timeout + 'ms' };
    }
    async send(method, params) {
        return this.sendWithTimeout(method, params, timeoutForMethod(method, this.effectivePlatform));
    }
    handleMessage(data) {
        handleMsg(data, this.pending, this.eventHandlers, (params) => this.parseNetworkHookMessage(params));
    }
    parseNetworkHookMessage(params) {
        parseNetHook(params, this._networkMode, this._networkBuffer);
    }
    async setup() {
        const result = await performSetup({
            send: (method, params, ms) => this.sendWithTimeout(method, params, ms ?? timeoutForMethod(method, this.effectivePlatform)),
            evaluate: (expr) => this.evaluate(expr),
            port: this._port,
            connectedTarget: this._connectedTarget,
            networkBuffer: this._networkBuffer,
            setupEventHandlers: () => this.setupEventHandlers(),
            clearScripts: () => this._scripts.clear(),
            clearEventHandlers: () => this.eventHandlers.clear(),
        });
        this._networkMode = result.networkMode;
        this._helpersInjected = result.helpersInjected;
        this._logDomainEnabled = result.logDomainEnabled;
        this._profilerAvailable = result.profilerAvailable;
        this._heapProfilerAvailable = result.heapProfilerAvailable;
        if (result.helpersInjected) {
            detectBridge(this).then((r) => { this._bridgeDetected = r.present; this._bridgeVersion = r.version; logger.debug('CDP', `Bridge detection: present=${r.present}, version=${r.version}`); }).catch(() => { });
        }
    }
    setupEventHandlers() {
        wireEventHandlers(this.eventHandlers, { console: this._consoleBuffer, network: this._networkBuffer, log: this._logBuffer, scripts: this._scripts }, (method, params, ms) => this.sendWithTimeout(method, params, ms ?? timeoutForMethod(method, this.effectivePlatform)), () => this._isPaused, (v) => { this._isPaused = v; });
    }
    handleClose(code) {
        handleCloseFn(this.buildReconnectCtx(), code);
    }
    async reconnect() {
        return reconnectFn(this.buildReconnectCtx());
    }
    startBackgroundPoll() {
        startBgPoll(this.buildReconnectCtx());
    }
    stopBackgroundPoll() {
        stopBgPoll(this.buildReconnectCtx());
    }
    buildReconnectCtx() {
        return {
            isDisposed: () => this.disposed,
            isReconnecting: () => this.reconnecting,
            isConnected: () => this.isConnected,
            isSoftReconnectRequested: () => this._softReconnectRequested,
            setReconnecting: (v) => { this.reconnecting = v; },
            setSoftReconnectRequested: (v) => { this._softReconnectRequested = v; },
            setState: (s) => { this._state = s; },
            setReconnectAttempt: (count, timestamp) => {
                this._reconnectAttemptCount = count;
                this._lastReconnectAttempt = timestamp;
            },
            closeWs: () => {
                if (this.ws) {
                    this.ws.removeAllListeners();
                    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                        this.ws.close();
                    }
                    this.ws = null;
                }
            },
            rejectAllPending: (reason) => this.rejectAllPending(reason),
            discoverAndConnect: () => this.discoverAndConnect(),
            getResettableState: () => this.buildResettableState(),
            getPort: () => this._port,
            setBgPollTimer: (timer) => { this._bgPollTimer = timer; },
            getBgPollTimer: () => this._bgPollTimer,
        };
    }
    buildConnectCtx() {
        return {
            isDisposed: () => this.disposed,
            isReconnecting: () => this.reconnecting,
            isSoftReconnectRequested: () => this._softReconnectRequested,
            getState: () => this._state,
            setState: (s) => { this._state = s; },
            getPort: () => this._port,
            setPort: (v) => { this._port = v; },
            getConnectFilters: () => this._connectFilters,
            setConnectFilters: (v) => { this._connectFilters = v; },
            getWs: () => this.ws,
            setWs: (ws) => { this.ws = ws; },
            setHelpersInjected: (v) => { this._helpersInjected = v; },
            setConnectedTarget: (t) => { this._connectedTarget = t; },
            incrementConnectionGeneration: () => ++this._connectionGeneration,
            evaluate: (expr) => this.evaluate(expr),
            sendWithTimeout: (method, params, ms) => this.sendWithTimeout(method, params, ms),
            handleMessage: (data) => this.handleMessage(data),
            handleClose: (code) => this.handleClose(code),
            rejectAllPending: (reason) => this.rejectAllPending(reason),
            setup: () => this.setup(),
        };
    }
    buildResettableState() {
        return {
            setState: (v) => { this._state = v; },
            setHelpersInjected: (v) => { this._helpersInjected = v; },
            setBridgeDetected: (v) => { this._bridgeDetected = v; },
            setBridgeVersion: (v) => { this._bridgeVersion = v; },
            setConnectedTarget: (v) => { this._connectedTarget = v; },
            setLogDomainEnabled: (v) => { this._logDomainEnabled = v; },
            setProfilerAvailable: (v) => { this._profilerAvailable = v; },
            setHeapProfilerAvailable: (v) => { this._heapProfilerAvailable = v; },
            clearScripts: () => { this._scripts.clear(); },
        };
    }
    rejectAllPending(reason) {
        rejectPending(this.pending, reason);
    }
    sendWithTimeout(method, params, ms) {
        return sendMsg(this.ws, this.pending, () => ++this.msgId, method, params, ms);
    }
}
