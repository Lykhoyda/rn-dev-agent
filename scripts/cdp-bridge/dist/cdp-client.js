import WebSocket from 'ws';
import { RingBuffer } from './ring-buffer.js';
import { detectBridge } from './bridge-detector.js';
import { logger } from './logger.js';
import { performSetup, reinjectHelpers as reinjectHelpersFn } from './cdp/setup.js';
import { resetState, setActiveFlag, clearActiveFlag, sleep } from './cdp/state.js';
import { CDP_TIMEOUT_FAST, CDP_TIMEOUT_MS, timeoutForMethod } from './cdp/timeout-config.js';
import { sendWithTimeout as sendMsg, rejectAllPending as rejectPending, handleMessage as handleMsg } from './cdp/transport.js';
import { wireEventHandlers, parseNetworkHookMessage as parseNetHook } from './cdp/event-handlers.js';
import { discover, discoverForList } from './cdp/discovery.js';
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
        this._networkBuffer = new RingBuffer(100);
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
        return this._bridgeDetected ? `__RN_DEV_BRIDGE__.${call}` : `__RN_AGENT.${call}`;
    }
    bridgeWithFallback(call) {
        return this._bridgeDetected
            ? `(function() { var fb = false; try { var r = __RN_DEV_BRIDGE__.${call}; var p = JSON.parse(r); if (p && (p.__agent_error || p.error)) fb = true; else return r; } catch(e) { fb = true; } if (fb) return __RN_AGENT.${call}; })()`
            : `__RN_AGENT.${call}`;
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
    async autoConnect(portHint, platformFilter) {
        if (this._state === 'connecting' || this.reconnecting) {
            throw new Error('Already connecting to Metro...');
        }
        if (this.disposed) {
            throw new Error('Client is disposed. Create a new CDPClient instance.');
        }
        const effectivePlatform = platformFilter
            ?? (process.env.RN_PREFERRED_PLATFORM && process.env.RN_PREFERRED_PLATFORM !== 'auto'
                ? process.env.RN_PREFERRED_PLATFORM
                : undefined);
        return this.discoverAndConnect(portHint, effectivePlatform);
    }
    async listTargets(portHint) {
        return discoverForList(this._port, portHint);
    }
    _platformFilter;
    async discoverAndConnect(portHint, platformFilter) {
        if (this.disposed) {
            throw new Error('Client is disposed. Create a new CDPClient instance.');
        }
        if (portHint)
            this._port = portHint;
        if (platformFilter !== undefined)
            this._platformFilter = platformFilter || undefined;
        this._state = 'connecting';
        let result;
        try {
            result = await discover(this._port, this._platformFilter);
        }
        catch (err) {
            this._state = 'disconnected';
            throw err;
        }
        const { port: metroPort, targets: sorted, warning: platformFilterWarning } = result;
        this._port = metroPort;
        let connectedTarget = null;
        for (const candidate of sorted) {
            try {
                await this.connectToTarget(candidate);
                const devCheck = await this.evaluate('typeof __DEV__ !== "undefined" && __DEV__ === true');
                if (devCheck.value === true) {
                    connectedTarget = candidate;
                    break;
                }
                console.error(`CDP: target ${candidate.id} (${candidate.title}) has __DEV__=${devCheck.value}, skipping`);
                if (sorted.indexOf(candidate) < sorted.length - 1) {
                    if (this.ws) {
                        this.ws.removeAllListeners();
                        if (this.ws.readyState === WebSocket.OPEN)
                            this.ws.close();
                        this.ws = null;
                    }
                    this._state = 'disconnected';
                    this._helpersInjected = false;
                    this._connectedTarget = null;
                    continue;
                }
                console.error('CDP: no target with __DEV__=true found, using last available target');
                connectedTarget = candidate;
            }
            catch (err) {
                if (sorted.indexOf(candidate) < sorted.length - 1)
                    continue;
                throw err;
            }
        }
        this._connectionGeneration++;
        logger.info('CDP', `Connected to target ${connectedTarget.id} (${connectedTarget.title}) on port ${metroPort}, generation=${this._connectionGeneration}`);
        const msg = `Connected to ${connectedTarget.title} on port ${metroPort}`;
        return platformFilterWarning ? `${msg}. WARNING: ${platformFilterWarning}` : msg;
    }
    async softReconnect() {
        return softReconnectFn(this.buildReconnectCtx());
    }
    async disconnect() {
        this.disposed = true;
        resetState(this);
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
    async evaluate(expression, awaitPromise = false) {
        if (awaitPromise) {
            return this.evaluateAsync(expression);
        }
        const result = await this.sendWithTimeout('Runtime.evaluate', {
            expression,
            returnByValue: true,
        }, CDP_TIMEOUT_MS);
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
        const slot = '__rn_agent_async_' + (++this.slotId) + '_' + Date.now();
        const ASYNC_CLEANUP_MS = CDP_TIMEOUT_MS * 2;
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
        }, CDP_TIMEOUT_MS);
        if (initResult?.exceptionDetails) {
            return {
                error: initResult.exceptionDetails.text ??
                    initResult.exceptionDetails.exception?.description ??
                    'Unknown evaluation error',
            };
        }
        // B45 fix: Use absolute deadline to guarantee total wall-clock stays within CDP_TIMEOUT_MS.
        // Each poll gets only the remaining time (min 500ms) to avoid overshooting.
        const deadline = Date.now() + CDP_TIMEOUT_MS;
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
        return { error: 'Promise did not resolve within ' + CDP_TIMEOUT_MS + 'ms' };
    }
    async send(method, params) {
        return this.sendWithTimeout(method, params, timeoutForMethod(method));
    }
    async connectToTarget(target, retries = 5) {
        let lastError = null;
        for (let i = 0; i < retries; i++) {
            if (this.disposed || this._softReconnectRequested)
                throw new Error('Client disposed or preempted during connection');
            try {
                await this.connectWs(target.webSocketDebuggerUrl);
                // D594: Early stale-target detection — quick probe before full setup
                try {
                    await this.sendWithTimeout('Runtime.evaluate', {
                        expression: '1+1',
                        returnByValue: true,
                    }, CDP_TIMEOUT_FAST);
                }
                catch {
                    throw new Error('Target failed pre-flight probe (1+1) — likely a dead JS context');
                }
                this._connectedTarget = target;
                await this.setup();
                return;
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                // Close stale socket if connectWs succeeded but setup failed
                if (this.ws) {
                    this.ws.removeAllListeners();
                    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                        this.ws.close();
                    }
                    this.ws = null;
                }
                // Connection refused — nothing listening, don't retry
                if (lastError.message.includes('refused')) {
                    this._state = 'disconnected';
                    throw new Error('CDP connection refused. Is Metro running and the app loaded?');
                }
                // Code 1006 and all other errors — retry (1006 is the most common transient failure)
                if (i < retries - 1)
                    await sleep(2000);
            }
        }
        this._state = 'disconnected';
        const hint = lastError?.message.includes('1006')
            ? ' Another debugger may be connected — close React Native DevTools, Flipper, or Chrome DevTools.'
            : '';
        throw new Error(`Failed to connect after ${retries} attempts.${hint}`);
    }
    connectWs(url) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url, {
                handshakeTimeout: 5000,
                maxPayload: 100 * 1024 * 1024,
            });
            let settled = false;
            ws.on('open', () => {
                settled = true;
                this.ws = ws;
                this._state = 'connected';
                resolve();
            });
            ws.on('error', (err) => {
                if (!settled) {
                    settled = true;
                    reject(err);
                }
                else {
                    console.error('CDP WebSocket error:', err instanceof Error ? err.message : err);
                }
            });
            ws.on('message', (data) => {
                this.handleMessage(data);
            });
            ws.on('close', (code) => {
                if (!settled) {
                    settled = true;
                    reject(new Error(`WebSocket closed before connecting: ${code}`));
                    return;
                }
                if (this.ws === ws) {
                    this.rejectAllPending(new Error(`WebSocket closed: ${code}`));
                    this.handleClose(code);
                }
            });
        });
    }
    handleMessage(data) {
        handleMsg(data, this.pending, this.eventHandlers, (params) => this.parseNetworkHookMessage(params));
    }
    parseNetworkHookMessage(params) {
        parseNetHook(params, this._networkMode, this._networkBuffer);
    }
    async setup() {
        const result = await performSetup({
            send: (method, params, ms) => this.sendWithTimeout(method, params, ms ?? timeoutForMethod(method)),
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
        wireEventHandlers(this.eventHandlers, { console: this._consoleBuffer, network: this._networkBuffer, log: this._logBuffer, scripts: this._scripts }, (method, params, ms) => this.sendWithTimeout(method, params, ms ?? timeoutForMethod(method)), () => this._isPaused, (v) => { this._isPaused = v; });
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
            getResettableState: () => this,
            getPort: () => this._port,
            setBgPollTimer: (timer) => { this._bgPollTimer = timer; },
            getBgPollTimer: () => this._bgPollTimer,
        };
    }
    rejectAllPending(reason) {
        rejectPending(this.pending, reason);
    }
    sendWithTimeout(method, params, ms) {
        return sendMsg(this.ws, this.pending, () => ++this.msgId, method, params, ms);
    }
}
