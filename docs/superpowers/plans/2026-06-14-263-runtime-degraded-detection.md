# Wedged-simulator detection → `RUNTIME_DEGRADED` hint (GH #263) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `maestro_run` flow fails with degraded tap latency, append a `RUNTIME_DEGRADED` hint pointing at a simulator reboot, instead of the misleading "Element not found".

**Architecture:** A new pure module `src/domain/tap-latency.ts` parses the median of successful (`✓`) `tapOn` latencies from maestro-runner output (already captured by `maestro_run`), classifies degradation against a fixed floor (1500ms, env-overridable), and builds the hint. `maestro-run.ts` calls a pure `augmentFailureWithDegradation` helper at its two failure return sites; it's purely additive and never runs on a passing flow.

**Tech Stack:** TypeScript (Node ≥22, ESM), `node:test`.

**Spec:** `docs/superpowers/specs/2026-06-14-263-runtime-degraded-detection-design.md`

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/domain/tap-latency.ts` | parse ✓ tapOn latencies, median, classify, resolve floor, format hint, augment-failure helper | **create** (pure, no I/O) |
| `src/tools/maestro-run.ts` | call `augmentFailureWithDegradation` at the two failure returns | **modify** (2 sites + import) |
| `test/unit/gh-263-tap-latency.test.js` | unit tests for the whole module incl. the augment helper | **create** |

Real maestro-runner output format (from existing `test/unit/maestro-error-parser.test.js` fixtures — actual output):
```
  ✓ launchApp (2.3s)
  ✓ tapOn: id="tab-tasks" (2.8s)
  ✓ assertVisible: text="Tasks" (1.3s)
  ✗ tapOn: id="task-mark-all-done" (12.7s)
✗ rn-maestro-run 23.8s
```

---

## Task 1: Pure `tap-latency.ts` module

**Files:**
- Create: `src/domain/tap-latency.ts`
- Test: `test/unit/gh-263-tap-latency.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/gh-263-tap-latency.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTapLatencies, median, resolveFloorMs, classifyRuntimeDegradation,
  formatRuntimeDegradedHint, augmentFailureWithDegradation, DEFAULT_FLOOR_MS,
} from '../../dist/domain/tap-latency.js';

const DEGRADED = `  ✓ launchApp (2.3s)
  ✓ tapOn: id="a" (2.8s)
  ✓ tapOn: id="b" (3.0s)
  ✓ assertVisible: text="x" (1.1s)
  ✗ tapOn: id="c" (12.7s)
✗ rn-maestro-run 23.8s`;

const NORMAL = `  ✓ launchApp (1.0s)
  ✓ tapOn: id="a" (0.7s)
  ✓ tapOn: id="b" (0.9s)
  ✗ assertVisible: text="x" (10.0s)
✗ rn-maestro-run 12.0s`;

// A genuine "element not found" failure with ONE tap that timed out — the ✗
// duration must NOT be counted, else this false-positives as degraded.
const SINGLE_FAILED_TAP = `  ✓ launchApp (1.1s)
  ✗ tapOn: id="missing" (12.7s)
✗ rn-maestro-run 14.0s`;

test('parseTapLatencies: only successful (✓) tapOn lines, seconds→ms', () => {
  assert.deepEqual(parseTapLatencies(DEGRADED), [2800, 3000]);
});

test('parseTapLatencies: a single failed (✗) tap yields no samples (no false positive)', () => {
  assert.deepEqual(parseTapLatencies(SINGLE_FAILED_TAP), []);
});

test('parseTapLatencies: output with no tapOn lines → []', () => {
  assert.deepEqual(parseTapLatencies('  ✓ launchApp (2.0s)\n✓ rn-maestro-run 2.0s'), []);
  assert.deepEqual(parseTapLatencies(''), []);
});

test('median: odd, even, single, empty', () => {
  assert.equal(median([3000, 2800, 1000]), 2800);  // sorted 1000,2800,3000
  assert.equal(median([2800, 3000]), 2900);        // average of two middle
  assert.equal(median([1500]), 1500);
  assert.equal(median([]), null);
});

test('resolveFloorMs: default, valid override, invalid → default', () => {
  assert.equal(resolveFloorMs(undefined), DEFAULT_FLOOR_MS);
  assert.equal(DEFAULT_FLOOR_MS, 1500);
  assert.equal(resolveFloorMs('2000'), 2000);
  assert.equal(resolveFloorMs('abc'), DEFAULT_FLOOR_MS);
  assert.equal(resolveFloorMs('0'), DEFAULT_FLOOR_MS);
  assert.equal(resolveFloorMs('-5'), DEFAULT_FLOOR_MS);
});

test('classifyRuntimeDegradation: degraded when median ≥ floor', () => {
  const d = classifyRuntimeDegradation(DEGRADED, 1500);
  assert.equal(d.degraded, true);
  assert.equal(d.medianMs, 2900);   // median of [2800,3000]
  assert.equal(d.sampleCount, 2);
  assert.equal(d.floorMs, 1500);
});

