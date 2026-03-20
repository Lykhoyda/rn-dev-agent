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
}

export interface ErrorEntry {
  message: string;
  stack?: string;
  isFatal?: boolean;
  type?: string;
  timestamp: string;
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
}

export interface EvaluateResult {
  value?: unknown;
  error?: string;
}

export interface ResultEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  truncated?: boolean;
  meta?: Record<string, unknown>;
}

export interface SessionState {
  name: string;
  platform?: string;
  openedAt: string;
}
