export type RowOutcome = 'pass' | 'fail' | 'retry';

export interface LedgerRow {
  block: string;
  line: number;
  text: string;
  attempt: number;
  kind: 'step' | 'check';
  resolvedBy: 'exact';
  ref?: string;
  screenshot?: string;
  t: number;
  outcome: RowOutcome;
  reason?: string;
}

export interface LedgerFailure {
  step: number;
  seen: string;
  screenshot?: string;
}

export interface BlockResult {
  key: string;
  outcome: 'pass' | 'fail';
  source: 'discovered';
}

export interface Ledger {
  verdict: 'PASS' | 'FAIL';
  path: 'walk';
  blocks: BlockResult[];
  steps: LedgerRow[];
  jev: { calls: number; medianMs: number };
  llmTurns: number;
  escapes: number;
  recoveries: number;
  failure?: LedgerFailure;
}

// The verdict never contradicts the rows: a failed row or block without a failure detail synthesizes one.
export function buildLedger(
  blocks: BlockResult[],
  steps: LedgerRow[],
  failure?: LedgerFailure,
): Ledger {
  const failedRow = [...steps].reverse().find((r) => r.outcome === 'fail');
  const failedBlock = blocks.find((b) => b.outcome === 'fail');
  if (!failure && (failedRow || failedBlock)) {
    failure = {
      step: failedRow?.line ?? 0,
      seen: failedRow?.reason ?? `block ${failedBlock?.key ?? ''} failed`,
      ...(failedRow?.screenshot ? { screenshot: failedRow.screenshot } : {}),
    };
  }
  const ledger: Ledger = {
    verdict: failure ? 'FAIL' : 'PASS',
    path: 'walk',
    blocks,
    steps,
    jev: { calls: 0, medianMs: 0 },
    llmTurns: 0,
    escapes: 0,
    recoveries: 0,
  };
  if (failure) ledger.failure = failure;
  return ledger;
}

// A walk that ended without a verdict is a FAIL attributed to its last row.
export function ledgerWithoutResult(steps: LedgerRow[], seen: string): Ledger {
  const last = steps[steps.length - 1];
  return buildLedger([], steps, {
    step: last?.line ?? 0,
    seen,
    ...(last?.screenshot ? { screenshot: last.screenshot } : {}),
  });
}

export function screenshotName(index: number, line: number): string {
  return `screenshots/${String(index).padStart(2, '0')}-line${line}.png`;
}
