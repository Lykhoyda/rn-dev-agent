// src/domain/tap-latency.ts
// GH #263: detect a wedged simulator test-runtime from maestro-runner output.
// Pure, no I/O. Fail-open: unparseable output yields no samples → no hint.
export const DEFAULT_FLOOR_MS = 1500;
/**
 * Extract latencies (ms) of SUCCESSFUL tapOn steps from maestro-runner output.
 * maestro-runner prints each step as `  ✓ tapOn: id="x" (2.8s)` (seconds, in
 * parens at end). Only ✓ lines count: a ✗ line's duration is the step TIMEOUT
 * (~12.7s), which would false-positive an ordinary element-not-found failure.
 */
export function parseTapLatencies(output) {
    const out = [];
    for (const raw of output.split('\n')) {
        const line = raw.trim();
        if (!line.startsWith('✓'))
            continue; // successful steps only
        if (!/\btapOn\b/.test(line))
            continue; // tap steps only
        const m = line.match(/\(([\d.]+)s\)\s*$/); // trailing (N.Ns)
        if (!m)
            continue;
        const seconds = Number(m[1]);
        if (Number.isFinite(seconds))
            out.push(Math.round(seconds * 1000));
    }
    return out;
}
export function median(samples) {
    if (samples.length === 0)
        return null;
    const s = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}
export function resolveFloorMs(envVal) {
    if (envVal === undefined)
        return DEFAULT_FLOOR_MS;
    const n = Number(envVal);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_FLOOR_MS;
}
export function classifyRuntimeDegradation(output, floorMs) {
    const samples = parseTapLatencies(output);
    const medianMs = median(samples);
    return {
        degraded: medianMs != null && medianMs >= floorMs,
        medianMs,
        floorMs,
        sampleCount: samples.length,
    };
}
export function formatRuntimeDegradedHint(d) {
    return `RUNTIME_DEGRADED: median tapOn latency ${d.medianMs}ms (>= ${d.floorMs}ms) — `
        + `the simulator test runtime is likely wedged; reboot it `
        + `(xcrun simctl shutdown <udid> && xcrun simctl boot <udid>), relaunch the app, and retry.`;
}
/**
 * Integration helper: given the runner output and an already-built failure
 * (message + meta), append the RUNTIME_DEGRADED hint + meta.runtimeDegraded
 * IFF degraded. Returns the base unchanged otherwise. Call ONLY on a failure
 * path — never on a passing flow (a passing-but-slow run must not be hinted).
 */
export function augmentFailureWithDegradation(output, floorMs, baseMessage, baseMeta) {
    const d = classifyRuntimeDegradation(output, floorMs);
    if (!d.degraded)
        return { message: baseMessage, meta: baseMeta };
    return {
        message: `${baseMessage} — ${formatRuntimeDegradedHint(d)}`,
        meta: { ...baseMeta, runtimeDegraded: { medianTapMs: d.medianMs, floorMs: d.floorMs, sampleCount: d.sampleCount } },
    };
}
