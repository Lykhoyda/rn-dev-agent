import { join } from 'node:path';
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { parseMaestroFailure } from './maestro-error-parser.js';
import { assertValidActionId } from './path-safety.js';
import { sessionStateDirectory } from '../session/runtime-paths.js';
export function classifyFlowResult(input) {
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
export function skippedResult(testId, intent, reason) {
    return {
        testId,
        intent,
        passed: false,
        durationMs: 0,
        classification: 'skipped',
        infraAnnotation: reason,
    };
}
export function unloadableResult(testId, reason) {
    return {
        testId,
        intent: testId,
        passed: false,
        durationMs: 0,
        classification: 'infra',
        failureKind: 'UNLOADABLE',
        infraAnnotation: reason,
        errorExcerpt: null,
    };
}
export function computeVerdict(results) {
    return results.some((r) => !r.passed && r.classification !== 'skipped') ? 'red' : 'green';
}
export function diffNewlyFailing(current, previousGreen) {
    const wasPassing = new Set((previousGreen?.results ?? []).filter((r) => r.passed).map((r) => r.testId));
    return current.results
        .filter((r) => !r.passed &&
        r.classification !== 'skipped' &&
        (previousGreen === null || wasPassing.has(r.testId)))
        .map((r) => r.testId);
}
const INDEX_MAX = 100;
export function e2eRunsDirFor(projectRoot) {
    return join(sessionStateDirectory(projectRoot), 'e2e-runs');
}
function writeJsonAtomic(file, value) {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmp, file);
}
export function loadIndex(projectRoot) {
    const file = join(e2eRunsDirFor(projectRoot), 'index.json');
    if (!existsSync(file))
        return [];
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
export function writeRunRecord(projectRoot, rec) {
    assertValidActionId(rec.runId, 'writeRunRecord');
    const dir = e2eRunsDirFor(projectRoot);
    writeJsonAtomic(join(dir, `${rec.runId}.json`), rec);
    const entry = {
        runId: rec.runId,
        finishedAt: rec.finishedAt,
        verdict: rec.verdict,
        totals: rec.totals,
    };
    const next = [entry, ...loadIndex(projectRoot).filter((e) => e.runId !== rec.runId)].slice(0, INDEX_MAX);
    writeJsonAtomic(join(dir, 'index.json'), next);
}
export function loadRunRecord(projectRoot, runId) {
    assertValidActionId(runId, 'loadRunRecord');
    const file = join(e2eRunsDirFor(projectRoot), `${runId}.json`);
    if (!existsSync(file))
        return null;
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}
export function lastGreenRunId(projectRoot) {
    return loadIndex(projectRoot).find((e) => e.verdict === 'green')?.runId ?? null;
}
