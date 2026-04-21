import { RingBuffer, DeviceBufferManager, makeDeviceKey } from '../../dist/ring-buffer.js';

/**
 * Creates a mock CDPClient that satisfies the interface used by tool handlers
 * and the withConnection middleware. Override any property/method via `overrides`.
 *
 * @param {Record<string, unknown>} overrides
 * @returns {import('../../dist/cdp-client.js').CDPClient}
 */
export function createMockClient(overrides = {}) {
  const consoleBuffer = new RingBuffer(200);
  const networkBufferManager = new DeviceBufferManager({
    capacityPerDevice: 100,
    maxDevices: 10,
    indexKey: (e) => e.id,
    timestampOf: (e) => new Date(e.timestamp).getTime(),
  });
  const logBuffer = new RingBuffer(50);

  const client = {
    // --- State getters ---
    get isConnected() { return client._isConnected; },
    get helpersInjected() { return client._helpersInjected; },
    get isPaused() { return client._isPaused; },
    get state() { return client._isConnected ? 'connected' : 'disconnected'; },
    get metroPort() { return client._metroPort; },
    get connectedTarget() { return client._connectedTarget; },
    get networkMode() { return client._networkMode; },
    get bridgeDetected() { return client._bridgeDetected; },
    get bridgeVersion() { return client._bridgeVersion; },
    get logDomainEnabled() { return client._logDomainEnabled; },
    get profilerAvailable() { return client._profilerAvailable; },
    get heapProfilerAvailable() { return client._heapProfilerAvailable; },
    get scripts() { return client._scripts; },
    get connectionGeneration() { return client._connectionGeneration; },
    get consoleBuffer() { return consoleBuffer; },
    get networkBufferManager() { return networkBufferManager; },
    get activeDeviceKey() { return makeDeviceKey(client._metroPort, client._connectedTarget?.id); },
    /** M5: mock client defaults to null; tests can override with a stub. */
    get metroEventsClient() { return client._metroEventsClient; },
    get logBuffer() { return logBuffer; },
    get reconnectState() {
      return { active: false, lastAttempt: null, attemptCount: 0 };
    },
    /** M1b: proxy getters — default "no proxy active", override via _proxyUrl/_proxyMultiplexer. */
    get proxyUrl() { return client._proxyUrl; },
    get isProxyActive() { return client._proxyUrl !== null; },
    get proxyMultiplexer() { return client._proxyMultiplexer; },
    /** M11: connection timestamp + injectable clock. Override _connectedAt / _timeNowFn. */
    get connectedAt() { return client._connectedAt; },
    get now() { return client._timeNowFn; },

    // --- Mutable state (set in overrides or mutated in tests) ---
    _isConnected: true,
    _helpersInjected: true,
    _isPaused: false,
    _metroPort: 8081,
    _connectedTarget: {
      id: 'page1',
      title: 'React Native (Hermes)',
      vm: 'Hermes',
      webSocketDebuggerUrl: 'ws://127.0.0.1:8081/debugger/page1',
      platform: 'ios',
    },
    _networkMode: 'cdp',
    _metroEventsClient: null,
    _proxyUrl: null,
    _proxyMultiplexer: null,
    _bridgeDetected: false,
    _bridgeVersion: null,
    _logDomainEnabled: true,
    _profilerAvailable: true,
    _heapProfilerAvailable: true,
    _scripts: new Map(),
    _connectionGeneration: 1,
    // M11 defaults: connectedAt=1_000_000 and timeNowFn returning 1_000_000
    // means "just connected, 0ms elapsed" — hint should NOT fire by default.
    // Tests that want the hint to fire override _timeNowFn to a later value.
    _connectedAt: 1_000_000,
    _timeNowFn: () => 1_000_000,

    // D502 freshness probe needs this — withConnection checks `typeof globalThis.__RN_AGENT`
    // and expects a number. Returning 13 (helpers version) satisfies the probe so tests
    // exercise the normal happy path, not the stale-helper re-injection recovery path.
    eventHandlers: new Map(),

    // --- Methods ---
    async evaluate(_expr, _awaitPromise) {
      return { value: 13 };
    },

    async autoConnect(_port, _platform) {
      client._isConnected = true;
      client._helpersInjected = true;
      return 'connected';
    },

    async disconnect() {
      client._isConnected = false;
      client._helpersInjected = false;
    },

    async softReconnect() {
      client._isConnected = true;
      client._helpersInjected = true;
    },

    async startProxy() {
      // Mock mirrors real behavior: idempotent, sets URL + multiplexer-like stub,
      // returns URL. Tests that want failure override this.
      if (client._proxyUrl) return client._proxyUrl;
      client._proxyUrl = 'ws://127.0.0.1:45678';
      client._proxyMultiplexer = { port: 45678, isRunning: true, consumerCount: 0 };
      return client._proxyUrl;
    },

    async stopProxy() {
      client._proxyUrl = null;
      client._proxyMultiplexer = null;
    },

    async reinjectHelpers() {
      client._helpersInjected = true;
      return true;
    },

    async send(_method, _params) {
      return {};
    },

    helperExpr(call) {
      return client._bridgeDetected
        ? `__RN_DEV_BRIDGE__.${call}`
        : `__RN_AGENT.${call}`;
    },

    bridgeWithFallback(call) {
      return client._bridgeDetected
        ? `(function() { var fb = false; try { var r = __RN_DEV_BRIDGE__.${call}; var p = JSON.parse(r); if (p && (p.__agent_error || p.error)) fb = true; else return r; } catch(e) { fb = true; } if (fb) return __RN_AGENT.${call}; })()`
        : `__RN_AGENT.${call}`;
    },

    // --- Apply overrides ---
    ...overrides,
  };

  return client;
}
