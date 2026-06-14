// src/domain/maestro-step-parser.ts
// GH #211: structure maestro_run results from maestro-runner stdout. Pure, no
// I/O, fail-open: unparseable output yields []. Generalizes the #263 step-line
// parser (tap-latency.ts derives parseTapLatencies from parseSteps).
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