test('classifyRuntimeDegradation: normal latency is not degraded', () => {
  const d = classifyRuntimeDegradation(NORMAL, 1500);
  assert.equal(d.degraded, false);
  assert.equal(d.medianMs, 800);    // median of [700,900]
});

test('classifyRuntimeDegradation: no tap samples → not degraded, medianMs null', () => {
  const d = classifyRuntimeDegradation(SINGLE_FAILED_TAP, 1500);
  assert.equal(d.degraded, false);
  assert.equal(d.medianMs, null);
  assert.equal(d.sampleCount, 0);
});

test('formatRuntimeDegradedHint: names the code, median, floor, and reboot', () => {
  const hint = formatRuntimeDegradedHint(classifyRuntimeDegradation(DEGRADED, 1500));
  assert.match(hint, /RUNTIME_DEGRADED/);
  assert.match(hint, /2900ms/);
  assert.match(hint, /1500ms/);
  assert.match(hint, /simctl shutdown/);
});

test('augmentFailureWithDegradation: degraded → hint appended + meta.runtimeDegraded', () => {
  const { message, meta } = augmentFailureWithDegradation(DEGRADED, 1500, 'Flow failed', { passed: false });
  assert.match(message, /Flow failed — RUNTIME_DEGRADED:/);
  assert.deepEqual(meta.runtimeDegraded, { medianTapMs: 2900, floorMs: 1500, sampleCount: 2 });
  assert.equal(meta.passed, false); // base meta preserved
});

