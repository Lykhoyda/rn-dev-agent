import WebSocket from 'ws';
import { RingBuffer } from './ring-buffer.js';
import { detectBridge } from './bridge-detector.js';
import { logger } from './logger.js';
import { performSetup, reinjectHelpers as reinjectHelpersFn } from './cdp/setup.js';
import { resetState, setActiveFlag, clearActiveFlag, sleep } from './cdp/state.js';
import type { ResettableState } from './cdp/state.js';
import { defaultTimeout, timeoutForMethod } from './cdp/timeout-config.js';
import type { Platform } from './cdp/timeout-config.js';
import { sendWithTimeout as sendMsg, rejectAllPending as rejectPending, handleMessage as handleMsg } from './cdp/transport.js';
import { wireEventHandlers, parseNetworkHookMessage as parseNetHook } from './cdp/event-handlers.js';
import { discover, discoverForList } from './cdp/discovery.js';
import { helperExpr as helperExprFn, bridgeWithFallback as bridgeWithFallbackFn } from './cdp/helper-expr.js';
import {
  autoConnect as autoConnectFn,
  discoverAndConnect as discoverAndConnectFn,
} from './cdp/connect.js';
import type { ConnectContext, ConnectFilters } from './cdp/connect.js';
import {
  handleClose as handleCloseFn,
  reconnect as reconnectFn,
  softReconnect as softReconnectFn,
  startBackgroundPoll as startBgPoll,
  stopBackgroundPoll as stopBgPoll,
} from './cdp/reconnection.js';
import type { ReconnectContext } from './cdp/reconnection.js';
import type {
  PendingCall,
  HermesTarget,
  ConsoleEntry,
  NetworkEntry,
  LogEntry,
  CDPClientState,
  EvaluateResult,
} from './types.js';

export class CDPClient {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private slotId = 0;
  private pending = new Map<number, PendingCall>();
  private eventHandlers = new Map<string, (params: unknown) => void>();
  private _consoleBuffer: RingBuffer<ConsoleEntry>;
  private _networkBuffer: RingBuffer<NetworkEntry, string>;
  private _port: number;
  private reconnecting = false;
  private disposed = false;
  private _helpersInjected = false;
  private _networkMode: 'cdp' | 'hook' | 'none' = 'none';
  private _isPaused = false;
  private _connectedTarget: HermesTarget | null = null;
  private _state: CDPClientState = 'disconnected';
  private _connectionGeneration = 0;
  private _softReconnectRequested = false;
  private _bgPollTimer: ReturnType<typeof setInterval> | null = null;
  private _bridgeDetected = false;
  private _bridgeVersion: number | null = null;

  private _logBuffer: RingBuffer<LogEntry>;
  private _logDomainEnabled = false;
  private _profilerAvailable = false;
  private _heapProfilerAvailable = false;

  // Tier 3: scriptParsed cache (D592)
  private _scripts = new Map<string, { scriptId: string; url: string; startLine: number; endLine: number }>();
  // Tier 3: reconnection state visibility (D596)
  private _lastReconnectAttempt: string | null = null;
  private _reconnectAttemptCount = 0;

  constructor(port?: number) {
    this._port = port ?? 8081;
    this._consoleBuffer = new RingBuffer<ConsoleEntry>(200);
    this._networkBuffer = new RingBuffer<NetworkEntry, string>(100, { indexKey: (e) => e.id });
    this._logBuffer = new RingBuffer<LogEntry>(50);
  }

  get state(): CDPClientState { return this._state; }
  get isConnected(): boolean { return !this.disposed && this._state === 'connected' && this.ws?.readyState === WebSocket.OPEN; }
  get isPaused(): boolean { return this._isPaused; }
  get helpersInjected(): boolean { return this._helpersInjected; }
  get metroPort(): number { return this._port; }
  get connectedTarget(): HermesTarget | null { return this._connectedTarget; }
  get networkMode(): 'cdp' | 'hook' | 'none' { return this._networkMode; }
  get consoleBuffer(): RingBuffer<ConsoleEntry> { return this._consoleBuffer; }
  get networkBuffer(): RingBuffer<NetworkEntry, string> { return this._networkBuffer; }
  get connectionGeneration(): number { return this._connectionGeneration; }
  get bridgeDetected(): boolean { return this._bridgeDetected; }
  get bridgeVersion(): number | null { return this._bridgeVersion; }
  get logBuffer(): RingBuffer<LogEntry> { return this._logBuffer; }
  get logDomainEnabled(): boolean { return this._logDomainEnabled; }
  get profilerAvailable(): boolean { return this._profilerAvailable; }
  get heapProfilerAvailable(): boolean { return this._heapProfilerAvailable; }
  get scripts(): Map<string, { scriptId: string; url: string; startLine: number; endLine: number }> { return this._scripts; }
  get reconnectState(): { active: boolean; lastAttempt: string | null; attemptCount: number } {
    return { active: this.reconnecting, lastAttempt: this._lastReconnectAttempt, attemptCount: this._reconnectAttemptCount };
  }

  helperExpr(call: string): string {
    return helperExprFn(call, this._bridgeDetected);
  }

  bridgeWithFallback(call: string): string {
    return bridgeWithFallbackFn(call, this._bridgeDetected);
  }

  async reinjectHelpers(waitTimeout?: number): Promise<boolean> {
    if (!this.isConnected) return false;
    const ok = await reinjectHelpersFn(
      (expr) => this.evaluate(expr),
      waitTimeout,
    );
    this._helpersInjected = ok;
    if (ok) {
      setActiveFlag(this._port, this._connectedTarget);
      detectBridge(this).then((r) => { this._bridgeDetected = r.present; this._bridgeVersion = r.version; }).catch(() => {});
    }
    return ok;
  }

