export interface NetworkEntry {
  id: string;
  method: string;
  url: string;
  timestamp: string;
  status?: number;
  duration_ms?: number;
  size?: number;
}

export interface ConsoleEntry {
  level: string;
  text: string;
  timestamp: string;
}

export interface ErrorEntry {
  message: string;
  stack?: string;
  isFatal?: boolean;
  type?: string;
  timestamp: string;
}

export interface CDPTarget {
  id: string;
  title: string;
  type: string;
  vm?: string;
  webSocketDebuggerUrl: string;
}

export interface CDPResponse {
  id: number;
  result?: {
    result?: { type: string; value?: unknown; description?: string };
    exceptionDetails?: { text: string; exception?: { description: string } };
  };
  error?: { message: string };
  method?: string;
  params?: Record<string, unknown>;
}

export interface StatusResult {
  metro: { running: boolean; port: number };
  cdp: { connected: boolean; device?: string; pageId?: string };
  app: {
    platform?: string;
    dev?: boolean;
    hermes?: boolean;
    rnVersion?: string;
    dimensions?: { width: number; height: number };
    hasRedBox: boolean;
    isPaused: boolean;
    errorCount: number;
  };
  capabilities: {
    networkDomain: boolean;
    fiberTree: boolean;
    networkFallback: boolean;
  };
}
