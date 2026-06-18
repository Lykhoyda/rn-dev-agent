import { parseMaestroFailure } from './maestro-error-parser.js';
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
