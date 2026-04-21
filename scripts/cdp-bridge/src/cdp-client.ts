import WebSocket from 'ws';
import { RingBuffer, DeviceBufferManager, makeDeviceKey } from './ring-buffer.js';
import { getNetworkBufferManager } from './cdp/network-buffer-manager.js';
import { MetroEventsClient } from './metro/events-client.js';
import { CDPMultiplexer } from './cdp/multiplexer.js';
import type { MultiplexerOptions } from './cdp/multiplexer.js';
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
  // B128 (D657): DeviceBufferManager is now a module-level singleton keyed by
  // `${metroPort}-${targetId}`. Survives CDPClient lifecycle (destroy/rebuild
  // on force reconnect or cdp_restart). We hold a reference only as a getter
  // convenience; never instantiate a new one here.
  private _networkBufferManager: DeviceBufferManager<NetworkEntry, string>;
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
  private _metroEventsClient: MetroEventsClient | null = null;

  // Tier 3: scriptParsed cache (D592)
  private _scripts = new Map<string, { scriptId: string; url: string; startLine: number; endLine: number }>();
  // Tier 3: reconnection state visibility (D596)
  private _lastReconnectAttempt: string | null = null;
  private _reconnectAttemptCount = 0;

  // M1b (Phase 100+): multiplexer proxy state. When `_proxyUrl` is non-null, the
  // CDP WebSocket routes through `_multiplexer` instead of connecting directly to
  // Hermes. Lets React Native DevTools share the same Hermes target on RN < 0.85.
  private _proxyUrl: string | null = null;
  private _multiplexer: CDPMultiplexer | null = null;
  // D661 review finding: concurrent startProxy() callers would each allocate a
  // multiplexer, with the second overwriting _multiplexer and orphaning the first.
  // In-flight promise cache serializes concurrent callers on the same startup.
  private _startProxyInFlight: Promise<string> | null = null;
  // B132 (M1b follow-up): separate user intent from live proxy state. `_proxyUrl`
  // is the live state (null between suspend and resume). `_proxyDesired` is the
  // user's standing wish — set by successful startProxy(), cleared by stopProxy()
  // or disconnect(). Preserved across _suspendProxy() so post-reconnect auto-resume
  // can rehydrate the proxy against the fresh target URL.
  private _proxyDesired = false;

  constructor(port?: number) {
    this._port = port ?? 8081;
    this._consoleBuffer = new RingBuffer<ConsoleEntry>(200);
    // B128 (D657): use process-scoped singleton instead of per-client instance
    this._networkBufferManager = getNetworkBufferManager();
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
  /** M4 (D655): per-device buffer manager. Use `activeDeviceKey` for single-device queries, `'all'` for cross-device. */
  get networkBufferManager(): DeviceBufferManager<NetworkEntry, string> { return this._networkBufferManager; }
  /** M4 (D655): the device key for the currently connected target. Used as the default scope for per-device buffer queries. */
  get activeDeviceKey(): string { return makeDeviceKey(this._port, this._connectedTarget?.id); }
  /** M5 (D656): Metro /events subscriber; null until first successful CDP setup attaches it. */
  get metroEventsClient(): MetroEventsClient | null { return this._metroEventsClient; }
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
  /** M1b: URL the CDPClient routes through (null when connected directly). */
  get proxyUrl(): string | null { return this._proxyUrl; }
  /** M1b: true when the multiplexer is owned by this client and routing traffic. */
  get isProxyActive(): boolean { return this._proxyUrl !== null; }
  /** M1b: the multiplexer instance (null when no proxy is active). */
  get proxyMultiplexer(): CDPMultiplexer | null { return this._multiplexer; }

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
    // B132: if the proxy is active, suspend it first so the reconnect goes
    // DIRECT to Hermes (not through the potentially-stale proxy), then resume
    // on success so DevTools can reconnect. This covers auto-recovery paths
    // like `cdp_status` __DEV__=false recovery.
    const wasProxyActive = this._proxyUrl !== null;
    if (wasProxyActive) {
      await this._suspendProxy();
    }
    const result = await this._softReconnectDirect();
    if (wasProxyActive) {
      await this._resumeProxy();
    }
    return result;
  }

  /**
   * B132: softReconnect that BYPASSES the suspend/resume wrapper. Used only
   * by `_doStartProxy` — we must not suspend the multiplexer we just allocated.
   * Kept as a named private method (not an inline call) so tests can stub it
   * independently of the public `softReconnect`.
   */
  private async _softReconnectDirect(): Promise<string> {
    return softReconnectFn(this.buildReconnectCtx());
  }

  /**
   * M1b (Phase 100+): start the multiplexer proxy and switch this client's CDP
   * WebSocket to ride through it. After this resolves, React Native DevTools
   * (or any other WS consumer) can connect to the same port and coexist with
   * the MCP. Requires an already-connected target — call `autoConnect` first.
   *
   * No-op if the proxy is already active (returns existing URL). Concurrent
   * callers share a single in-flight promise — the multiplexer is allocated
   * exactly once per successful `(connected → active)` transition.
   */
  async startProxy(opts?: Partial<Omit<MultiplexerOptions, 'hermesUrl'>>): Promise<string> {
    if (this._proxyUrl) return this._proxyUrl;
    if (this._startProxyInFlight) return this._startProxyInFlight;
    this._startProxyInFlight = this._doStartProxy(opts).finally(() => {
      this._startProxyInFlight = null;
    });
    return this._startProxyInFlight;
  }

  private async _doStartProxy(opts?: Partial<Omit<MultiplexerOptions, 'hermesUrl'>>): Promise<string> {
    if (!this._connectedTarget) {
      throw new Error('startProxy requires an active CDP connection — call autoConnect first');
    }
    const hermesUrl = this._connectedTarget.webSocketDebuggerUrl;
    const multiplexer = new CDPMultiplexer({ hermesUrl, ...opts });
    const port = await multiplexer.start();
    this._multiplexer = multiplexer;
    this._proxyUrl = `ws://127.0.0.1:${port}`;
    logger.info('CDP', `Proxy started on ${this._proxyUrl}, soft-reconnecting current session`);
    try {
      // B132: call `_softReconnectDirect` instead of `this.softReconnect()`. The
      // wrapper would observe _proxyUrl just set above and try to suspend the
      // multiplexer we just allocated — infinite rollback. `_softReconnectDirect`
      // is also testable in isolation (tests can stub it to simulate failure
      // without the full softReconnectFn machinery).
      await this._softReconnectDirect();
    } catch (err) {
      // Soft-reconnect failed — tear the proxy back down so we don't leave a
      // half-switched state (proxy running but CDPClient disconnected).
      try { await multiplexer.stop(); } catch { /* best-effort */ }
      this._multiplexer = null;
      this._proxyUrl = null;
      throw err;
    }
    // B132: set intent ONLY after the full startup+softReconnect succeeds.
    // If any step failed, _proxyDesired stays false — no surprise auto-resume
    // on the next reconnect.
    this._proxyDesired = true;
    return this._proxyUrl;
  }

  /**
   * M1b: stop the multiplexer and reconnect this client directly to Hermes.
   * No-op if the proxy isn't active.
   */
  async stopProxy(): Promise<void> {
    // B132: clear intent FIRST so the softReconnect wrapper's auto-resume hook
    // (and any in-flight afterReconnect hook from a concurrent reconnect) sees
    // _proxyDesired=false and skips re-allocating a new proxy.
    this._proxyDesired = false;
    if (!this._proxyUrl) return;
    logger.info('CDP', `Stopping proxy at ${this._proxyUrl}`);
    const mux = this._multiplexer;
    this._proxyUrl = null;
    this._multiplexer = null;
    // Reconnect first (uses direct target URL now that _proxyUrl is null), then
    // stop the old proxy. Reverse order would briefly leave the client trying
    // to route through an already-stopped proxy.
    try {
      await this.softReconnect();
    } finally {
      if (mux) {
        try { await mux.stop(); } catch { /* best-effort */ }
      }
    }
  }

  /**
   * B132: stop the multiplexer without reconnecting the MCP. Called from
   * `handleClose` and the `softReconnect` wrapper BEFORE a reconnect fires, so
   * the reconnect attempts go DIRECT to Hermes. Preserves `_proxyDesired` so
   * `_resumeProxy` can rehydrate the proxy against the fresh target URL after
   * the reconnect succeeds.
   */
  private async _suspendProxy(): Promise<void> {
    if (!this._proxyUrl) return;
    const mux = this._multiplexer;
    // Clear _proxyUrl SYNCHRONOUSLY so any concurrent reconnect observes it
    // cleared before the multiplexer's HTTP server is actually torn down.
    this._proxyUrl = null;
    this._multiplexer = null;
    if (mux) {
      try { await mux.stop(); } catch { /* best-effort */ }
    }
  }

  /**
   * B132: if `_proxyDesired` is set and no proxy is currently active, restart
   * the multiplexer against the CURRENT `_connectedTarget` (which may have a
   * different `webSocketDebuggerUrl` after reconnect — that's the whole point).
   *
   * Failure policy: log a warning and CLEAR `_proxyDesired` so we don't
   * silently loop on every subsequent reconnect. User can re-run
   * `cdp_open_devtools` to retry manually. This is "predictable over resilient"
   * — noisy failures are easier to debug than silent retries.
   */
  private async _resumeProxy(): Promise<void> {
    if (!this._proxyDesired) return;
    if (this.disposed) return;
    if (!this._connectedTarget) return;
    if (this._proxyUrl) return;
    try {
      await this.startProxy();
      logger.info('CDP', 'Proxy auto-resumed after reconnect');
    } catch (err) {
      logger.warn('CDP', `Proxy auto-resume failed — clearing desired flag. Run cdp_open_devtools to retry: ${err instanceof Error ? err.message : err}`);
      this._proxyDesired = false;
    }
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

    // M5 (D656): tear down Metro /events subscriber alongside CDP shutdown.
    if (this._metroEventsClient) {
      try { this._metroEventsClient.stop(); } catch { /* best-effort */ }
      this._metroEventsClient = null;
    }

    // M1b: tear down multiplexer if one is active. This is the only reliable
    // end-of-session cleanup hook for the proxy (SIGTERM → disconnect → here).
    if (this._multiplexer) {
      try { await this._multiplexer.stop(); } catch { /* best-effort */ }
      this._multiplexer = null;
      this._proxyUrl = null;
    }
    // B132: clear intent on disposal — a fresh CDPClient must not inherit
    // desired=true from a previous session.
    this._proxyDesired = false;

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
    parseNetHook(params, this._networkMode, this._networkBufferManager, this.activeDeviceKey);
  }

  private async setup(): Promise<void> {
    // M5 (D656): attach Metro /events subscriber on every setup. Idempotent for the
    // common reconnect case (start() is a no-op when already open). Fire-and-forget —
    // failure to connect events WS must not block CDP setup.
    this.ensureMetroEventsClient().catch(() => { /* MetroEventsClient handles its own reconnects */ });

    const result = await performSetup({
      send: (method, params, ms) => this.sendWithTimeout(method, params, ms ?? timeoutForMethod(method, this.effectivePlatform)),
      evaluate: (expr) => this.evaluate(expr),
      port: this._port,
      connectedTarget: this._connectedTarget,
      networkManager: this._networkBufferManager,
      getDeviceKey: () => this.activeDeviceKey,
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

  private async ensureMetroEventsClient(): Promise<void> {
    // Multi-review catch: if Metro hopped ports (CDPClient's `_port` was updated
    // via discovery), the existing MetroEventsClient is still bound to the old
    // port and would silently reconnect-forever to a dead endpoint. Detect the
    // mismatch and swap in a fresh client. Covers the Metro-restart-on-new-port
    // scenario this story is supposed to handle gracefully.
    if (this._metroEventsClient && this._metroEventsClient.port !== this._port) {
      this._metroEventsClient.stop();
      this._metroEventsClient = null;
    }
    if (!this._metroEventsClient) {
      this._metroEventsClient = new MetroEventsClient({ port: this._port });
    }
    await this._metroEventsClient.start();
  }

  private setupEventHandlers(): void {
    wireEventHandlers(
      this.eventHandlers,
      { console: this._consoleBuffer, network: this._networkBufferManager, log: this._logBuffer, scripts: this._scripts },
      (method, params, ms) => this.sendWithTimeout(method, params, ms ?? timeoutForMethod(method, this.effectivePlatform)),
      () => this._isPaused,
      (v) => { this._isPaused = v; },
      () => this.activeDeviceKey,
    );
  }

  private handleClose(code: number): void {
    // B132: if the proxy is active when the upstream closes, suspend it BEFORE
    // the reconnect loop fires. `_suspendProxy` clears `_proxyUrl` synchronously
    // at its start (before the first await), so by the time `reconnect()` calls
    // `discoverAndConnect` → `connectToTarget` → `ctx.getProxyUrl()`, the URL
    // is already null and reconnect goes direct. Fire-and-forget is fine — the
    // multiplexer's HTTP server shutdown is bounded and doesn't gate reconnect.
    if (this._proxyUrl) {
      void this._suspendProxy();
    }
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
      // B132: after the exponential-backoff reconnect loop succeeds, rehydrate
      // the proxy if one was desired. This is the "auto-resume" half of the
      // suspend→reconnect→resume sequence. softReconnect has its own wrapper
      // and does NOT go through this hook — would double-fire the resume.
      afterReconnect: () => this._resumeProxy(),
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
      getProxyUrl: () => this._proxyUrl,
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
