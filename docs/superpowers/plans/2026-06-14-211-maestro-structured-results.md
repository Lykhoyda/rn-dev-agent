# maestro_run Structured Step Results — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `maestro_run` return structured per-step results (`steps`/`failedStep`/`reason`/`lastStep`) and partial progress on timeout, parsed from maestro-runner stdout.

**Architecture:** One new pure module (`maestro-step-parser.ts`) parses the `{✓|✗} verb[: sel] (N.Ns)` step lines maestro-runner already prints; `tap-latency.ts` (#263) is refactored to derive its tap latencies from it; `maestro-run.ts` spreads the structured fields into the result payload on all three return paths (additive — `output` preserved for `run-action.ts`). Fields land in `envelope.data` on pass/warn and `envelope.meta` on fail.

**Tech Stack:** TypeScript (ESM, `type:module`, Node ≥22), `node:test` + `node:assert/strict`, tests import compiled `dist/*.js` (`npm run build` = `tsc`).

**Working dir for ALL commands:** `scripts/cdp-bridge/`

---

## File Structure

- **Create** `scripts/cdp-bridge/src/domain/maestro-step-parser.ts` — pure helpers: `stripAnsi`, `parseSteps`, `findFailedStep`, `lastObservedStep`, `summarizeReason`, `buildStepSummary`, `classifyExecError` + types `MaestroStep`, `ReasonSummary`, `StepSummary`, `ExecErrorClass`.
- **Modify** `scripts/cdp-bridge/src/domain/tap-latency.ts` — `parseTapLatencies` derives from `parseSteps`.
- **Modify** `scripts/cdp-bridge/src/tools/maestro-run.ts` — import + spread structured fields on success/warn/catch paths.
- **Create** `scripts/cdp-bridge/test/unit/gh-211-maestro-step-parser.test.js` — all pure-logic tests (parser, helpers, summary, exec-error, catch-path assembly).
- **Unchanged guard** `scripts/cdp-bridge/test/unit/gh-263-tap-latency.test.js` — must stay green after Task 3.
- **Create** `.changeset/<name>.md` — patch changeset.

> Note: the spec mentioned a separate handler-level test file. It collapses to one file here because `createMaestroRunHandler()` has no `execFile` injection seam, and the existing test pattern (`gh-201`/`gh-202`) tests **exported pure helpers**, not the full handler. The handler wiring is covered by the type-checked build + full suite + on-device verification (phase 6).

---

## Task 1: Step parser core (`parseSteps`, `stripAnsi`, `MaestroStep`)

**Files:**
- Create: `scripts/cdp-bridge/src/domain/maestro-step-parser.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-211-maestro-step-parser.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/gh-211-maestro-step-parser.test.js`:

```js
// test/unit/gh-211-maestro-step-parser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSteps, stripAnsi } from '../../dist/domain/maestro-step-parser.js';

// Real maestro-runner format (same shape as the gh-263 fixtures).
const FAILED_RUN = `  ✓ launchApp (2.3s)
  ✓ tapOn: id="a" (2.8s)
  ✓ tapOn: id="b" (3.0s)
  ✓ assertVisible: text="x" (1.1s)
  ✗ tapOn: id="c" (12.7s)
✗ rn-maestro-run 23.8s`;

test('parseSteps: verb/status/durationMs/index; summary line excluded', () => {
  const steps = parseSteps(FAILED_RUN);
  assert.equal(steps.length, 5);
  assert.deepEqual(steps[0], { index: 0, name: 'launchApp', verb: 'launchApp', status: 'pass', durationMs: 2300 });
  assert.deepEqual(steps[1], { index: 1, name: 'tapOn: id="a"', verb: 'tapOn', status: 'pass', durationMs: 2800 });
  assert.deepEqual(steps[4], { index: 4, name: 'tapOn: id="c"', verb: 'tapOn', status: 'fail', durationMs: 12700 });
  assert.ok(!steps.some((s) => s.verb === 'rn-maestro-run')); // `✗ rn-maestro-run 23.8s` has no (N.Ns)
});

test('parseSteps: verb has trailing colon stripped', () => {
  assert.equal(parseSteps('  ✓ tapOn: id="a" (1.0s)')[0].verb, 'tapOn');
});

test('parseSteps: verb is first token — verb name inside a selector value is not the verb', () => {
  assert.equal(parseSteps('  ✓ assertVisible: text="tapOn now" (1.0s)')[0].verb, 'assertVisible');
});

test('parseSteps: count lines / bare text are not steps', () => {
  assert.deepEqual(parseSteps('  3 steps passing\n  1 steps failing\nRunning on iPhone'), []);
});

test('parseSteps: embedded (N.Ns) in a selector — trailing duration wins', () => {
  const steps = parseSteps('  ✓ assertVisible: text="took (2.0s)" (1.0s)');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].durationMs, 1000);
  assert.equal(steps[0].name, 'assertVisible: text="took (2.0s)"');
});

test('parseSteps: empty / garbage / non-string → [] (never throws)', () => {
  assert.deepEqual(parseSteps(''), []);
  assert.deepEqual(parseSteps('not maestro output'), []);
  assert.deepEqual(parseSteps(undefined), []);
});

test('stripAnsi: removes SGR codes; ANSI-wrapped glyph line still parses', () => {
  const colored = '  [32m✓[0m tapOn: id="a" (1.0s)';
  assert.equal(stripAnsi(colored).includes(''), false);
  const steps = parseSteps(colored);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].verb, 'tapOn');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/gh-211-maestro-step-parser.test.js`
Expected: FAIL — `Cannot find module .../dist/domain/maestro-step-parser.js` (module not yet created).

- [ ] **Step 3: Write minimal implementation**

Create `src/domain/maestro-step-parser.ts`:

```ts
// src/domain/maestro-step-parser.ts
// GH #211: structure maestro_run results from maestro-runner stdout. Pure, no
// I/O, fail-open: unparseable output yields []. Generalizes the #263 step-line
// parser (tap-latency.ts derives from parseSteps).

export interface MaestroStep {
  index: number;
  name: string;
  verb: string;
  status: 'pass' | 'fail';
  durationMs: number;
}

// Strip ANSI SGR/color escape sequences. execFile output is usually un-colored
// (child stdout is a pipe, not a TTY) but maestro-runner is not guaranteed to
// honor that, and a glyph-anchored match breaks on `[32m✓[0m`.
const ANSI_RE = /\[[0-9;]*m/g;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/gh-211-maestro-step-parser.test.js`
Expected: PASS (all `parseSteps` + `stripAnsi` tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/maestro-step-parser.ts test/unit/gh-211-maestro-step-parser.test.js
git commit -m "feat(#211): parseSteps + stripAnsi — structure maestro-runner step lines"
```

---

## Task 2: Summary helpers (`findFailedStep`, `lastObservedStep`, `summarizeReason`, `buildStepSummary`)

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/maestro-step-parser.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-211-maestro-step-parser.test.js`

- [ ] **Step 1: Write the failing test** (append to the test file)

```js
import {
  findFailedStep, lastObservedStep, summarizeReason, buildStepSummary,
} from '../../dist/domain/maestro-step-parser.js';

test('findFailedStep: last ✗ step; null when all pass', () => {
  assert.equal(findFailedStep(parseSteps(FAILED_RUN)).name, 'tapOn: id="c"');
  assert.equal(findFailedStep(parseSteps('  ✓ launchApp (1.0s)')), null);
});

test('lastObservedStep: steps.at(-1); null when empty', () => {
  assert.equal(lastObservedStep(parseSteps(FAILED_RUN)).name, 'tapOn: id="c"');
  assert.equal(lastObservedStep([]), null);
});

test('summarizeReason: sanitized {kind, selector}; NEVER carries raw', () => {
  const r = summarizeReason(`Element with id 'submit' not found`);
  assert.deepEqual(r, { kind: 'SELECTOR_NOT_FOUND', selector: 'submit' });
  assert.equal('raw' in r, false);
});

test('summarizeReason: unrecognized output → null', () => {
  assert.equal(summarizeReason('some unrecognized output'), null);
});

test('buildStepSummary: failed=false → failedStep/reason null even with a transient ✗', () => {
  const s = buildStepSummary(FAILED_RUN, { failed: false });
  assert.equal(s.failedStep, null);
  assert.equal(s.reason, null);
  assert.equal(s.steps.length, 5);
  assert.equal(s.lastStep.name, 'tapOn: id="c"');
});

test('buildStepSummary: failed=true → failedStep + reason populated', () => {
  const out = FAILED_RUN + `\nElement with id 'c' not found`;
  const s = buildStepSummary(out, { failed: true });
  assert.equal(s.failedStep.name, 'tapOn: id="c"');
  assert.deepEqual(s.reason, { kind: 'SELECTOR_NOT_FOUND', selector: 'c' });
});

test('buildStepSummary: timeout partial (no ✗) → failedStep null, lastStep = last ✓', () => {
  const partial = `  ✓ launchApp (2.0s)\n  ✓ tapOn: id="a" (2.5s)`;
  const s = buildStepSummary(partial, { failed: true });
  assert.equal(s.failedStep, null);
  assert.equal(s.lastStep.name, 'tapOn: id="a"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/gh-211-maestro-step-parser.test.js`
Expected: FAIL — `findFailedStep`/`lastObservedStep`/`summarizeReason`/`buildStepSummary` are not exported.

- [ ] **Step 3: Write minimal implementation** (append to `src/domain/maestro-step-parser.ts`)

```ts
import { parseMaestroFailure } from './maestro-error-parser.js';

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/gh-211-maestro-step-parser.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/maestro-step-parser.ts test/unit/gh-211-maestro-step-parser.test.js
git commit -m "feat(#211): buildStepSummary + helpers (raw-free reason, terminal-only failedStep)"
```

---

## Task 3: Exec-error classifier (`classifyExecError`) + catch-path assembly

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/maestro-step-parser.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-211-maestro-step-parser.test.js`

- [ ] **Step 1: Write the failing test** (append)

```js
import { classifyExecError } from '../../dist/domain/maestro-step-parser.js';

test('classifyExecError: timeout (killed, no code) → timedOut, not truncated', () => {
  assert.deepEqual(
    classifyExecError({ killed: true, signal: 'SIGTERM', code: null }),
    { timedOut: true, outputTruncated: false },
  );
});

test('classifyExecError: maxBuffer overflow → truncated, not timedOut', () => {
  assert.deepEqual(
    classifyExecError({ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
    { timedOut: false, outputTruncated: true },
  );
});

test('classifyExecError: normal non-zero exit → neither; null/undefined safe', () => {
  assert.deepEqual(classifyExecError({ killed: false, code: 1 }), { timedOut: false, outputTruncated: false });
  assert.deepEqual(classifyExecError(null), { timedOut: false, outputTruncated: false });
});

// Documents the maestro-run.ts catch-path assembly using the same functions.
test('catch-path assembly: timeout → timedOut, partial steps, failedStep null', () => {
  const err = { killed: true, code: null, stdout: '  ✓ launchApp (2.0s)\n  ✓ tapOn: id="a" (2.5s)', stderr: '' };
  const combined = (err.stdout + '\n' + err.stderr).trim();
  const cls = classifyExecError(err);
  const summary = buildStepSummary(combined, { failed: true });
  assert.equal(cls.timedOut, true);
  assert.equal(cls.outputTruncated, false);
  assert.equal(summary.failedStep, null);
  assert.equal(summary.lastStep.name, 'tapOn: id="a"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/gh-211-maestro-step-parser.test.js`
Expected: FAIL — `classifyExecError` is not exported.

- [ ] **Step 3: Write minimal implementation** (append to `src/domain/maestro-step-parser.ts`)

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/gh-211-maestro-step-parser.test.js`
Expected: PASS (full file).

- [ ] **Step 5: Commit**

```bash
git add src/domain/maestro-step-parser.ts test/unit/gh-211-maestro-step-parser.test.js
git commit -m "feat(#211): classifyExecError — distinguish timeout from maxBuffer overflow"
```

---

## Task 4: Refactor `parseTapLatencies` to derive from `parseSteps` (#263 stays green)

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/tap-latency.ts:13-27`
- Guard test (unchanged): `scripts/cdp-bridge/test/unit/gh-263-tap-latency.test.js`

- [ ] **Step 1: Replace the parser body**

In `src/domain/tap-latency.ts`, replace the `parseTapLatencies` function (lines 13-27) with a derivation over `parseSteps`. Add the import at the top of the file (after the header comment):

```ts
import { parseSteps } from './maestro-step-parser.js';
```

Replace the function:

```ts
/**
 * Latencies (ms) of SUCCESSFUL tapOn steps. Derived from parseSteps (GH #211):
 * a ✗ tap's duration is the step timeout (~12.7s) and would false-positive an
 * ordinary element-not-found failure, so only pass tapOn steps count.
 */
export function parseTapLatencies(output: string): number[] {
  return parseSteps(output)
    .filter((s) => s.verb === 'tapOn' && s.status === 'pass')
    .map((s) => s.durationMs);
}
```

- [ ] **Step 2: Run the #263 regression guard + #211 tests**

Run: `npm run build && node --test test/unit/gh-263-tap-latency.test.js test/unit/gh-211-maestro-step-parser.test.js`
Expected: PASS — `parseTapLatencies(DEGRADED)` still `[2800, 3000]`, single-failed-tap still `[]`, verb-in-selector still excluded, `classifyRuntimeDegradation`/`median`/`augmentFailureWithDegradation` unaffected.

- [ ] **Step 3: Commit**

```bash
git add src/domain/tap-latency.ts
git commit -m "refactor(#211): parseTapLatencies derives from shared parseSteps (DRY with #263)"
```

---

## Task 5: Wire structured fields into `maestro_run` (success / warn / catch)

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/maestro-run.ts` (import; success/warn block ~L219-255; catch block ~L256-287)

- [ ] **Step 1: Add the import** (after line 19, alongside the other domain imports)

```ts
import { buildStepSummary, classifyExecError } from '../domain/maestro-step-parser.js';
```

- [ ] **Step 2: Rewrite the success/warn block**

Replace the block from `const output = (stdout + '\n' + stderr).trim();` through the `return warnResult(warnAug.meta, warnAug.message);` (current lines 219-255) with:

```ts
      const output = (stdout + '\n' + stderr).trim();
      // Exit 0 is the authoritative pass signal; the output scan is the GH#249
      // secondary guard keyed on Maestro's own status LINES.
      const passed = !outputIndicatesFlowFailure(output);
      const summary = buildStepSummary(output, { failed: !passed });
      const meta = {
        passed,
        flowFile,
        platform,
        runner: dispatch.runner,
        output: output.slice(0, 2000),
        ...summary,
        timedOut: false,
        outputTruncated: false,
        ...(dispatch.fallbackReason ? { fallbackReason: dispatch.fallbackReason } : {}),
      };

      if (passed) {
        if (dispatch.fallbackReason && shouldWarnFallback(dispatch.fallbackReason)) {
          return warnResult(meta, dispatch.fallbackReason);
        }
        return okResult(meta);
      }
      const baseWarnMsg = dispatch.fallbackReason
        ? `${dispatch.fallbackReason}; flow completed with warnings or failures`
        : 'Flow completed with warnings or failures';
      // GH #263: classify on the FULL output (not the sliced meta.output).
      const warnAug = augmentFailureWithDegradation(
        output,
        resolveFloorMs(process.env.RN_RUNTIME_DEGRADED_FLOOR_MS),
        baseWarnMsg,
        meta,
      );
      return warnResult(warnAug.meta, warnAug.message);
```

- [ ] **Step 3: Rewrite the catch block**

Replace the catch body (current lines 256-287) with:

```ts
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Node attaches partial stdout/stderr to the error on timeout/kill —
      // preserve them so downstream parsers (run-action parseMaestroFailure)
      // and the step parser can still classify the partial run.
      const errAny = err as { stdout?: unknown; stderr?: unknown };
      const stdout = typeof errAny?.stdout === 'string' ? errAny.stdout : '';
      const stderr = typeof errAny?.stderr === 'string' ? errAny.stderr : '';
      const combined = (stdout + '\n' + stderr).trim();
      const { timedOut, outputTruncated } = classifyExecError(err);
      const summary = buildStepSummary(combined, { failed: true });
      // GH #263: a timeout/non-zero exit is also a failure surface — flag a
      // wedged runtime here too if the successful taps were degraded.
      const failAug = augmentFailureWithDegradation(
        combined,
        resolveFloorMs(process.env.RN_RUNTIME_DEGRADED_FLOOR_MS),
        `Maestro flow failed: ${msg.slice(0, 500)}`,
        {
          flowFile,
          platform,
          runner: dispatch.runner,
          passed: false,
          output: combined.slice(0, 4000),
          ...summary,
          timedOut,
          outputTruncated,
        },
      );
      return failResult(failAug.message, failAug.meta);
    }
```

- [ ] **Step 4: Build + run the FULL suite**

Run: `npm test`
Expected: PASS — all suites including `gh-211-*`, `gh-263-*`, `gh-201-*`, `gh-202-*`, `gh-249-*`, `maestro-error-parser`, `maestro-dispatch`. Confirm the total count is ≥ the pre-change baseline (was 2063).

- [ ] **Step 5: Commit**

```bash
git add src/tools/maestro-run.ts
git commit -m "feat(#211): maestro_run returns steps/failedStep/reason/lastStep + partial progress on timeout"
```

---

## Task 6: Changeset + final green

**Files:**
- Create: `scripts/cdp-bridge/.changeset/<run-name>.md` (or repo-root `.changeset/` — match where existing changesets live; check `ls .changeset` from repo root)

- [ ] **Step 1: Locate the changeset dir**

Run (from repo root): `ls .changeset/*.md | head` and open one to copy the frontmatter package name (e.g. `"rn-dev-agent"` / the cdp-bridge package name).

- [ ] **Step 2: Write the changeset**

Create `.changeset/maestro-structured-step-results.md` (use the package name from Step 1):

```markdown
---
"<package-name-from-step-1>": patch
---

maestro_run: structured per-step results (steps/failedStep/reason/lastStep) and
partial progress on timeout. Parsed from maestro-runner stdout; reason is
sanitized (no raw log); timeout is distinguished from maxBuffer overflow
(timedOut vs outputTruncated). Fields are additive — output is preserved (#211).
```

- [ ] **Step 3: Final full suite + typecheck**

Run (from `scripts/cdp-bridge`): `npm test`
Expected: PASS, full suite green.

- [ ] **Step 4: Commit**

```bash
git add .changeset/
git commit -m "chore(#211): changeset for maestro_run structured step results"
```

---

## Post-implementation (phase 6 — not TDD tasks)

- **/multi-review** the diff (Gemini + Codex).
- **On-device verify** (`maestro_run` on a real iOS sim flow): assert `data.steps`/`data.failedStep`/`data.lastStep` populate on pass and a forced-fail flow; settle the **ANSI question** empirically — `~/.maestro-runner/bin/maestro-runner --platform ios test <flow> | cat -v | grep -c '\^\['` (or pipe to a file and `grep -c $'\x1b'`); confirm `runFlow` sub-flow step rendering. Repeat one check on Android emulator.
- Fix findings, re-run suite, finish branch → PR.

## Self-Review

- **Spec coverage:** structured steps (Tasks 1-2,5) ✓; partial-progress-on-timeout (Tasks 3,5) ✓; #263 DRY refactor (Task 4) ✓; raw-free reason (Task 2) ✓; timeout≠overflow (Task 3) ✓; additive `output` preserved (Task 5) ✓; ANSI/runFlow (defensive in Task 1 + device-verify) ✓.
- **Placeholder scan:** none — every code step has full code; the only `<placeholder>` is the changeset package name, resolved in Task 6 Step 1.
- **Type consistency:** `MaestroStep`/`ReasonSummary`/`StepSummary`/`ExecErrorClass` defined in Tasks 1-3 and used identically in Tasks 4-5; `buildStepSummary(output,{failed})`, `classifyExecError(err)` signatures match call sites in `maestro-run.ts`.
