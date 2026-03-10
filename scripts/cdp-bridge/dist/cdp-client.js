import WebSocket from 'ws';
import { RingBuffer } from './ring-buffer.js';
import { INJECTED_HELPERS, NETWORK_HOOK_SCRIPT } from './injected-helpers.js';
const CDP_TIMEOUT_MS = 5000;
const REACT_READY_TIMEOUT_MS = 30000;
const REACT_READY_POLL_MS = 500;
const RECONNECT_DELAY_MS = 1500;
const RECONNECT_ATTEMPTS = 10;
const RECONNECT_RETRY_MS = 1000;
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
    async autoConnect(portHint) {
        if (this._state === 'connecting' || this.reconnecting) {
            throw new Error('Already connecting to Metro...');
        }
        if (this.disposed) {
            throw new Error('Client is disposed. Create a new CDPClient instance.');
        }
        if (portHint)
            this._port = portHint;
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
            .filter(t => t.vm === 'Hermes' && !!t.webSocketDebuggerUrl && !t.title?.includes('Experimental'))
            .map(t => ({
            ...t,
            webSocketDebuggerUrl: t.webSocketDebuggerUrl
                ?.replace(/\[::1\]/g, '127.0.0.1')
                ?.replace(/\[::\]/g, '127.0.0.1'),
        }));
        if (validTargets.length === 0) {
            this._state = 'disconnected';
            throw new Error('No Hermes debug target found. Is the app running? Is Hermes enabled?');
        }
        const target = validTargets.reduce((a, b) => {
            const aPage = parseInt(a.id?.split('-')[1] ?? '0', 10);
            const bPage = parseInt(b.id?.split('-')[1] ?? '0', 10);
            return bPage > aPage ? b : a;
        });
        await this.connectToTarget(target);
        this._connectionGeneration++;
        return `Connected to ${target.title} on port ${metroPort}`;
    }
    async disconnect() {
        this.disposed = true;
        this._state = 'disconnected';
        this._helpersInjected = false;
        this._connectedTarget = null;
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
        const result = await this.sendWithTimeout('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise,
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
    async send(method, params) {
        return this.sendWithTimeout(method, params, CDP_TIMEOUT_MS);
    }
    async connectToTarget(target, retries = 5) {
        for (let i = 0; i < retries; i++) {
            if (this.disposed)
                throw new Error('Client disposed during connection');
            try {
                await this.connectWs(target.webSocketDebuggerUrl);
                this._connectedTarget = target;
                await this.setup();
                return;
            }
            catch (err) {
                if (err instanceof Error && (err.message.includes('1006') || err.message.includes('refused'))) {
                    this._state = 'disconnected';
                    throw new Error('CDP connection rejected (code 1006). Another debugger may be connected. ' +
                        'Close React Native DevTools, Flipper, or Chrome DevTools and try again.');
                }
                if (i < retries - 1)
                    await this.sleep(2000);
            }
        }
        this._state = 'disconnected';
        throw new Error(`Failed to connect after ${retries} attempts`);
    }
    connectWs(url) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
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
        }
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
        this._helpersInjected = true;
    }
    setupEventHandlers() {
        this.eventHandlers.set('Runtime.consoleAPICalled', (params) => {
            const p = params;
            this._consoleBuffer.push({
                level: p.type,
                text: p.args?.map(a => a.value !== undefined ? String(a.value) : (a.description ?? '')).join(' ') ?? '',
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
        }).finally(() => {
            this.reconnecting = false;
        });
    }
    async reconnect() {
        await this.sleep(RECONNECT_DELAY_MS);
        for (let i = 0; i < RECONNECT_ATTEMPTS; i++) {
            if (this.disposed)
                return;
            try {
                await this.autoConnect();
                console.error('CDP: reconnected successfully');
                return;
            }
            catch {
                if (i < RECONNECT_ATTEMPTS - 1) {
                    await this.sleep(RECONNECT_RETRY_MS);
                }
            }
        }
        this._state = 'disconnected';
        console.error('CDP: reconnect failed after ' + RECONNECT_ATTEMPTS + ' attempts');
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
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
}
