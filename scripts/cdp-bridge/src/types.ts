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
}

export interface FastRunnerState {
  port: number;
  pid: number;
  deviceId: string;
  bundleId: string;
  startedAt: string;
}
