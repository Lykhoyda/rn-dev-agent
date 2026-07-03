export type Family =
  | 'interaction'
  | 'introspection'
  | 'navigation'
  | 'lifecycle'
  | 'testing'
  | 'other';

export interface AgentEvent {
  seq: number;
  ts: number;
  tool: string;
  family: Family;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs?: number;
  error?: { message: string; code?: string };
  ghost?: { attempted: boolean; outcome: string };
  summary: string;
  payload?: unknown;
  truncated?: boolean;
}

export type Conn = 'connecting' | 'open' | 'error';

export interface ActionSummary {
  id: string;
  intent: string;
  status: string;
  params?: string[];
  mutates?: boolean;
  appId?: string;
}

export interface ActionRunResult {
  ok: boolean;
  output?: string;
  error?: string;
  missingParams?: string[];
}

export interface ActionRunState {
  running: boolean;
  result?: ActionRunResult;
}

export interface E2eProgress {
  completed: number;
  total: number;
  lastTestId: string;
}

export interface E2eFlowResult {
  testId: string;
  intent?: string;
  passed: boolean;
  durationMs?: number;
  classification: string;
  errorExcerpt?: string | null;
}

export interface E2eRunResult {
  ok?: boolean;
  data?: {
    runId?: string | null;
    verdict?: string | null;
    totals?: { total: number; passed: number; failed: number; skipped: number };
    results?: E2eFlowResult[];
    newlyFailing?: string[];
  };
}

export interface E2eRunIndexEntry {
  runId: string;
  finishedAt: string;
  verdict: string;
  totals: { total: number; passed: number; failed: number; skipped: number };
}

/** Shape of GET /api/e2e/runs/:id — the bridge's E2eRunRecord. */
export interface E2eRunDetail {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  platform: string;
  verdict: string;
  totals: { total: number; passed: number; failed: number; skipped: number };
  results: E2eFlowResult[];
}
