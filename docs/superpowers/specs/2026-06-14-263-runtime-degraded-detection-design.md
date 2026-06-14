# GH #263 — Detect wedged simulator runtime → `RUNTIME_DEGRADED` hint

**Status:** Approved (2026-06-14)
**Issue:** [#263](https://github.com/Lykhoyda/rn-dev-agent/issues/263) — detect wedged simulator test-runtime (degraded tap latency) and recommend reboot (`kano:performance`, `effort:m`)

## Problem

A recurring iOS failure mode: tap latencies degrade 3–4× (~0.7s → ~2.6–3.0s), taps report success but `onPress` never fires, and learned-action replays fail at random steps. A `simctl shutdown && boot` restores normal latency every time. The wedged state is **invisible in the failure report** — maestro-runner shows a step timeout ("Element not found"), so the agent investigates app code / staging APIs before recalling the documented reboot fix. We want the failure surface to *name* the likely cause.

## Scope (chosen)

**Detect + hint only.** On a failed `maestro_run` whose median `tapOn` latency is degraded, append a structured `RUNTIME_DEGRADED` hint pointing at a reboot. No new device-lifecycle tool, no auto-reboot — those add disruptive actions (reboot is ~30s and could mask real failures) for marginal gain over a clear hint. The hint alone fixes the core problem: the misleading "Element not found" that misdirects the agent.

## Signal & threshold

- **Source:** the per-`tapOn` latencies maestro-runner already prints in the output `maestro_run` already captures (`stdout+stderr`). No dependency on #211. Real format (from existing `maestro-error-parser.test.js` fixtures, i.e. actual maestro-runner output):
  ```
    ✓ tapOn: id="tab-tasks" (2.8s)
    ✗ tapOn: id="task-mark-all-done" (12.7s)
  ```
  Each `tapOn` step line ends with a parenthesized duration in **seconds**.
- **Only `✓` (successful) tapOn lines count.** A `✗` line's duration is the step *timeout* (e.g. 12.7s), not a tap latency — including it would false-positive on an ordinary "element not found" failure (one timed-out tap → median ≥ floor → bogus hint). The wedge signal is in the *successful* taps being slow (the reporter's 2.6–3.0s were completed taps). So the parser ignores `✗` lines.
- **Statistic:** **median** of the successful `tapOn` durations, in ms.
- **Minimum samples:** require **≥2** successful-tap samples before flagging degraded. A single slow tap (e.g. a cold-start navigation tap > 1.5s) is normal variance — `median` of one sample is just that value, so without this guard an ordinary element-not-found failure that happened after one slow nav tap would mis-fire "reboot" (the exact misdirection this feature fights; caught in multi-LLM review against the canonical #105 fixture). A real wedge degrades *multiple* taps (the reporter saw 2.6–3.0s across the replay), so ≥2 preserves true-positive detection.
- **Threshold:** degraded when `sampleCount ≥ 2 && median ≥ floorMs`, default floor **1500** (1.5s), overridable via `RN_RUNTIME_DEGRADED_FLOOR_MS` (parsed defensively; invalid → default).
- **Gate:** evaluated **only on a failed flow** — never nag on a passing-but-slow run.

## Architecture

```
maestro_run failure branch (maestro-run.ts)
  └─ classifyRuntimeDegradation(output, floorMs)        [domain/tap-latency.ts — pure, no I/O]
       ├─ parseTapLatencies(output): number[] (ms)      regex over `tapOn ... (<N>s)` lines
       └─ median ≥ floor ? { degraded:true, medianMs, floorMs, sampleCount } : { degraded:false, ... }
  └─ if degraded: augment the failResult with meta.runtimeDegraded + a RUNTIME_DEGRADED hint line
```

### Component: `src/domain/tap-latency.ts` (new, pure)

- `parseTapLatencies(output: string): number[]` — scan lines, match **successful** `tapOn` step lines (the `✓` marker) with a trailing `(<float>s)`, convert seconds→ms, return all samples (order preserved). Tolerant: ignores `✗` (failed/timed-out) tap lines, non-`tapOn` step lines (launchApp/assertVisible/etc.), the final `rn-maestro-run` summary line, and any line without a parseable duration. Returns `[]` when nothing matches.
- `median(samples: number[]): number | null` — null on empty; average of the two middle values for even counts.
- `classifyRuntimeDegradation(output: string, floorMs: number): { degraded: boolean; medianMs: number | null; floorMs: number; sampleCount: number }` — `degraded = medianMs != null && medianMs >= floorMs`.
- `resolveFloorMs(env?: string): number` — parse `RN_RUNTIME_DEGRADED_FLOOR_MS`; positive finite integer wins, else `DEFAULT_FLOOR_MS = 1500`.

### Integration: `maestro-run.ts`

In the existing failure path (after `outputIndicatesFlowFailure` determines failure), call `classifyRuntimeDegradation(output, resolveFloorMs(process.env.RN_RUNTIME_DEGRADED_FLOOR_MS))`. If `degraded`:
- add `meta.runtimeDegraded = { medianTapMs, floorMs, sampleCount }` to the failResult, and
- append to the error message:
  `RUNTIME_DEGRADED: median tapOn latency <medianTapMs>ms (≥ <floorMs>ms) — the simulator test runtime is likely wedged; reboot it (xcrun simctl shutdown <udid> && xcrun simctl boot <udid>), relaunch the app, and retry.`

The hint is **purely additive** — it never changes the pass/fail verdict, never alters a passing result, and is appended only to an already-failing `maestro_run` result.

## Error handling — fail-open

`parseTapLatencies`/`classifyRuntimeDegradation` never throw. If the output has no parseable `tapOn` durations (format drift, a flow with no taps), `medianMs` is null → not degraded → no hint → original failResult unchanged. Format drift degrades to "no hint," never a crash or a false alarm.

## Testing

- **`tap-latency.test.js`** (pure unit):
  - `parseTapLatencies`: real-format fixture with mixed `✓/✗ tapOn (Ns)` + non-tap lines + summary line → only the `✓` tapOn durations in ms (the `✗` timeout excluded); no-tap output → `[]`; malformed/no-paren lines skipped. Critical case: a single-tap flow that fails with one `✗ tapOn (12.7s)` → `[]` (no `✓` samples) → NOT degraded (guards the normal-failure false-positive).
  - `median`: odd, even, single, empty(→null).
  - `classifyRuntimeDegradation`: degraded fixture (median ≥ 1500 → degraded with correct medianMs/sampleCount); normal fixture (< 1500 → not degraded); no-timings (→ not degraded, medianMs null).
  - `resolveFloorMs`: default 1500; valid env override; invalid env (`abc`, `0`, negative) → default.
- **`maestro-run` integration:** failed flow + degraded-latency output → result carries the `RUNTIME_DEGRADED` hint + `meta.runtimeDegraded`; failed flow + normal latency → no hint; **passing flow → never a hint** (assert even with high latencies in a passing run).

## Out of scope

- A `device_reboot` MCP tool and auto-reboot-and-retry (deferred; the hint is the v1 deliverable).
- Degradation detection on the `device_*` (L2) tap path — this targets `maestro_run`/learned-action replays where the reporter hit it. A `device_*` extension can reuse `tap-latency` later.
- A per-action RunRecord latency baseline — RunRecord stores only whole-flow `durationMs`; a fixed floor is simpler and stateless. (Revisit if the fixed floor proves noisy across machines.)

## Refs

`src/tools/maestro-run.ts` (failure branch, already captures `output`), new `src/domain/tap-latency.ts`; real output format from `test/unit/maestro-error-parser.test.js` fixtures. Related #202 (runner contention — possible root cause), #211 (structured step results), #194 (recovery loops). Issue #263.
