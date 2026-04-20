export interface CDPMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface HermesTarget {
  id: string;
  title: string;
  vm: string;
  webSocketDebuggerUrl: string;
  description?: string;
  type?: string;
  platform?: 'ios' | 'android';
  /**
   * Metro /json/list includes this field for RN 0.76+. It disambiguates
   * iOS vs Android when the same bundleId is installed on both (B131/D660).
   */
  deviceName?: string;
  /**
   * B116 (D639): set true when the bundleId is installed on BOTH iOS sim AND
   * Android emulator and neither inference source could disambiguate. Callers
   * should pass `targetId` or `bundleId + platform` for exact selection.
   */
  ambiguousPlatform?: boolean;
}

export interface ConsoleEntry {
  level: string;
  text: string;
  timestamp: string;
}

export interface NetworkEntry {
  id: string;
  method: string;
  url: string;
  timestamp: string;
  status?: number;
  duration_ms?: number;
  bodyAvailable?: boolean;
  bodySize?: number;
}

export interface ErrorEntry {
  message: string;
  stack?: string;
  isFatal?: boolean;
  type?: string;
  timestamp: string;
}

export interface LogEntry {
  source: string;
  level: string;
  text: string;
  timestamp: string;
  url?: string;
  lineNumber?: number;
}

export type CDPClientState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface StatusResult {
  metro: {
    running: boolean;
    port: number | null;
    /** M5 (D656): true when the MetroEventsClient has an open WS to Metro's /events endpoint. */
    eventsConnected?: boolean;
    /** M5 (D656): most recent bundle build status + timestamp (null if no events seen yet). */
    lastBuild?: { status: 'started' | 'done' | 'failed'; timestamp: string } | null;
    /** M5 (D656): count of bundle_build_failed events observed since MCP connected. */
    buildErrors?: number;
    /**
     * B129 (D658): reason the events stream is unusable on this Metro, if any.
     * `"expo-cli-incompatible"` means Expo CLI is serving the manifest
     * protocol at /events instead of Metro's reporter stream. When present,
     * `eventsConnected` will be false and no events will ever arrive.
     */
    eventsReason?: 'expo-cli-incompatible' | null;
  };
  cdp: {
    connected: boolean;
    device: string | null;
    pageId: string | null;
    platform: string | null;
    /** B111 (D643): target.description (bundleId from Metro) — surfaces which app the MCP attached to. */
    bundleId: string | null;
  };
  app: {
    platform: string | null;
    dev: boolean | null;
    hermes: boolean | null;
    rnVersion: string | null;
    dimensions: { width: number; height: number } | null;
    hasRedBox: boolean;
    isPaused: boolean;
    errorCount: number;
  };
  capabilities: {
    networkDomain: boolean;
    fiberTree: boolean;
    networkFallback: boolean;
    bridgeDetected: boolean;
    bridgeVersion: number | null;
    /** M1 (D654): true when RN >= 0.85 supports native multi-debugger (DevTools + MCP can coexist without proxy). */
    supportsMultipleDebuggers: boolean;
  };
  domains: {
    runtime: boolean;
    debugger: boolean;
    network: boolean;
    log: boolean;
    profiler: boolean;
    heapProfiler: boolean;
  };
  reconnect: {
    active: boolean;
    lastAttempt: string | null;
    attemptCount: number;
  };
}

export interface EvaluateResult {
  value?: unknown;
  error?: string;
}

export type ToolErrorCode =
  | 'STALE_TARGET'
  | 'HELPERS_STALE'
  | 'RECONNECT_TIMEOUT'
  | 'NOT_CONNECTED'
  | 'HELPERS_NOT_INJECTED';

export interface ResultEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: ToolErrorCode;
  truncated?: boolean;
  meta?: Record<string, unknown>;
}

export interface SessionState {
  name: string;
  platform?: string;
  deviceId?: string;
  openedAt: string;
  /**
   * B35: bundleId saved at session-open time. Used by runner-leak-recovery to
   * close+reopen the session when the agent-device daemon misroutes commands
   * to AgentDeviceRunner instead of the target app on iOS.
   */
  appId?: string;
}

export interface FastRunnerState {
  port: number;
  pid: number;
  deviceId: string;
  bundleId: string;
  startedAt: string;
}