test('augmentFailureWithDegradation: not degraded → message + meta unchanged', () => {
  const base = { passed: false, output: 'x' };
  const { message, meta } = augmentFailureWithDegradation(NORMAL, 1500, 'Flow failed', base);
  assert.equal(message, 'Flow failed');
  assert.equal(meta.runtimeDegraded, undefined);
  assert.deepEqual(meta, base);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/gh-263-tap-latency.test.js`
Expected: FAIL — cannot find module `dist/domain/tap-latency.js`.

- [ ] **Step 3: Implement `src/domain/tap-latency.ts`**

```ts
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
export function parseTapLatencies(output: string): number[] {
  const out: number[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('✓')) continue;       // successful steps only
    if (!/\btapOn\b/.test(line)) continue;     // tap steps only
    const m = line.match(/\(([\d.]+)s\)\s*$/); // trailing (N.Ns)
    if (!m) continue;
    const seconds = Number(m[1]);
    if (Number.isFinite(seconds)) out.push(Math.round(seconds * 1000));
  }
  return out;
}

export function median(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const s = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}

export function resolveFloorMs(envVal?: string): number {
  if (envVal === undefined) return DEFAULT_FLOOR_MS;
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FLOOR_MS;
}

export interface RuntimeDegradation {
  degraded: boolean;
  medianMs: number | null;
  floorMs: number;
  sampleCount: number;
}

export function classifyRuntimeDegradation(output: string, floorMs: number): RuntimeDegradation {
  const samples = parseTapLatencies(output);
  const medianMs = median(samples);
  return {
    degraded: medianMs != null && medianMs >= floorMs,
    medianMs,
    floorMs,
    sampleCount: samples.length,
  };
}

export function formatRuntimeDegradedHint(d: RuntimeDegradation): string {
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
export function augmentFailureWithDegradation(
  output: string,
  floorMs: number,
  baseMessage: string,
  baseMeta: Record<string, unknown>,
): { message: string; meta: Record<string, unknown> } {
  const d = classifyRuntimeDegradation(output, floorMs);
  if (!d.degraded) return { message: baseMessage, meta: baseMeta };
  return {
    message: `${baseMessage} — ${formatRuntimeDegradedHint(d)}`,
    meta: { ...baseMeta, runtimeDegraded: { medianTapMs: d.medianMs, floorMs: d.floorMs, sampleCount: d.sampleCount } },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/gh-263-tap-latency.test.js`
Expected: PASS (11/11).

- [ ] **Step 5: Commit**

```bash
git add src/domain/tap-latency.ts test/unit/gh-263-tap-latency.test.js dist/domain/tap-latency.js
git commit -m "feat(#263): tap-latency domain module — parse/median/classify/augment (pure)"
```

---

## Task 2: Wire into `maestro-run.ts` failure paths + changeset

**Files:**
- Modify: `src/tools/maestro-run.ts` (import + the two failure returns)
- Create: `.changeset/gh-263-runtime-degraded.md`

- [ ] **Step 1: Add the import**

Near the other domain imports in `src/tools/maestro-run.ts` (it already imports `outputIndicatesFlowFailure` from `../domain/maestro-error-parser.js`), add:

```ts
import { augmentFailureWithDegradation, resolveFloorMs } from '../domain/tap-latency.js';
```

- [ ] **Step 2: Wire the "completed with failures" path**

Current code (the failing branch of the success path):
```ts
      return warnResult(
        meta,
        dispatch.fallbackReason
          ? `${dispatch.fallbackReason}; flow completed with warnings or failures`
          : 'Flow completed with warnings or failures',
      );
```
Replace with (classify on the FULL `output` var, not the sliced `meta.output`):
```ts
      const baseWarnMsg = dispatch.fallbackReason
        ? `${dispatch.fallbackReason}; flow completed with warnings or failures`
        : 'Flow completed with warnings or failures';
      const warnAug = augmentFailureWithDegradation(
        output,
        resolveFloorMs(process.env.RN_RUNTIME_DEGRADED_FLOOR_MS),
        baseWarnMsg,
        meta,
      );
      return warnResult(warnAug.meta, warnAug.message);
```

- [ ] **Step 3: Wire the catch (timeout/non-zero exit) path**

Current code:
```ts
      const combined = (stdout + '\n' + stderr).trim();
      return failResult(`Maestro flow failed: ${msg.slice(0, 500)}`, {
        flowFile,
        platform,
        runner: dispatch.runner,
        passed: false,
        output: combined.slice(0, 4000),
      });
```
Replace with:
```ts
      const combined = (stdout + '\n' + stderr).trim();
      const failAug = augmentFailureWithDegradation(
        combined,
        resolveFloorMs(process.env.RN_RUNTIME_DEGRADED_FLOOR_MS),
        `Maestro flow failed: ${msg.slice(0, 500)}`,
        { flowFile, platform, runner: dispatch.runner, passed: false, output: combined.slice(0, 4000) },
      );
      return failResult(failAug.message, failAug.meta);
```

- [ ] **Step 4: Verify the passing path is untouched (no hint on success)**

Run: `grep -n "augmentFailureWithDegradation" src/tools/maestro-run.ts`
Expected: exactly TWO matches — the warn (completed-with-failures) path and the catch path. Confirm NEITHER is inside the `if (passed)` block (the `okResult`/success-with-fallback returns must remain unchanged). This is the structural guarantee that a passing flow never gets a hint.

- [ ] **Step 5: Build + full suite**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail) "`
Expected: 0 fail; count = prior baseline + 11.

- [ ] **Step 6: Add changeset**

Create `.changeset/gh-263-runtime-degraded.md`:
```markdown
---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

`maestro_run` now flags a wedged simulator runtime (GH #263).

When a flow fails AND the median latency of its successful `tapOn` steps exceeds a floor (default 1500ms, `RN_RUNTIME_DEGRADED_FLOOR_MS`), the result gains a `RUNTIME_DEGRADED` hint and `meta.runtimeDegraded` — "the simulator test runtime is likely wedged; reboot it (xcrun simctl shutdown/boot), relaunch, and retry." This replaces the misleading "Element not found" that previously sent the agent chasing app code when the real cause was a degraded simulator (taps reported success but `onPress` never fired). Detection is purely additive — it never changes a pass/fail verdict, never fires on a passing run, and only counts successful taps (a failed tap's duration is the step timeout, which would otherwise false-positive an ordinary element-not-found failure). Fail-open: unparseable output → no hint.
```

- [ ] **Step 7: Commit**

```bash
git add src/tools/maestro-run.ts dist/tools/maestro-run.js .changeset/gh-263-runtime-degraded.md
git commit -m "feat(#263): maestro_run appends RUNTIME_DEGRADED hint on degraded-latency failure"
```

---

## Task 3: Verify + finish

- [ ] **Step 1: Full suite green**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail) "`
Expected: 0 fail.

- [ ] **Step 2: dist parity**

Run: `npm run build && git status --short scripts/cdp-bridge/dist/ | grep -v "^??" || echo "dist in sync"`
Expected: `dist in sync` (the committed dist matches a fresh build).

- [ ] **Step 3: Finish the branch**

Use `superpowers:finishing-a-development-branch` → push `feat/263-runtime-degraded-detection`, open PR `Closes #263`, multi-LLM review (Codex + Antigravity) on the diff, address findings, merge on green.

Note: no live device gate is required — the detector is pure string analysis over already-captured output, fully covered by the fixture-based unit tests (the real format is pinned from existing maestro-error-parser fixtures). A live wedge is non-deterministic to reproduce on demand.

---

## Self-review

**Spec coverage:** signal = median ✓-tapOn latency parsed from captured output (T1 `parseTapLatencies`/`classifyRuntimeDegradation`) ✓; floor 1500 + env override (T1 `resolveFloorMs`) ✓; failure-only + additive hint (T2 two failure sites, Step 4 verifies not in the passed branch) ✓; meta.runtimeDegraded `{medianTapMs,floorMs,sampleCount}` (T1 `augmentFailureWithDegradation`, asserted in test) ✓; fail-open (parse returns [] → not degraded) ✓; ✗-tap false-positive guard (T1 SINGLE_FAILED_TAP test) ✓; tests for parser/median/classify/resolveFloor/integration (T1) ✓.

**Placeholders:** none — every step has concrete code/commands.

**Type consistency:** `RuntimeDegradation` shape (T1) consumed by `formatRuntimeDegradedHint`/`augmentFailureWithDegradation` (T1) and the meta key `runtimeDegraded.medianTapMs` matches the spec and the test assertion; `augmentFailureWithDegradation(output, floorMs, baseMessage, baseMeta)` signature identical at both T2 call sites; `resolveFloorMs` used with `process.env.RN_RUNTIME_DEGRADED_FLOOR_MS` consistently.
