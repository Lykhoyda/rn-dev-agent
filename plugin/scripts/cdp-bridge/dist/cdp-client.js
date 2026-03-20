import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { RingBuffer } from './ring-buffer.js';
import { INJECTED_HELPERS, NETWORK_HOOK_SCRIPT } from './injected-helpers.js';
import { detectBridge } from './bridge-detector.js';
const CDP_ACTIVE_FLAG = join(tmpdir(), 'rn-dev-agent-cdp-active');
const CDP_TIMEOUT_MS = 5000;
const REACT_READY_TIMEOUT_MS = 30000;
const REACT_READY_POLL_MS = 500;
const RECONNECT_DELAY_MS = 1500;
const RECONNECT_ATTEMPTS = 30;
const RECONNECT_RETRY_MS = 1500;
const DISCOVERY_TIMEOUT_MS = 1500;
const DEFAULT_PORTS = [8081, 8082, 19000, 19006];
export class CDPClient {
    ws = null;
    msgId = 0;
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
    constructor(port) {
        this._port = port ?? 8081;
        this._consoleBuffer = new RingBuffer(200);
        this._networkBuffer = new RingBuffer(100);
    }
    get state() { return this._state; }
    get isConnected() { return this._state === 'connected' && this.ws?.readyState === WebSocket.OPEN; }
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
    setActiveFlag() {
        try {
            writeFileSync(CDP_ACTIVE_FLAG, String(process.pid));
        }
        catch { /* best-effort */ }
    }
    clearActiveFlag() {
        try {
            unlinkSync(CDP_ACTIVE_FLAG);
        }
        catch { /* may not exist */ }
    }
    async reinjectHelpers() {
        if (!this.isConnected)
            return false;
        await this.waitForReact(REACT_READY_TIMEOUT_MS);
        const helperResult = await this.evaluate(INJECTED_HELPERS);
        if (helperResult.error) {
            console.error('CDP: failed to re-inject helpers:', helperResult.error);
            this._helpersInjected = false;
            return false;
        }
        const verify = await this.evaluate('typeof globalThis.__RN_AGENT === "object"');
        if (verify.value !== true) {
            this._helpersInjected = false;
            return false;
        }
        this._helpersInjected = true;
        this.setActiveFlag();
        detectBridge(this).then((r) => { this._bridgeDetected = r.present; this._bridgeVersion = r.version; }).catch(() => { });
        return true;
    }
    async autoConnect(portHint, platformFilter) {
        if (this._state === 'connecting' || this.reconnecting) {
            throw new Error('Already connecting to Metro...');
        }
        if (this.disposed) {
            throw new Error('Client is disposed. Create a new CDPClient instance.');
        }
        return this.discoverAndConnect(portHint, platformFilter);
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
        const ports = [...new Set([this._port, ...DEFAULT_PORTS])];
        let metroPort = null;
        for (const p of ports) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), DISCOVERY_TIMEOUT_MS);
            try {
                const resp = await fetch(`http://127.0.0.1:${p}/status`, { signal: ctrl.signal });
                const text = await resp.text();
                if (text.includes('packager-status:running')) {
                    metroPort = p;
                    break;
                }
            }
            catch {
                // Port not available, continue scanning
            }
            finally {
                clearTimeout(timer);
            }
        }
        if (!metroPort) {
            this._state = 'disconnected';
            throw new Error('Metro not found on ports ' + ports.join(', ') +
                '. Is the dev server running? Try: npx expo start or npx react-native start');
        }
        this._port = metroPort;
        const listCtrl = new AbortController();
        const listTimer = setTimeout(() => listCtrl.abort(), DISCOVERY_TIMEOUT_MS * 2);
        let targets;
        try {
            const targetsResp = await fetch(`http://127.0.0.1:${metroPort}/json/list`, { signal: listCtrl.signal });
            targets = (await targetsResp.json());
        }
        catch (err) {
            this._state = 'disconnected';
            throw new Error(`Failed to list CDP targets on port ${metroPort}: ${err instanceof Error ? err.message : err}`);
        }
        finally {
            clearTimeout(listTimer);
        }
        const validTargets = targets
            .filter(t => !!t.webSocketDebuggerUrl && !t.title?.includes('Experimental') &&
            (t.vm === 'Hermes' || t.title?.includes('React Native') || t.description?.includes('React Native')))
            .map(t => ({
            ...t,
            webSocketDebuggerUrl: t.webSocketDebuggerUrl
                ?.replace(/\[::1\]/g, '127.0.0.1')
                ?.replace(/\[::\]/g, '127.0.0.1'),
        }))
            .filter(t => {
            try {
                const { hostname } = new URL(t.webSocketDebuggerUrl);
                return hostname === '127.0.0.1' || hostname === 'localhost';
            }
            catch {
                return false;
            }
        });
        if (validTargets.length === 0) {
            this._state = 'disconnected';
            throw new Error('No Hermes debug target found. Is the app running? Is Hermes enabled?');
        }
        // Filter by platform if specified (matches against title and description)
        let filteredTargets = validTargets;
        let platformFilterWarning;
        if (this._platformFilter) {
            const pf = this._platformFilter.toLowerCase();
            const platformMatched = validTargets.filter(t => {
                const haystack = `${t.title ?? ''} ${t.description ?? ''} ${t.vm ?? ''}`.toLowerCase();
                return haystack.includes(pf);
            });
            if (platformMatched.length > 0) {
                filteredTargets = platformMatched;
            }
            else {
                platformFilterWarning = `Platform filter "${this._platformFilter}" matched no targets (available: ${validTargets.map(t => t.title || t.id).join(', ')}). Connecting to best available target.`;
                console.error('CDP: ' + platformFilterWarning);
            }
        }
        // Sort by descending page ID (highest = most recent session)
        const sorted = [...filteredTargets].sort((a, b) => {
            const aPage = parseInt(a.id?.split('-')[1] ?? '0', 10);
            const bPage = parseInt(b.id?.split('-')[1] ?? '0', 10);
            return bPage - aPage;
        });
        // Try each target, verify __DEV__ is true (correct app JS context)
        let connectedTarget = null;
        for (const candidate of sorted) {
            try {
                await this.connectToTarget(candidate);
                // Probe __DEV__ to verify we're in the app's main JS context
                const devCheck = await this.evaluate('typeof __DEV__ !== "undefined" && __DEV__ === true');
                if (devCheck.value === true) {
                    connectedTarget = candidate;
                    break;
                }
                // Wrong context — disconnect and try next target
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
                // Last target — use it anyway with a warning
                console.error('CDP: no target with __DEV__=true found, using last available target');
                connectedTarget = candidate;
            }
            catch (err) {
                // Connection failed — try next target if available
                if (sorted.indexOf(candidate) < sorted.length - 1)
                    continue;
                throw err;
            }
        }
        this._connectionGeneration++;
        const msg = `Connected to ${connectedTarget.title} on port ${metroPort}`;
        return platformFilterWarning ? `${msg}. WARNING: ${platformFilterWarning}` : msg;
    }
    async softReconnect() {
        if (this.disposed)
            throw new Error('Client is disposed');
        // Preempt any background reconnect loop — signal it to bail out
        if (this.reconnecting) {
            this._softReconnectRequested = true;
            const bailDeadline = Date.now() + 3_000;
            while (this.reconnecting && Date.now() < bailDeadline) {
                await this.sleep(200);
            }
            this._softReconnectRequested = false;
        }
        this.reconnecting = true;
        try {
            this._state = 'disconnected';
            this._helpersInjected = false;
            this._bridgeDetected = false;
            this._bridgeVersion = null;
            this._connectedTarget = null;
            if (this.ws) {
                this.ws.removeAllListeners();
                if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                    this.ws.close();
                }
                this.ws = null;
            }
            this.rejectAllPending(new Error('Stale target — re-discovering'));
            const result = await this.discoverAndConnect();
            this.reconnecting = false;
            return result;
        }
        catch (err) {
            this.reconnecting = false;
            throw err;
        }
    }
    async disconnect() {
        this.disposed = true;
        this._state = 'disconnected';
        this._helpersInjected = false;
        this._bridgeDetected = false;
        this._bridgeVersion = null;
        this._connectedTarget = null;
        this.clearActiveFlag();
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
        const slot = '__rn_agent_async_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
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
        // Poll for result (up to 5s)
        const start = Date.now();
        while (Date.now() - start < CDP_TIMEOUT_MS) {
            const check = await this.sendWithTimeout('Runtime.evaluate', {
                expression: `globalThis['${slot}']`,
                returnByValue: true,
            }, 2000);
            const val = check?.result?.value;
            if (val && typeof val === 'object') {
                // Cleanup immediately (deferred timer is backup)
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
            await this.sleep(100);
        }
        // Slot cleanup is handled by the deferred timer inside Hermes
        return { error: 'Promise did not resolve within ' + CDP_TIMEOUT_MS + 'ms' };
    }
    async send(method, params) {
        return this.sendWithTimeout(method, params, CDP_TIMEOUT_MS);
    }
    async connectToTarget(target, retries = 5) {
        let lastError = null;
        for (let i = 0; i < retries; i++) {
            if (this.disposed || this._softReconnectRequested)
                throw new Error('Client disposed or preempted during connection');
            try {
                await this.connectWs(target.webSocketDebuggerUrl);
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
                    await this.sleep(2000);
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
        try {
            const msg = JSON.parse(data.toString());
            if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
                console.error('CDP: unexpected message shape, ignoring');
                return;
            }
            if (msg.id !== undefined && this.pending.has(msg.id)) {
                const pending = this.pending.get(msg.id);
                clearTimeout(pending.timer);
                this.pending.delete(msg.id);
                if (msg.error) {
                    pending.reject(new Error(msg.error.message));
                }
                else {
                    pending.resolve(msg.result);
                }
            }
            else if (msg.method) {
                const handler = this.eventHandlers.get(msg.method);
                if (handler)
                    handler(msg.params);
                if (msg.method === 'Runtime.consoleAPICalled') {
                    this.parseNetworkHookMessage(msg.params);
                }
            }
        }
        catch (err) {
            console.error('CDP: malformed message:', err instanceof Error ? err.message : err);
        }
    }
    parseNetworkHookMessage(params) {
        if (this._networkMode !== 'hook')
            return;
        const p = params;
        const firstArg = p.args?.[0]?.value;
        if (typeof firstArg !== 'string' || !firstArg.startsWith('__RN_NET__:'))
            return;
        try {
            const parts = firstArg.split(':');
            const type = parts[1];
            const data = JSON.parse(parts.slice(2).join(':'));
            if (type === 'request') {
                this._networkBuffer.push({
                    id: data.id,
                    method: data.method ?? 'GET',
                    url: data.url ?? '',
                    timestamp: new Date().toISOString(),
                });
            }
            else if (type === 'response') {
                const entry = this._networkBuffer.findLast(e => e.id === data.id);
                if (entry) {
                    entry.status = data.status;
                    entry.duration_ms = data.duration_ms;
                }
            }
        }
        catch {
            // Malformed hook message, ignore
        }
    }
    async setup() {
        await this.sendWithTimeout('Runtime.enable', undefined, CDP_TIMEOUT_MS);
        await this.sendWithTimeout('Debugger.enable', undefined, CDP_TIMEOUT_MS);
        try {
            await this.sendWithTimeout('Network.enable', undefined, CDP_TIMEOUT_MS);
            this._networkMode = 'cdp';
        }
        catch {
            this._networkMode = 'none';
        }
        this.eventHandlers.clear();
        this.setupEventHandlers();
        await this.waitForReact(REACT_READY_TIMEOUT_MS);
        const helperResult = await this.evaluate(INJECTED_HELPERS);
        if (helperResult.error) {
            console.error('CDP: failed to inject helpers:', helperResult.error);
            this._helpersInjected = false;
            return;
        }
        const verify = await this.evaluate('typeof globalThis.__RN_AGENT === "object"');
        if (verify.value !== true) {
            console.error('CDP: helper injection succeeded but __RN_AGENT not found');
            this._helpersInjected = false;
            return;
        }
        this._helpersInjected = true;
        this.setActiveFlag();
        detectBridge(this).then((r) => { this._bridgeDetected = r.present; this._bridgeVersion = r.version; }).catch(() => { });
        if (this._networkMode === 'none') {
            const hookResult = await this.evaluate(NETWORK_HOOK_SCRIPT);
            if (hookResult.error) {
                console.error('CDP: failed to inject network hooks:', hookResult.error);
            }
            else {
                await this.evaluate(`
          globalThis.__RN_AGENT_NETWORK_CB__ = function(type, data) {
            console.log('__RN_NET__:' + type + ':' + JSON.stringify(data));
          };
        `);
                this._networkMode = 'hook';
            }
        }
    }
    setupEventHandlers() {
        this.eventHandlers.set('Runtime.consoleAPICalled', (params) => {
            const p = params;
            const text = p.args?.map(a => a.value !== undefined ? String(a.value) : (a.description ?? '')).join(' ') ?? '';
            // Skip internal network hook messages to avoid evicting real console logs
            if (text.startsWith('__RN_NET__:'))
                return;
            this._consoleBuffer.push({
                level: p.type,
                text,
                timestamp: new Date().toISOString(),
            });
        });
        this.eventHandlers.set('Network.requestWillBeSent', (params) => {
            const p = params;
            this._networkBuffer.push({
                id: p.requestId,
                method: p.request?.method ?? 'GET',
                url: p.request?.url ?? '',
                timestamp: new Date().toISOString(),
            });
        });
        this.eventHandlers.set('Network.responseReceived', (params) => {
            const p = params;
            const entry = this._networkBuffer.findLast(e => e.id === p.requestId);
            if (entry) {
                entry.status = p.response?.status;
                entry.duration_ms = Date.now() - new Date(entry.timestamp).getTime();
            }
        });
        this.eventHandlers.set('Network.loadingFailed', (params) => {
            const p = params;
            const entry = this._networkBuffer.findLast(e => e.id === p.requestId);
            if (entry) {
                entry.status = 0;
                entry.duration_ms = Date.now() - new Date(entry.timestamp).getTime();
            }
        });
        this.eventHandlers.set('Debugger.paused', async () => {
            this._isPaused = true;
            try {
                await this.sendWithTimeout('Debugger.resume', undefined, CDP_TIMEOUT_MS);
            }
            catch {
                // Best effort auto-resume
            }
            this._isPaused = false;
        });
    }
    async waitForReact(timeout) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                const result = await this.evaluate('typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== "undefined" && ' +
                    '__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers?.size > 0');
                if (result.value === true)
                    return;
            }
            catch {
                // Not ready yet
            }
            await this.sleep(REACT_READY_POLL_MS);
        }
        console.error(`CDP: React not ready after ${timeout}ms — helpers will be injected anyway`);
    }
    handleClose(code) {
        this._state = 'disconnected';
        this._helpersInjected = false;
        this._bridgeDetected = false;
        this._bridgeVersion = null;
        this._connectedTarget = null;
        if (this.disposed || this.reconnecting)
            return;
        if (code === 1006) {
            console.error('CDP: abnormal close (1006). App may have reloaded or crashed. Attempting reconnect...');
        }
        else {
            console.error('CDP: connection closed (code ' + code + '). Reconnecting...');
        }
        this.reconnecting = true;
        this._state = 'reconnecting';
        this.reconnect().catch((err) => {
            console.error('CDP: reconnect failed:', err instanceof Error ? err.message : err);
            this.reconnecting = false;
        });
    }
    async reconnect() {
        await this.sleep(RECONNECT_DELAY_MS);
        for (let i = 0; i < RECONNECT_ATTEMPTS; i++) {
            if (this.disposed || this._softReconnectRequested) {
                this.reconnecting = false;
                return;
            }
            try {
                await this.discoverAndConnect();
                // Clear flag immediately so close events on the new connection trigger a fresh reconnect
                this.reconnecting = false;
                console.error('CDP: reconnected successfully');
                return;
            }
            catch {
                if (i < RECONNECT_ATTEMPTS - 1) {
                    if (this._softReconnectRequested) {
                        this.reconnecting = false;
                        return;
                    }
                    await this.sleep(RECONNECT_RETRY_MS);
                }
            }
        }
        this.reconnecting = false;
        this._state = 'disconnected';
        this.clearActiveFlag();
        console.error('CDP: reconnect failed after ' + RECONNECT_ATTEMPTS + ' attempts. Starting background poll...');
        this.startBackgroundPoll();
    }
    startBackgroundPoll() {
        if (this._bgPollTimer || this.disposed)
            return;
        this._bgPollTimer = setInterval(async () => {
            if (this.disposed || this.isConnected || this.reconnecting) {
                this.stopBackgroundPoll();
                return;
            }
            try {
                const res = await fetch(`http://127.0.0.1:${this._port}/status`, {
                    signal: AbortSignal.timeout(2000),
                });
                const text = await res.text();
                if (text === 'packager-status:running') {
                    console.error('CDP: Metro detected via background poll. Reconnecting...');
                    this.stopBackgroundPoll();
                    this.reconnecting = true;
                    this._state = 'reconnecting';
                    this.reconnect().catch(() => { this.reconnecting = false; });
                }
            }
            catch {
                // Metro not available yet — keep polling
            }
        }, 5000);
    }
    stopBackgroundPoll() {
        if (this._bgPollTimer) {
            clearInterval(this._bgPollTimer);
            this._bgPollTimer = null;
        }
    }
    rejectAllPending(reason) {
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(reason);
        }
        this.pending.clear();
    }
    sendWithTimeout(method, params, ms) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('WebSocket not connected'));
        }
        return new Promise((resolve, reject) => {
            const id = ++this.msgId;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP timeout (${ms}ms): ${method}. JS thread may be blocked, paused on a breakpoint, or waiting on an unresolved promise.`));
            }, ms);
            this.pending.set(id, { resolve: resolve, reject, timer });
            try {
                this.ws.send(JSON.stringify({ id, method, params }));
            }
            catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err instanceof Error ? err : new Error(`ws.send failed: ${err}`));
            }
        });
    }
    sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}
