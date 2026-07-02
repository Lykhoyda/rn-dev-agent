// Same rollout shape as the keyboard guard (runners/keyboard-guard.ts):
// default ON, opt out with RN_QUIESCENCE_BYPASS=0|false. Unlike the guard
// this is resolved once at runner SPAWN, not per command — the swizzle
// decision is process-wide inside the XCUITest runner.
export function resolveQuiescenceBypass(env) {
    const raw = (env.RN_QUIESCENCE_BYPASS ?? '').trim().toLowerCase();
    return !(raw === '0' || raw === 'false');
}
// xcodebuild only forwards TEST_RUNNER_-prefixed env vars to the XCUITest
// process (prefix stripped) — same lesson as buildRunnerVersionEnv (GH #383).
// The plain form covers any direct launch path.
export function buildRunnerQuiescenceEnv(env) {
    const value = resolveQuiescenceBypass(env) ? '1' : '0';
    return {
        RN_QUIESCENCE_BYPASS: value,
        TEST_RUNNER_RN_QUIESCENCE_BYPASS: value,
    };
}
