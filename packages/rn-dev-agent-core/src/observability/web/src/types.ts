// GH #438: wire shapes are single-sourced from the server's wire-types module
// (pure types, zero Node imports — safe to reference from the browser build).
// Drift between server and UI is now a compile error caught by `npm run
// typecheck`, not a silent `as`-cast mismatch.
import type { ActionRunResult, E2eFlowResult } from '../../wire-types';

export type {
  AgentEventFamily as Family,
  AgentEvent,
  E2eVerdict,
  E2eResultClassification,
  E2eFlowResult,
  E2eRunRecord as E2eRunDetail,
  E2eRunIndexEntry,
  ActionSummary,
  ActionRunResult,
} from '../../wire-types';

// ── UI-only shapes (no server twin) ──────────────────────────────────

export type Conn = 'connecting' | 'open' | 'error';

export interface ActionRunState {
  running: boolean;
  result?: ActionRunResult;
}

export interface E2eProgress {
  completed: number;
  total: number;
  lastTestId: string;
}

/** Client-side parse of POST /api/e2e/run — the run-e2e-suite tool envelope. */
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

export interface MirrorState {
  status: 'starting' | 'streaming' | 'error' | 'idle';
  pipeline?: string;
  fps?: number;
  hint?: string;
  reason?: string;
}