  async autoConnect(portHint?: number, filtersOrPlatform?: string | ConnectFilters): Promise<string> {
    const filters: ConnectFilters = typeof filtersOrPlatform === 'string'
      ? { platform: filtersOrPlatform }
      : (filtersOrPlatform ?? {});
    return autoConnectFn(this.buildConnectCtx(), portHint, filters);
  }

  async listTargets(portHint?: number): Promise<{ port: number; targets: HermesTarget[] }> {
    return discoverForList(this._port, portHint);
  }

  private _connectFilters: ConnectFilters = {};

  private async discoverAndConnect(portHint?: number, filters?: ConnectFilters): Promise<string> {
    return discoverAndConnectFn(this.buildConnectCtx(), portHint, filters);
  }

  async softReconnect(): Promise<string> {
    return softReconnectFn(this.buildReconnectCtx());
  }

  async disconnect(): Promise<void> {
    // B76/D644: idempotent guard — graceful-shutdown may race with a tool-triggered
    // disconnect (e.g. cdp_restart calling disconnect() while SIGTERM fires). Second
    // caller sees already-disposed and returns cleanly.
    if (this.disposed) return;
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

  private get effectivePlatform(): Platform {
    return this._connectedTarget?.platform ?? null;
  }

  async evaluate(expression: string, awaitPromise = false): Promise<EvaluateResult> {
    if (awaitPromise) {
      return this.evaluateAsync(expression);
    }

    const timeout = defaultTimeout(this.effectivePlatform);
    const result = await this.sendWithTimeout('Runtime.evaluate', {
      expression,
      returnByValue: true,
    }, timeout) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

    if (result?.exceptionDetails) {
      return {
        error: result.exceptionDetails.text ??
          result.exceptionDetails.exception?.description ??
          'Unknown evaluation error',
      };
    }
    return { value: result?.result?.value };
  }

  private async evaluateAsync(expression: string): Promise<EvaluateResult> {
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
    }, timeout) as { exceptionDetails?: { text?: string; exception?: { description?: string } } };

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
      if (remaining < 500) break;
      const pollTimeout = Math.min(remaining - 100, 1500);

      const check = await this.sendWithTimeout('Runtime.evaluate', {
        expression: `globalThis['${slot}']`,
        returnByValue: true,
      }, pollTimeout) as { result?: { value?: unknown } };

      const val = check?.result?.value as { v?: string; e?: string } | undefined;
      if (val && typeof val === 'object') {
        void this.sendWithTimeout('Runtime.evaluate', {
          expression: `delete globalThis['${slot}']`,
          returnByValue: true,
        }, 1000).catch(() => {});

        if ('e' in val) return { error: String(val.e) };
        try {
          return { value: JSON.parse(val.v as string) };
        } catch {
          return { value: val.v };
        }
      }
      await sleep(100);
    }

    void this.sendWithTimeout('Runtime.evaluate', {
      expression: `delete globalThis['${slot}']`,
      returnByValue: true,
    }, 1000).catch(() => {});
    return { error: 'Promise did not resolve within ' + timeout + 'ms' };
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    return this.sendWithTimeout(method, params, timeoutForMethod(method, this.effectivePlatform));
  }

  private handleMessage(data: WebSocket.RawData): void {
    handleMsg(data, this.pending, this.eventHandlers, (params) => this.parseNetworkHookMessage(params));
  }

  private parseNetworkHookMessage(params: unknown): void {
    parseNetHook(params, this._networkMode, this._networkBuffer);
  }

  private async setup(): Promise<void> {
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
      detectBridge(this).then((r) => { this._bridgeDetected = r.present; this._bridgeVersion = r.version; logger.debug('CDP', `Bridge detection: present=${r.present}, version=${r.version}`); }).catch(() => {});
    }
  }

  private setupEventHandlers(): void {
    wireEventHandlers(
      this.eventHandlers,
      { console: this._consoleBuffer, network: this._networkBuffer, log: this._logBuffer, scripts: this._scripts },
      (method, params, ms) => this.sendWithTimeout(method, params, ms ?? timeoutForMethod(method, this.effectivePlatform)),
      () => this._isPaused,
      (v) => { this._isPaused = v; },
    );
  }

  private handleClose(code: number): void {
    handleCloseFn(this.buildReconnectCtx(), code);
  }

  private async reconnect(): Promise<void> {
    return reconnectFn(this.buildReconnectCtx());
  }

  private startBackgroundPoll(): void {
    startBgPoll(this.buildReconnectCtx());
  }

  private stopBackgroundPoll(): void {
    stopBgPoll(this.buildReconnectCtx());
  }

  private buildReconnectCtx(): ReconnectContext {
    return {
      isDisposed: () => this.disposed,
      isReconnecting: () => this.reconnecting,
      isConnected: () => this.isConnected,
      isSoftReconnectRequested: () => this._softReconnectRequested,
      setReconnecting: (v) => { this.reconnecting = v; },
      setSoftReconnectRequested: (v) => { this._softReconnectRequested = v; },
      setState: (s) => { this._state = s as CDPClientState; },
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

  private buildConnectCtx(): ConnectContext {
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

  private buildResettableState(): ResettableState {
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

  private rejectAllPending(reason: Error): void {
    rejectPending(this.pending, reason);
  }

  private sendWithTimeout(method: string, params: unknown, ms: number): Promise<unknown> {
    return sendMsg(this.ws, this.pending, () => ++this.msgId, method, params, ms);
  }

}
