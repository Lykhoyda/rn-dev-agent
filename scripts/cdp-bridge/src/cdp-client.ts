import WebSocket from 'ws';
import { RingBuffer } from './ring-buffer.js';
import { detectBridge } from './bridge-detector.js';
import { logger } from './logger.js';
import { performSetup, reinjectHelpers as reinjectHelpersFn } from './cdp/setup.js';
import { resetState, setActiveFlag, clearActiveFlag, sleep } from './cdp/state.js';
import type { CDPResettableState } from './cdp/state.js';
import { CDP_TIMEOUT_FAST, CDP_TIMEOUT_MS, timeoutForMethod } from './cdp/timeout-config.js';
import { sendWithTimeout as sendMsg, rejectAllPending as rejectPending, handleMessage as handleMsg } from './cdp/transport.js';
import { wireEventHandlers, parseNetworkHookMessage as parseNetHook } from './cdp/event-handlers.js';
import { discover, discoverForList } from './cdp/discovery.js';
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
  private _networkBuffer: RingBuffer<NetworkEntry>;
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
    this._networkBuffer = new RingBuffer<NetworkEntry>(100);
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
  get networkBuffer(): RingBuffer<NetworkEntry> { return this._networkBuffer; }
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
    return this._bridgeDetected ? `__RN_DEV_BRIDGE__.${call}` : `__RN_AGENT.${call}`;
  }

  bridgeWithFallback(call: string): string {
    return this._bridgeDetected
      ? `(function() { var fb = false; try { var r = __RN_DEV_BRIDGE__.${call}; var p = JSON.parse(r); if (p && (p.__agent_error || p.error)) fb = true; else return r; } catch(e) { fb = true; } if (fb) return __RN_AGENT.${call}; })()`
      : `__RN_AGENT.${call}`;
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

  async autoConnect(portHint?: number, platformFilter?: string): Promise<string> {
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

  async listTargets(portHint?: number): Promise<{ port: number; targets: HermesTarget[] }> {
    return discoverForList(this._port, portHint);
  }

  private _platformFilter?: string;

  private async discoverAndConnect(portHint?: number, platformFilter?: string): Promise<string> {
    if (this.disposed) {
      throw new Error('Client is disposed. Create a new CDPClient instance.');
    }

    if (portHint) this._port = portHint;
    if (platformFilter !== undefined) this._platformFilter = platformFilter || undefined;
    this._state = 'connecting';

    let result;
    try {
      result = await discover(this._port, this._platformFilter);
    } catch (err) {
      this._state = 'disconnected';
      throw err;
    }

    const { port: metroPort, targets: sorted, warning: platformFilterWarning } = result;
    this._port = metroPort;

    let connectedTarget: HermesTarget | null = null;
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
            if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
            this.ws = null;
          }
          this._state = 'disconnected';
          this._helpersInjected = false;
          this._connectedTarget = null;
          continue;
        }
        console.error('CDP: no target with __DEV__=true found, using last available target');
        connectedTarget = candidate;
      } catch (err) {
        if (sorted.indexOf(candidate) < sorted.length - 1) continue;
        throw err;
      }
    }

    this._connectionGeneration++;
    logger.info('CDP', `Connected to target ${connectedTarget!.id} (${connectedTarget!.title}) on port ${metroPort}, generation=${this._connectionGeneration}`);
    const msg = `Connected to ${connectedTarget!.title} on port ${metroPort}`;
    return platformFilterWarning ? `${msg}. WARNING: ${platformFilterWarning}` : msg;
  }

  async softReconnect(): Promise<string> {
    return softReconnectFn(this.buildReconnectCtx());
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    resetState(this as unknown as CDPResettableState);
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

  async evaluate(expression: string, awaitPromise = false): Promise<EvaluateResult> {
    if (awaitPromise) {
      return this.evaluateAsync(expression);
    }

    const result = await this.sendWithTimeout('Runtime.evaluate', {
      expression,
      returnByValue: true,
    }, CDP_TIMEOUT_MS) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

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
    }, CDP_TIMEOUT_MS) as { exceptionDetails?: { text?: string; exception?: { description?: string } } };

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
    return { error: 'Promise did not resolve within ' + CDP_TIMEOUT_MS + 'ms' };
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    return this.sendWithTimeout(method, params, timeoutForMethod(method));
  }

  private async connectToTarget(target: HermesTarget, retries = 5): Promise<void> {
    let lastError: Error | null = null;
    for (let i = 0; i < retries; i++) {
      if (this.disposed || this._softReconnectRequested) throw new Error('Client disposed or preempted during connection');
      try {
        await this.connectWs(target.webSocketDebuggerUrl);
        // D594: Early stale-target detection — quick probe before full setup
        try {
          await this.sendWithTimeout('Runtime.evaluate', {
            expression: '1+1',
            returnByValue: true,
          }, CDP_TIMEOUT_FAST);
        } catch {
          throw new Error('Target failed pre-flight probe (1+1) — likely a dead JS context');
        }
        this._connectedTarget = target;
        await this.setup();
        return;
      } catch (err) {
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
        if (i < retries - 1) await sleep(2000);
      }
    }
    this._state = 'disconnected';
    const hint = lastError?.message.includes('1006')
      ? ' Another debugger may be connected — close React Native DevTools, Flipper, or Chrome DevTools.'
      : '';
    throw new Error(`Failed to connect after ${retries} attempts.${hint}`);
  }

  private connectWs(url: string): Promise<void> {
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
        } else {
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

  private handleMessage(data: WebSocket.RawData): void {
    handleMsg(data, this.pending, this.eventHandlers, (params) => this.parseNetworkHookMessage(params));
  }

  private parseNetworkHookMessage(params: unknown): void {
    parseNetHook(params, this._networkMode, this._networkBuffer);
  }

  private async setup(): Promise<void> {
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
      detectBridge(this).then((r) => { this._bridgeDetected = r.present; this._bridgeVersion = r.version; logger.debug('CDP', `Bridge detection: present=${r.present}, version=${r.version}`); }).catch(() => {});
    }
  }

  private setupEventHandlers(): void {
    wireEventHandlers(
      this.eventHandlers,
      { console: this._consoleBuffer, network: this._networkBuffer, log: this._logBuffer, scripts: this._scripts },
      (method, params, ms) => this.sendWithTimeout(method, params, ms ?? timeoutForMethod(method)),
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
      getResettableState: () => this as unknown as CDPResettableState,
      getPort: () => this._port,
      setBgPollTimer: (timer) => { this._bgPollTimer = timer; },
      getBgPollTimer: () => this._bgPollTimer,
    };
  }

  private rejectAllPending(reason: Error): void {
    rejectPending(this.pending, reason);
  }

  private sendWithTimeout(method: string, params: unknown, ms: number): Promise<unknown> {
    return sendMsg(this.ws, this.pending, () => ++this.msgId, method, params, ms);
  }

}
