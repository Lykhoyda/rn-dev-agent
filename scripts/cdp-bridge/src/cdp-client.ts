import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { RingBuffer } from './ring-buffer.js';
import { INJECTED_HELPERS, NETWORK_HOOK_SCRIPT } from './injected-helpers.js';
import { detectBridge } from './bridge-detector.js';
import { logger } from './logger.js';
import { resetState, setActiveFlag, clearActiveFlag, sleep } from './cdp/state.js';
import type { CDPResettableState } from './cdp/state.js';
import { CDP_TIMEOUT_FAST, CDP_TIMEOUT_MS, CDP_TIMEOUT_SLOW, timeoutForMethod } from './cdp/timeout-config.js';
import { sendWithTimeout as sendMsg, rejectAllPending as rejectPending, handleMessage as handleMsg } from './cdp/transport.js';
import { wireEventHandlers, parseNetworkHookMessage as parseNetHook } from './cdp/event-handlers.js';
import type {
  PendingCall,
  HermesTarget,
  ConsoleEntry,
  NetworkEntry,
  LogEntry,
  CDPClientState,
  EvaluateResult,
} from './types.js';
const REACT_READY_TIMEOUT_MS = 30000;
const REACT_READY_POLL_MS = 500;
const RECONNECT_DELAY_MS = 1500;
const RECONNECT_ATTEMPTS = 30;
const RECONNECT_RETRY_MS = 1500;
const DISCOVERY_TIMEOUT_MS = 1500;
const USER_METRO_PORT = process.env.RN_METRO_PORT ? parseInt(process.env.RN_METRO_PORT, 10) : null;
const DEFAULT_PORTS = [
  ...(USER_METRO_PORT && !isNaN(USER_METRO_PORT) ? [USER_METRO_PORT] : []),
  8081, 8082, 19000, 19006,
];

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
    await this.waitForReact(waitTimeout ?? REACT_READY_TIMEOUT_MS);
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
    setActiveFlag(this._port, this._connectedTarget);
    detectBridge(this).then((r) => { this._bridgeDetected = r.present; this._bridgeVersion = r.version; }).catch(() => {});
    return true;
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

  private inferPlatforms(targets: HermesTarget[]): void {
    let androidPackages: Set<string> | null = null;
    try {
      const out = execFileSync('adb', ['shell', 'pm', 'list', 'packages'], {
        timeout: 3000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      androidPackages = new Set(
        out.split('\n')
          .map(line => line.replace('package:', '').trim())
          .filter(Boolean),
      );
    } catch {
      // adb not available or no device — all targets treated as iOS
    }

    for (const t of targets) {
      if (androidPackages?.has(t.description ?? '')) {
        t.platform = 'android';
      } else {
        t.platform = 'ios';
      }
    }
  }

  async listTargets(portHint?: number): Promise<{ port: number; targets: HermesTarget[] }> {
    const ports = [...new Set([portHint ?? this._port, ...DEFAULT_PORTS])];
    let metroPort: number | null = null;

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
      } catch {
        // Port not available
      } finally {
        clearTimeout(timer);
      }
    }

    if (!metroPort) {
      throw new Error('Metro not found on ports ' + ports.join(', '));
    }

    const listCtrl = new AbortController();
    const listTimer = setTimeout(() => listCtrl.abort(), DISCOVERY_TIMEOUT_MS * 2);
    let raw: HermesTarget[];
    try {
      const resp = await fetch(`http://127.0.0.1:${metroPort}/json/list`, { signal: listCtrl.signal });
      raw = (await resp.json()) as HermesTarget[];
    } catch (err) {
      throw new Error(`Failed to list CDP targets on port ${metroPort}: ${err instanceof Error ? err.message : err}`);
    } finally {
      clearTimeout(listTimer);
    }

    const targets = raw
      .filter(t => !!t.webSocketDebuggerUrl && !t.title?.includes('Experimental') &&
        (t.vm === 'Hermes' || t.title?.includes('React Native') || t.description?.includes('React Native')))
      .map(t => ({
        ...t,
        webSocketDebuggerUrl: t.webSocketDebuggerUrl
          ?.replace(/\[::1\]/g, '127.0.0.1')
          ?.replace(/\[::\]/g, '127.0.0.1'),
      }));

    this.inferPlatforms(targets);
    return { port: metroPort, targets };
  }

  private _platformFilter?: string;

  private async discoverAndConnect(portHint?: number, platformFilter?: string): Promise<string> {
    if (this.disposed) {
      throw new Error('Client is disposed. Create a new CDPClient instance.');
    }

    if (portHint) this._port = portHint;
    if (platformFilter !== undefined) this._platformFilter = platformFilter || undefined;
    this._state = 'connecting';

    const ports = [...new Set([this._port, ...DEFAULT_PORTS])];
    logger.debug('CDP', `Discovering Metro on ports: ${ports.join(', ')}${this._platformFilter ? ` (platform: ${this._platformFilter})` : ''}`);
    let metroPort: number | null = null;

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
      } catch {
        // Port not available, continue scanning
      } finally {
        clearTimeout(timer);
      }
    }

    if (!metroPort) {
      this._state = 'disconnected';
      throw new Error(
        'Metro not found on ports ' + ports.join(', ') +
        '. Is the dev server running? Try: npx expo start or npx react-native start'
      );
    }
    this._port = metroPort;
    logger.info('CDP', `Metro found on port ${metroPort}`);

    const listCtrl = new AbortController();
    const listTimer = setTimeout(() => listCtrl.abort(), DISCOVERY_TIMEOUT_MS * 2);
    let targets: HermesTarget[];
    try {
      const targetsResp = await fetch(`http://127.0.0.1:${metroPort}/json/list`, { signal: listCtrl.signal });
      targets = (await targetsResp.json()) as HermesTarget[];
    } catch (err) {
      this._state = 'disconnected';
      throw new Error(`Failed to list CDP targets on port ${metroPort}: ${err instanceof Error ? err.message : err}`);
    } finally {
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
          const { hostname } = new URL(t.webSocketDebuggerUrl!);
          return hostname === '127.0.0.1' || hostname === 'localhost';
        } catch {
          return false;
        }
      });

    if (validTargets.length === 0) {
      this._state = 'disconnected';
      throw new Error(
        'No Hermes debug target found. Is the app running? Is Hermes enabled?'
      );
    }

    // Infer platform per target via adb package list
    this.inferPlatforms(validTargets);

    // Filter by platform if specified
    let filteredTargets = validTargets;
    let platformFilterWarning: string | undefined;
    if (this._platformFilter) {
      const pf = this._platformFilter.toLowerCase();
      // Primary: match on inferred platform field
      let platformMatched = validTargets.filter(t => t.platform === pf);
      // Fallback: text search on title + description + vm
      if (platformMatched.length === 0) {
        platformMatched = validTargets.filter(t => {
          const haystack = `${t.title ?? ''} ${t.description ?? ''} ${t.vm ?? ''}`.toLowerCase();
          return haystack.includes(pf);
        });
      }
      if (platformMatched.length > 0) {
        filteredTargets = platformMatched;
      } else {
        platformFilterWarning = `Platform filter "${this._platformFilter}" matched no targets (available: ${validTargets.map(t => `${t.description || t.id} [${t.platform ?? '?'}]`).join(', ')}). Connecting to best available target.`;
        console.error('CDP: ' + platformFilterWarning);
      }
    }

    logger.debug('CDP', `Found ${filteredTargets.length} valid target(s): ${filteredTargets.map(t => `${t.id} (${t.title}, platform=${t.platform ?? '?'})`).join(', ')}`);

    // Sort by descending page ID (highest = most recent session)
    const sorted = [...filteredTargets].sort((a, b) => {
      const aPage = parseInt(a.id?.split('-')[1] ?? '0', 10);
      const bPage = parseInt(b.id?.split('-')[1] ?? '0', 10);
      return bPage - aPage;
    });

    // Try each target, verify __DEV__ is true (correct app JS context)
    let connectedTarget: HermesTarget | null = null;
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
            if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
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
      } catch (err) {
        // Connection failed — try next target if available
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
    if (this.disposed) throw new Error('Client is disposed');
    logger.info('CDP', 'softReconnect initiated');

    // Preempt any background reconnect loop — signal it to bail out
    if (this.reconnecting) {
      this._softReconnectRequested = true;
      const bailDeadline = Date.now() + 3_000;
      while (this.reconnecting && Date.now() < bailDeadline) {
        await sleep(200);
      }
      this._softReconnectRequested = false;
    }

    this.reconnecting = true;
    try {
      resetState(this as unknown as CDPResettableState);

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
    } catch (err) {
      this.reconnecting = false;
      throw err;
    }
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
    logger.debug('CDP', 'Running setup: Runtime.enable, Debugger.enable...');
    await this.sendWithTimeout('Runtime.enable', undefined, timeoutForMethod('Runtime.enable'));
    await this.sendWithTimeout('Debugger.enable', undefined, timeoutForMethod('Debugger.enable'));

    try {
      await this.sendWithTimeout('Network.enable', undefined, timeoutForMethod('Network.enable'));
      this._networkMode = 'cdp';
    } catch {
      this._networkMode = 'none';
    }

    // D588: Log.enable for pre-helper diagnostics
    try {
      await this.sendWithTimeout('Log.enable', undefined, timeoutForMethod('Log.enable'));
      this._logDomainEnabled = true;
    } catch {
      this._logDomainEnabled = false;
    }

    // Probe optional profiling domains in parallel (don't leave enabled)
    const [profilerProbe, heapProbe] = await Promise.allSettled([
      this.sendWithTimeout('Profiler.enable', undefined, CDP_TIMEOUT_FAST)
        .then(() => this.sendWithTimeout('Profiler.disable', undefined, CDP_TIMEOUT_FAST))
        .then(() => true),
      this.sendWithTimeout('HeapProfiler.enable', undefined, CDP_TIMEOUT_FAST)
        .then(() => this.sendWithTimeout('HeapProfiler.disable', undefined, CDP_TIMEOUT_FAST))
        .then(() => true),
    ]);
    this._profilerAvailable = profilerProbe.status === 'fulfilled' && profilerProbe.value === true;
    this._heapProfilerAvailable = heapProbe.status === 'fulfilled' && heapProbe.value === true;

    this.eventHandlers.clear();
    this._scripts.clear();
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
    logger.info('CDP', `Helpers injected (v11), network mode: ${this._networkMode}`);
    setActiveFlag(this._port, this._connectedTarget);
    detectBridge(this).then((r) => { this._bridgeDetected = r.present; this._bridgeVersion = r.version; logger.debug('CDP', `Bridge detection: present=${r.present}, version=${r.version}`); }).catch(() => {});

    // D626 (B1 fix): Probe whether Network.enable actually delivers events.
    // On RN < 0.83, Hermes accepts Network.enable without error but never
    // fires requestWillBeSent/responseReceived. Probe with a small fetch
    // and check if the buffer grows within 500ms.
    if (this._networkMode === 'cdp') {
      const bufSizeBefore = this._networkBuffer.size;
      await this.evaluate(`void fetch('http://localhost:${this._port}/status').catch(function(){})`);
      await new Promise(r => setTimeout(r, 500));
      if (this._networkBuffer.size <= bufSizeBefore) {
        logger.info('CDP', 'Network.enable accepted but no events fired (RN < 0.83) — falling back to hooks');
        this._networkMode = 'none';
      }
    }

    if (this._networkMode === 'none') {
      const hookResult = await this.evaluate(NETWORK_HOOK_SCRIPT);
      if (hookResult.error) {
        console.error('CDP: failed to inject network hooks:', hookResult.error);
      } else {
        await this.evaluate(`
          globalThis.__RN_AGENT_NETWORK_CB__ = function(type, data) {
            console.log('__RN_NET__:' + type + ':' + JSON.stringify(data));
          };
        `);
        this._networkMode = 'hook';
      }
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

  private async waitForReact(timeout: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const result = await this.evaluate(
          'typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== "undefined" && ' +
          '__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers?.size > 0'
        );
        if (result.value === true) return;
      } catch {
        // Not ready yet
      }
      await sleep(REACT_READY_POLL_MS);
    }
    console.error(`CDP: React not ready after ${timeout}ms — helpers will be injected anyway`);
  }

  private handleClose(code: number): void {
    resetState(this as unknown as CDPResettableState);

    if (this.disposed || this.reconnecting) return;

    logger.info('CDP', `WebSocket closed (code ${code}), starting reconnect`);
    if (code === 1006) {
      console.error('CDP: abnormal close (1006). App may have reloaded or crashed. Attempting reconnect...');
    } else {
      console.error('CDP: connection closed (code ' + code + '). Reconnecting...');
    }

    this.reconnecting = true;
    this._state = 'reconnecting';

    this.reconnect().catch((err) => {
      console.error('CDP: reconnect failed:', err instanceof Error ? err.message : err);
      this.reconnecting = false;
    });
  }

  private async reconnect(): Promise<void> {
    await sleep(RECONNECT_DELAY_MS);

    for (let i = 0; i < RECONNECT_ATTEMPTS; i++) {
      this._reconnectAttemptCount = i + 1;
      this._lastReconnectAttempt = new Date().toISOString();
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
      } catch {
        if (i < RECONNECT_ATTEMPTS - 1) {
          if (this._softReconnectRequested) {
            this.reconnecting = false;
            return;
          }
          await sleep(RECONNECT_RETRY_MS);
        }
      }
    }
    this.reconnecting = false;
    this._state = 'disconnected';
    clearActiveFlag();
    console.error('CDP: reconnect failed after ' + RECONNECT_ATTEMPTS + ' attempts. Starting background poll...');
    this.startBackgroundPoll();
  }

  private startBackgroundPoll(): void {
    if (this._bgPollTimer || this.disposed) return;
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
      } catch {
        // Metro not available yet — keep polling
      }
    }, 5000);
  }

  private stopBackgroundPoll(): void {
    if (this._bgPollTimer) {
      clearInterval(this._bgPollTimer);
      this._bgPollTimer = null;
    }
  }

  private rejectAllPending(reason: Error): void {
    rejectPending(this.pending, reason);
  }

  private sendWithTimeout(method: string, params: unknown, ms: number): Promise<unknown> {
    return sendMsg(this.ws, this.pending, () => ++this.msgId, method, params, ms);
  }

}
