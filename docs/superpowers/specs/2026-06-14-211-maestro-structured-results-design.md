# Design — #211: `maestro_run` structured step results + partial-progress-on-timeout

**Date:** 2026-06-14
**Issue:** [#211](https://github.com/Lykhoyda/rn-dev-agent/issues/211)
**Status:** Approved design → ready for plan
**Branch:** `feat/211-maestro-structured-results` (off `main`; #263 already merged)

## Problem

`maestro_run` works, but verification is harder than it should be:

1. **Output truncated mid-flow** — success is only confirmable via top-level `passed: true` + a separate `cdp_navigation_state`. Per-step pass/fail/durations and terminal assertions aren't visible. The reporter re-ran `grep 'message=' reports/<ts>/junit-report.xml` after *nearly every* failed run (~30/session) to find the failing step.
2. **Timeout returns a bare failure** — a flow that exceeds the cap yields no verdict and no "how far did it get".

Issue item 3 (iOS `clearState` needing `--app-file`) **already shipped** in #276/#201 (`resolveAppFileForClearState`) — out of scope here.

## Goal

Add **structured, additive** fields to the `maestro_run` result so the failing step, reason, and per-step durations are visible without grepping report files, and so a timeout returns partial progress. The per-step durations also become the clean data source #263's degraded-tap-latency heuristic already wants.

## Scope

- **IN:** structured step results; partial progress on timeout.
- **OUT:** iOS `clearState` (shipped); JUnit/report-file parsing (chose stdout-only); `screenshots[]` (YAGNI — the reporter's own suggestion had it empty); bumping the default timeout (the partial-progress *return* is the fix, not a bigger cap).
- **Source:** maestro-runner **stdout** only. The JVM Maestro CLI fallback (iOS-no-adb) emits a different format and degrades **fail-open** to `steps: []` + raw `output`.

## Architecture

Three files; one new pure module. The win is that the per-step data is **already in the stdout** maestro-runner prints — the exact lines #263 parses — so #211's parser is a *generalization* of #263's, and `parseTapLatencies` collapses to a filter over it.

### 1. NEW `src/domain/maestro-step-parser.ts` (pure, no I/O, fail-open)

```ts
export interface ReasonSummary {
  kind: 'SELECTOR_NOT_FOUND' | 'TIMEOUT' | 'ASSERTION_FAILED';
  selector: string | null;
}

export interface MaestroStep {
  index: number;                  // 0-based observed order — disambiguates loops / runFlow repeats
  name: string;                   // full step text minus the trailing (N.Ns), e.g. `tapOn: id="submit"`
  verb: string;                   // first token after the glyph, trailing ':' stripped, e.g. `tapOn`
  status: 'pass' | 'fail';
  durationMs: number;
}

export function stripAnsi(s: string): string;                 // remove SGR codes before matching
export function parseSteps(output: string): MaestroStep[];    // completed steps only (those with a (N.Ns))
export function findFailedStep(steps: MaestroStep[]): MaestroStep | null;     // last status==='fail'
export function lastObservedStep(steps: MaestroStep[]): MaestroStep | null;   // steps.at(-1)
export function summarizeReason(output: string): ReasonSummary | null;        // sanitized — NO raw

export interface StepSummary {
  steps: MaestroStep[];
  failedStep: MaestroStep | null;   // terminal failure only; null unless opts.failed
  reason: ReasonSummary | null;     // null unless opts.failed
  lastStep: MaestroStep | null;     // last observed (completed) step — the progress marker
}
export function buildStepSummary(output: string, opts: { failed: boolean }): StepSummary;
```

**Line grammar (verified against the #263 fixtures):** each step prints as
`  {✓|✗} {verb}[: {selector}] (N.Ns)`. Parser rules:

- `stripAnsi()` first (belt-and-suspenders; `execFile` is not a TTY so color is *usually* off, but unverified against the real binary — see Risks).
- Anchor on a leading status glyph `✓`/`✗` after trimming.
- **Require a trailing `(N.Ns)`** — this excludes the summary line `✗ rn-maestro-run 23.8s` (no parens) and the count lines `3 steps passing` (no glyph). Belt-and-suspenders: also skip a line whose verb is `rn-maestro-run`.
- `verb` = first whitespace-delimited token after the glyph, **with a trailing `:` stripped** (`tapOn:` → `tapOn`). This is load-bearing for the #263 refactor (filter `verb === 'tapOn'`).
- `name` = the line minus the glyph and the trailing `(N.Ns)`.
- `durationMs` = `round(seconds * 1000)`.
- `verb` is the FIRST token, so a verb-name *inside a selector value* (`✓ assertVisible: text="tapOn …"`) is recorded as `assertVisible` — preserves #263 review-finding #2.
- Garbage / empty / CLI-fallback format → `[]`. Never throws.

**`failedStep` is terminal-only.** `findFailedStep` returns the last `✗` step, but `buildStepSummary` only populates `failedStep`/`reason` when `opts.failed` is true. maestro-runner logs transient retries; a step that fails-then-retries-✓ on a run that ultimately **passed** must NOT report a `failedStep` (mirrors `parseMaestroFailure`'s END→START terminal-preference, GH#118). The handler passes `failed = !passed`, so on the success path `failedStep` is always null even if a transient `✗` appears in `steps`.

**`reason` is sanitized — never carries `raw`.** `summarizeReason` calls `parseMaestroFailure` but **projects to `{ kind, selector }`**, explicitly dropping the `raw: string` field that every `MaestroFailure` variant carries. Returning the parser's object directly would re-embed the full unsliced runner log into the result, defeating the 2000/4000-char `output` slice. (UNKNOWN → `null`.)

### 2. REFACTOR `src/domain/tap-latency.ts`

```ts
import { parseSteps } from './maestro-step-parser.js';
export function parseTapLatencies(output: string): number[] {
  return parseSteps(output)
    .filter((s) => s.verb === 'tapOn' && s.status === 'pass')
    .map((s) => s.durationMs);
}
```

`gh-263-tap-latency.test.js` is the regression guard — the `DEGRADED` fixture must still yield `[2800, 3000]` and the single-failed-tap fixture `[]`. `classifyRuntimeDegradation`, `median`, `resolveFloorMs`, `augmentFailureWithDegradation` are unchanged. (The ≥2-sample gate `MIN_SAMPLES_FOR_DEGRADED` is unaffected — it operates on the filtered latency array.)

### 3. WIRE `src/tools/maestro-run.ts`

The current `meta` object (the payload passed to `okResult`/`warnResult`/`failResult`) is extended with the **same field set on all three paths**. Because `okResult(x)`/`warnResult(x,…)` place `x` in `envelope.data` while `failResult(msg,x)` places `x` in `envelope.meta`, the structured fields appear under `data.*` on pass/warn and `meta.*` on fail — and `output` is preserved on every path (`run-action.ts:144` reads `data.output` then `meta.output`).

Added fields (stable set, present on every path):

```ts
steps: MaestroStep[]
failedStep: MaestroStep | null
reason: ReasonSummary | null
lastStep: MaestroStep | null
timedOut: boolean
outputTruncated: boolean
```

- **success** (exit 0, `passed`): `buildStepSummary(output, { failed: false })` → `steps` + `lastStep`; `failedStep:null, reason:null, timedOut:false, outputTruncated:false`.
- **warn** (exit 0 but `outputIndicatesFlowFailure`): `buildStepSummary(output, { failed: true })`; `timedOut:false, outputTruncated:false`; existing `augmentFailureWithDegradation` (#263) unchanged.
- **catch** (non-zero / timeout / overflow): parse the partial `combined` (stdout+stderr Node attaches to the thrown error); `buildStepSummary(combined, { failed: true })`; existing `#263` augmentation unchanged. Timeout vs overflow discrimination:
  ```ts
  const killed = (err as any).killed === true;
  const overflow = (err as any).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  const timedOut = killed && !overflow;
  const outputTruncated = overflow;
  ```
  `err.killed` is the authoritative timeout discriminator (empirical Node probe: timeout → `killed:true, signal:'SIGTERM', code:null`; normal non-zero → `killed:false, code:N`; a SIGTERM-trapping child can leave `code` non-null while killed, so `code` is used only to *subtract* the maxBuffer case). On a pure timeout `failedStep` is `null` (nothing asserted-failed) and `lastStep` is the last **completed** step — the progress marker (an in-flight step has no `(N.Ns)` yet, so it isn't parsed).

## Result shape (consumer view)

```jsonc
// success/warn → envelope.data ; fail/timeout → envelope.meta
{
  "passed": false,
  "flowFile": "/tmp/rn-maestro-run-….yaml",
  "platform": "ios",
  "runner": "maestro-runner",
  "output": "…sliced 2000/4000…",          // unchanged — back-compat
  "steps": [
    { "index": 0, "name": "launchApp", "verb": "launchApp", "status": "pass", "durationMs": 2300 },
    { "index": 1, "name": "tapOn: id=\"submit\"", "verb": "tapOn", "status": "fail", "durationMs": 12700 }
  ],
  "failedStep": { "index": 1, "name": "tapOn: id=\"submit\"", "verb": "tapOn", "status": "fail", "durationMs": 12700 },
  "reason": { "kind": "SELECTOR_NOT_FOUND", "selector": "submit" },
  "lastStep": { "index": 1, "name": "tapOn: id=\"submit\"", "verb": "tapOn", "status": "fail", "durationMs": 12700 },
  "timedOut": false,
  "outputTruncated": false,
  "runtimeDegraded": { "medianTapMs": 1800, "floorMs": 1500, "sampleCount": 3 }  // #263, only when degraded
}
```

## Testing (TDD)

- **NEW `test/unit/gh-211-maestro-step-parser.test.js`** — pure parser + helpers:
  - verbs/status/durations; verb has NO trailing colon; index is observed order.
  - excludes `✗ rn-maestro-run 23.8s` summary line and `N steps passing/failing` count lines.
  - verb-in-selector (`assertVisible: text="tapOn …"`) → verb `assertVisible`.
  - empty / garbage / CLI-format → `[]`; never throws.
  - `stripAnsi` removes SGR codes; an ANSI-wrapped glyph line still parses.
  - `findFailedStep` = last `✗`; `lastObservedStep` = `steps.at(-1)`.
  - `summarizeReason` returns `{ kind, selector }` and **contains no `raw`** (assert the key is absent); UNKNOWN → null.
  - `buildStepSummary(out,{failed:false})` → `failedStep:null,reason:null`; fail-then-retry-✓ output with `{failed:false}` → `failedStep:null`.
- **REGRESSION `test/unit/gh-263-tap-latency.test.js`** stays green (proves `parseTapLatencies` unchanged).
- **NEW `test/unit/gh-211-maestro-run-structured-results.test.js`** — exercise the pure assembly seam directly (no `execFile` mocking): success/warn metas via `buildStepSummary`; catch-path via a fake error `{ killed:true, code:null, stdout:'…partial…', stderr:'' }` asserting `timedOut:true, failedStep:null, lastStep=<last ✓>`; a maxBuffer fake `{ killed:true, code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }` asserting `timedOut:false, outputTruncated:true`.
- **Patch changeset.**

## Risks / open items

- **ANSI (unverified against the real binary).** No ANSI handling exists in the repo and `execFile` is not a TTY (color usually off), but not guaranteed. Mitigation: ship `stripAnsi()` + test now; during device-verify run `~/.maestro-runner/bin/maestro-runner --platform ios test <flow> | grep -c $'\x1b'` to settle whether the strip is load-bearing or belt-and-suspenders.
- **`runFlow` sub-flows.** `runFlow` is allowlisted/used (GH#186). No captured fixture shows how maestro-runner renders sub-flow child glyphs. `steps[]` is documented as a **flat observed list** — no parent/child hierarchy promised; `index` disambiguates repeats. Confirm rendering during device-verify.
- **CLI fallback** produces no structured steps (different format) → `steps: []`, `output` intact. Acceptable: maestro-runner is the default fast path; fail-open matches #263.

## Provenance

Plan reviewed pre-code via `/brainstorm codex,antigravity` (2026-06-14). Codex + Claude file-grounded research caught: the `reason`-re-embeds-`raw` blocker, the maxBuffer-vs-timeout blocker, the `verb` trailing-colon trap, the `data` vs `meta` envelope placement, terminal-only `failedStep`, and ANSI/`runFlow` edges — all folded into this design. (Antigravity hung with no output.)
