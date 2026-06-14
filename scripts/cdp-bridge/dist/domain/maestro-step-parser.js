// src/domain/maestro-step-parser.ts
// GH #211: structure maestro_run results from maestro-runner stdout. Pure, no
// I/O, fail-open: unparseable output yields []. Generalizes the #263 step-line
// parser (tap-latency.ts derives parseTapLatencies from parseSteps).
import { parseMaestroFailure } from './maestro-error-parser.js';
// Strip ANSI SGR/color escape sequences. execFile output is usually un-colored
// (child stdout is a pipe, not a TTY) but maestro-runner is not guaranteed to
// honor that, and a glyph-anchored match breaks on a colored `✓`. Built via
// fromCharCode(27) (ESC) to keep a raw control char out of the source/regex.
const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
export function stripAnsi(s) {
    return s.replace(ANSI_RE, '');
}
// `  {✓|✗} <name> (N.Ns)` — the trailing (N.Ns) is REQUIRED, which excludes the
// `✗ rn-maestro-run 23.8s` summary line and the `N steps passing` count lines.
// `.*?` is non-greedy + `$`-anchored so a duration-looking token inside the
// selector value (`text="took (2.0s)"`) loses to the real trailing duration.
const STEP_RE = /^([✓✗])\s+(.*?)\s*\(([\d.]+)s\)\s*$/;
export function parseSteps(output) {
    if (!output || typeof output !== 'string')
        return [];
    const steps = [];
    let index = 0;
    for (const raw of stripAnsi(output).split('\n')) {
        const m = STEP_RE.exec(raw.trim());
        if (!m)
            continue;
        const name = m[2].trim();
        const verb = name.split(/\s+/)[0].replace(/:$/, '');
        if (verb === 'rn-maestro-run')
            continue; // belt-and-suspenders vs a future summary format
        const seconds = Number(m[3]);
        if (!Number.isFinite(seconds))
            continue;
        steps.push({
            index: index++,
            name,
            verb,
            status: m[1] === '✓' ? 'pass' : 'fail',
            durationMs: Math.round(seconds * 1000),
        });
    }
    return steps;
}
export function findFailedStep(steps) {
    for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].status === 'fail')
            return steps[i];
    }
    return null;
}
export function lastObservedStep(steps) {
    return steps.length ? steps[steps.length - 1] : null;
}
// Project parseMaestroFailure to {kind, selector}, DROPPING its `raw` field —
// every MaestroFailure variant carries `raw` = the full unsliced output, which
// must not be re-embedded into the result (it would defeat the output slice).
export function summarizeReason(output) {
    const f = parseMaestroFailure(output);
    if (f.kind === 'UNKNOWN')
        return null;
    const selector = 'selector' in f ? (f.selector ?? null) : null;
    return { kind: f.kind, selector };
}
// failedStep/reason are populated ONLY when the run's terminal verdict is fail
// (opts.failed). maestro-runner logs transient retries; a fail-then-retry-✓ on
// a PASSED run must not report a failedStep (mirrors parseMaestroFailure GH#118).
export function buildStepSummary(output, opts) {
    const steps = parseSteps(output);
    return {
        steps,
        failedStep: opts.failed ? findFailedStep(steps) : null,
        reason: opts.failed ? summarizeReason(output) : null,
        lastStep: lastObservedStep(steps),
    };
}
