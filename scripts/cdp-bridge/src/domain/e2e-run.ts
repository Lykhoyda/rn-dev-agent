import { parseMaestroFailure } from './maestro-error-parser.js';

export type E2eVerdict = 'green' | 'red' | 'setup_error';
export type E2eResultClassification = 'pass' | 'regression' | 'infra' | 'skipped';

export interface E2eFlowResult {
  testId: string;
  intent: string;
  passed: boolean;
  durationMs: number;
  classification: E2eResultClassification;
  failureKind?: string;
  infraAnnotation?: string | null;
  errorExcerpt?: string | null;
}

export interface E2eRunRecord {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  gitSha: string | null;
  gitDirty: boolean;
  platform: string;
  deviceId: string | null;
  metroReloaded: boolean;
  totals: { total: number; passed: number; failed: number; skipped: number };
  verdict: E2eVerdict;
  results: E2eFlowResult[];
  previousGreenRunId: string | null;
}

export function classifyFlowResult(input: {
  testId: string;
  intent: string;
  passed: boolean;
  durationMs: number;
  output: string;
}): E2eFlowResult {
  if (input.passed) {
    return {
      testId: input.testId,
      intent: input.intent,
      passed: true,
      durationMs: input.durationMs,
      classification: 'pass',
    };
  }
  const failure = parseMaestroFailure(input.output);
  const isRegression = failure.kind === 'SELECTOR_NOT_FOUND' || failure.kind === 'ASSERTION_FAILED';
  return {
    testId: input.testId,
    intent: input.intent,
    passed: false,
    durationMs: input.durationMs,
    classification: isRegression ? 'regression' : 'infra',
    failureKind: failure.kind,
    infraAnnotation: failure.kind === 'TIMEOUT' ? 'likely-infrastructure (timeout)' : null,
    errorExcerpt: input.output.slice(0, 500),
  };
}

export function skippedResult(testId: string, intent: string, reason: string): E2eFlowResult {
  return {
    testId,
    intent,
    passed: false,
    durationMs: 0,
    classification: 'skipped',
    infraAnnotation: reason,
  };
}

export function computeVerdict(
  results: Array<{ passed: boolean; classification: E2eResultClassification }>,
): E2eVerdict {
  return results.some((r) => !r.passed && r.classification !== 'skipped') ? 'red' : 'green';
}

export function diffNewlyFailing(
  current: { results: Array<{ testId: string; passed: boolean; classification: E2eResultClassification }> },
  previousGreen: { results: Array<{ testId: string; passed: boolean }> } | null,
): string[] {
  const wasPassing = new Set(
    (previousGreen?.results ?? []).filter((r) => r.passed).map((r) => r.testId),
  );
  return current.results
    .filter(
      (r) =>
        !r.passed &&
        r.classification !== 'skipped' &&
        (previousGreen === null || wasPassing.has(r.testId)),
    )
    .map((r) => r.testId);
}
