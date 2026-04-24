// B59: tiered dispatch between maestro-runner (preferred, 3× faster) and the
// upstream Maestro CLI (slower JVM-based fallback). The reason both paths
// exist: maestro-runner v1.0.9 has an upstream bug — it requires `adb` in
// PATH even when `--platform ios` is specified. On iOS-only dev machines
// (no Android SDK installed) every maestro-runner invocation fails. The
// fallback to `maestro` CLI keeps iOS-only users productive while we wait
// for the upstream fix.
//
// Decision tree:
//   1. platform === 'android' OR adb in PATH → maestro-runner (fast path)
//   2. platform === 'ios' AND adb missing AND `maestro` in PATH → Maestro CLI
//   3. neither viable → fail with a short install hint listing both options
//
// Same shape pattern as agent-device's 3-tier dispatch (fast-runner →
// daemon → CLI) — keeps the codebase architecturally consistent.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
// Process-wide cache. PATH doesn't change mid-process under normal use,
// so probing `which` once per binary is enough. Tests pass injected
// resolvers, which bypass the cache (each call computes fresh).
const cache = {};
function defaultWhichAdb() {
    if (cache.adb !== undefined)
        return cache.adb;
    const r = spawnSync('which', ['adb'], { encoding: 'utf8' });
    cache.adb = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    return cache.adb;
}
function defaultWhichMaestro() {
    if (cache.maestro !== undefined)
        return cache.maestro;
    const r = spawnSync('which', ['maestro'], { encoding: 'utf8' });
    cache.maestro = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    return cache.maestro;
}
function defaultMaestroRunnerPath() {
    const path = join(homedir(), '.maestro-runner', 'bin', 'maestro-runner');
    return existsSync(path) ? path : null;
}
/**
 * Test-only: clear the cached `which` results. Production code never calls
 * this; tests reset between cases to avoid leakage.
 */
export function _resetMaestroDispatchCache() {
    delete cache.adb;
    delete cache.maestro;
    warnedFallbackReasons.clear();
}
// Per-process set of fallback reasons we've already surfaced to the user.
// Used by shouldWarnFallback() so a session running 100 flows via the
// fallback doesn't get 100 identical warnings — the first one is enough,
// subsequent successes carry the reason silently in meta. Failures still
// surface the reason because the user is already paying attention.
const warnedFallbackReasons = new Set();
/**
 * Returns true on the FIRST call for a given reason in this process,
 * false on subsequent calls. Callers use this to decide whether to wrap
 * an otherwise-successful result in warnResult() (loud) or okResult()
 * with the reason in meta (quiet). Failures should warn unconditionally.
 */
export function shouldWarnFallback(reason) {
    if (warnedFallbackReasons.has(reason))
        return false;
    warnedFallbackReasons.add(reason);
    return true;
}
export function chooseMaestroDispatch(inputs) {
    const whichAdb = inputs.whichAdb ?? defaultWhichAdb;
    const whichMaestro = inputs.whichMaestro ?? defaultWhichMaestro;
    const runnerPath = (inputs.maestroRunnerPath ?? defaultMaestroRunnerPath)();
    // Tier 1: maestro-runner. Viable when (a) the binary is installed and
    // (b) we're on android OR adb is reachable (so the upstream bug doesn't bite).
    const runnerViable = runnerPath !== null && (inputs.platform === 'android' || whichAdb() !== null);
    if (runnerViable && runnerPath) {
        return {
            runner: 'maestro-runner',
            binPath: runnerPath,
            buildArgs: (platform, flowFile) => ['--platform', platform, 'test', flowFile],
        };
    }
    // Tier 2: Maestro CLI fallback. Slower JVM cold start (~2s) but works on
    // iOS-only machines. Use when maestro-runner can't run AND `maestro` is
    // installed.
    const maestroPath = whichMaestro();
    if (maestroPath) {
        const reason = runnerPath === null
            ? 'maestro-runner not installed'
            : 'maestro-runner v1.0.9 requires adb in PATH (upstream bug — see B59); falling back to Maestro CLI';
        return {
            runner: 'maestro',
            binPath: maestroPath,
            // Maestro CLI: `maestro test --platform <platform> <flow.yaml>`. The
            // `--platform`/`-p` selector is the only platform flag v2.x exposes
            // (per `maestro test --help`: [-p=<platform>]). Both reviewers
            // (Gemini conf 97, Codex conf 98) caught the earlier draft using a
            // non-existent --device-type flag — would have silently broken the
            // entire B59 fallback on its target machines.
            buildArgs: (platform, flowFile) => ['test', '--platform', platform, flowFile],
            fallbackReason: reason,
        };
    }
    // Tier 3: nothing usable. Fail-fast with both install instructions —
    // far better than letting maestro-runner timeout opaquely.
    return {
        error: 'Neither maestro-runner nor maestro CLI is usable. ' +
            (runnerPath === null ? 'maestro-runner not installed. ' : '') +
            (inputs.platform === 'ios' && whichAdb() === null
                ? 'maestro-runner v1.0.9 needs adb in PATH (upstream B59) but adb is not installed. '
                : '') +
            'Install Maestro CLI (`brew install maestro`) for iOS-only setups, ' +
            'or install Android SDK (`brew install android-platform-tools`) plus ' +
            '`curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash` ' +
            'for the faster maestro-runner path.',
        hint: inputs.platform === 'ios'
            ? 'iOS-only quickstart: brew install maestro'
            : 'install Android SDK + maestro-runner for fastest path',
    };
}
