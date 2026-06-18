import { join } from 'node:path';
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { parseMaestroFailure } from './maestro-error-parser.js';
import { assertValidActionId } from './path-safety.js';

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

export interface E2eRunIndexEntry {
  runId: string;
  finishedAt: string;
  verdict: E2eVerdict;
  totals: { total: number; passed: number; failed: number; skipped: number };
}

const INDEX_MAX = 100;

export function e2eRunsDirFor(projectRoot: string): string {
  return join(projectRoot, '.rn-agent', 'state', 'e2e-runs');
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function loadIndex(projectRoot: string): E2eRunIndexEntry[] {
  const file = join(e2eRunsDirFor(projectRoot), 'index.json');
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeRunRecord(projectRoot: string, rec: E2eRunRecord): void {
  assertValidActionId(rec.runId, 'writeRunRecord');
  const dir = e2eRunsDirFor(projectRoot);
  writeJsonAtomic(join(dir, `${rec.runId}.json`), rec);
  const entry: E2eRunIndexEntry = {
    runId: rec.runId,
    finishedAt: rec.finishedAt,
    verdict: rec.verdict,
    totals: rec.totals,
  };
  const next = [entry, ...loadIndex(projectRoot).filter((e) => e.runId !== rec.runId)].slice(0, INDEX_MAX);
  writeJsonAtomic(join(dir, 'index.json'), next);
}

export function loadRunRecord(projectRoot: string, runId: string): E2eRunRecord | null {
  assertValidActionId(runId, 'loadRunRecord');
  const file = join(e2eRunsDirFor(projectRoot), `${runId}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as E2eRunRecord;
  } catch {
    return null;
  }
}

export function lastGreenRunId(projectRoot: string): string | null {
  return loadIndex(projectRoot).find((e) => e.verdict === 'green')?.runId ?? null;
}
