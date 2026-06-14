// src/domain/maestro-step-parser.ts
// GH #211: structure maestro_run results from maestro-runner stdout. Pure, no
// I/O, fail-open: unparseable output yields []. Generalizes the #263 step-line
// parser (tap-latency.ts derives parseTapLatencies from parseSteps).

import { parseMaestroFailure } from './maestro-error-parser.js';

export interface MaestroStep {
  index: number;
  name: string;
  verb: string;
  status: 'pass' | 'fail';
  durationMs: number;
}

// Strip ANSI SGR/color escape sequences. execFile output is usually un-colored
// (child stdout is a pipe, not a TTY) but maestro-runner is not guaranteed to
// honor that, and a glyph-anchored match breaks on a colored `✓`. Built via
// fromCharCode(27) (ESC) to keep a raw control char out of the source/regex.
const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// `  {✓|✗} <name> (N.Ns)` — the trailing (N.Ns) is REQUIRED, which excludes the
// `✗ rn-maestro-run 23.8s` summary line and the `N steps passing` count lines.
// `.*?` is non-greedy + `$`-anchored so a duration-looking token inside the
// selector value (`text="took (2.0s)"`) loses to the real trailing duration.
const STEP_RE = /^([✓✗])\s+(.*?)\s*\(([\d.]+)s\)\s*$/;

export function parseSteps(output: string): MaestroStep[] {
  if (!output || typeof output !== 'string') return [];
  const steps: MaestroStep[] = [];
  let index = 0;
  for (const raw of stripAnsi(output).split('\n')) {
    const m = STEP_RE.exec(raw.trim());
    if (!m) continue;
    const name = m[2].trim();
    const verb = name.split(/\s+/)[0].replace(/:$/, '');
    if (verb === 'rn-maestro-run') continue; // belt-and-suspenders vs a future summary format
    const seconds = Number(m[3]);
    if (!Number.isFinite(seconds)) continue;
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

export function findFailedStep(steps: MaestroStep[]): MaestroStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].status === 'fail') return steps[i];
  }
  return null;
}

export function lastObservedStep(steps: MaestroStep[]): MaestroStep | null {
  return steps.length ? steps[steps.length - 1] : null;
}

export interface ReasonSummary {
  kind: 'SELECTOR_NOT_FOUND' | 'TIMEOUT' | 'ASSERTION_FAILED';
  selector: string | null;
}

// Project parseMaestroFailure to {kind, selector}, DROPPING its `raw` field —
// every MaestroFailure variant carries `raw` = the full unsliced output, which
// must not be re-embedded into the result (it would defeat the output slice).
export function summarizeReason(output: string): ReasonSummary | null {
  const f = parseMaestroFailure(output);
  if (f.kind === 'UNKNOWN') return null;
  const selector = 'selector' in f ? (f.selector ?? null) : null;
  return { kind: f.kind, selector };
}

export interface StepSummary {
  steps: MaestroStep[];
  failedStep: MaestroStep | null;
  reason: ReasonSummary | null;
  lastStep: MaestroStep | null;
}

// failedStep/reason are populated ONLY when the run's terminal verdict is fail
// (opts.failed). maestro-runner logs transient retries; a fail-then-retry-✓ on
// a PASSED run must not report a failedStep (mirrors parseMaestroFailure GH#118).
export function buildStepSummary(output: string, opts: { failed: boolean }): StepSummary {
  const steps = parseSteps(output);
  return {
    steps,
    failedStep: opts.failed ? findFailedStep(steps) : null,
    reason: opts.failed ? summarizeReason(output) : null,
    lastStep: lastObservedStep(steps),
  };
}

export interface ExecErrorClass {
  timedOut: boolean;
  outputTruncated: boolean;
}

// execFile timeout kills the child (killed===true, signal 'SIGTERM', code null).
// A 10MB maxBuffer overflow ALSO rejects with killed===true but code
// 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' — that's truncation, not a timeout, so it
// must not be mislabeled. `killed` is authoritative; `code` only subtracts the
// overflow case (a SIGTERM-trapping child can leave a non-null exit code).
export function classifyExecError(err: unknown): ExecErrorClass {
  const e = err as { killed?: unknown; code?: unknown } | null;
  const killed = e?.killed === true;
  const overflow = e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  return { timedOut: killed && !overflow, outputTruncated: overflow };
}

// Headline for a failed maestro_run, built from STRUCTURED data so it never
// re-embeds raw runner/app output. The raw fallbackMsg (err.message, which
// execFile populates with stderr) is used ONLY when there is no structured
// signal — e.g. a spawn/system error with no step output. Raw output still
// lives in the bounded `output` field.
export function formatFailureHeadline(
  summary: StepSummary,
  cls: ExecErrorClass,
  fallbackMsg: string,
): string {
  if (cls.timedOut) {
    return `Maestro flow timed out${summary.lastStep ? ` after step "${summary.lastStep.name}"` : ''}`;
  }
  if (cls.outputTruncated) {
    return 'Maestro flow output exceeded the 10MB buffer';
  }
  if (summary.failedStep) {
    const r = summary.reason;
    const reasonStr = r ? ` (${r.kind}${r.selector ? `: ${r.selector}` : ''})` : '';
    return `Maestro flow failed at step "${summary.failedStep.name}"${reasonStr}`;
  }
  return `Maestro flow failed: ${fallbackMsg.slice(0, 500)}`;
}
