# Story 05 — Self-healing taps: inline re-resolution + retry-if-no-change

**Status:** Implemented (2026-07-04, #386)
**Epic:** [Maestro adoption](README.md)
**Impact:** Converts most `STALE_REF` refusals (a full agent round-trip: error → re-snapshot → re-find → retry) into a transparent in-tool repair; adds change-detection so a swallowed tap retries itself once
**Effort:** M
**Depends on:** Story 04 (settle engine provides the fresh snapshot + change hash)

## Problem

Our `@ref` resolution is **passive** about staleness: refs resolve to cached coordinates gated on `isRefMapFresh()`; a stale ref returns a structured `STALE_REF` failResult with a "re-snapshot" hint (`agent-device-wrapper.ts:283-307`, `rn-fast-runner-client.ts:684-697`). Correct, but every occurrence costs the agent a full round-trip (~3 tool calls), and refs go stale on *every* screen mutation. Separately, a tap that lands but is swallowed (wedged runtime, mid-transition target) reports success with no verification that anything changed — the wedged-simulator spec (2026-06-14-263) documents taps "succeeding" while `onPress` never fires.

## What Maestro does

Two mechanisms, both host-side (`maestro-client/.../Maestro.kt`):

1. **Re-resolve before every tap.** `tap()` settles, then `hierarchyBeforeTap.refreshElement(element.treeNode)` re-binds the stored element to the live tree by matching **all attributes except bounds**, requiring a **unique** match, and taps the recomputed center (`Maestro.kt:205-214`; `ViewHierarchy.kt:52-63`). Recorded/stale coordinates self-heal; ambiguity falls through to normal lookup.
2. **Retry-if-no-change.** `hierarchyBasedTap` snapshots before, taps, settles, compares: if the hierarchy is unchanged, the tap is presumed swallowed and retried (2 attempts total, `Maestro.kt:286-346`). An optional `waitUntilVisible` path polls 10×1 s and re-taps (`:225-244`). "Visible" is a real hit-test: the element must be top-most at its own center (`ViewHierarchy.isVisible`/`getElementAt`, reverse z-order walk, `ViewHierarchy.kt:40-95`).

## Design

### Identity signatures in the ref-map

Extend `fast-runner-ref-map.ts`: alongside coordinates, store a per-ref **identity signature** captured at snapshot time:

```ts
type RefSignature = { testID?: string; label?: string; role?: string; text?: string; indexPath: number[] };
```

### `refreshRef()` — the re-resolution primitive

New pure function in `fast-runner-ref-map.ts` (unit-testable against fixture node lists):

```ts
refreshRef(sig: RefSignature, nodes: FlatNode[]):
  | { kind: 'unique'; node: FlatNode }          // exactly one attrs-minus-bounds match
  | { kind: 'ambiguous'; candidates: FlatNode[] } // >1 match → keep STALE_REF, list candidates
  | { kind: 'absent' }                            // 0 matches → STALE_REF (element truly gone)
```

Matching rule (Maestro's): compare `testID`/`label`/`role`/`text` exactly, ignore bounds. `indexPath` is a tie-breaker only when everything else matches multiply *and* the tree shape is unchanged — never a primary key (index shifts are exactly what drift looks like).

### Tap pipeline changes (`agent-device-wrapper.ts` / `device-interact.ts`)

For `press`/`longpress`/`fill`-tap on a `@ref`:

1. Ref fresh → tap cached center (today's fast path, unchanged).
2. Ref stale → **do not fail**: take/reuse a snapshot (settle engine refreshes it anyway), `refreshRef()`:
   - `unique` → tap the recomputed center; return success with `meta.reResolved: true` (telemetry for how often this saves a round-trip).
   - `ambiguous`/`absent` → today's `STALE_REF` failResult, now enriched with `candidates` so the agent can disambiguate in **one** follow-up instead of a blind re-snapshot.
3. Post-tap: `waitForSettle` returns the post-hash (Story 04). If `hierarchyChanged === false` and the caller didn't opt out (`retryIfNoChange: true` default, Maestro's default) → **one** re-tap, then report `meta.tapRetried: true`. If still unchanged → success:false is wrong (the tap may legitimately be a no-op) — return success with `meta.noUiChange: true` so the agent/verifier can decide. This flag is also the cheap detector for the wedged-runtime condition (spec 2026-06-14-263): N consecutive `noUiChange` results → surface the degraded-runtime hint proactively.

### Keep the boundary honest

`device_batch` already re-resolves per step via fresh fiber snapshots (README:151) — align it on the same `refreshRef` so JS-path and native-path resolution share one matcher.

## Implementation steps

1. `RefSignature` capture in snapshot mapping (`mapRunnerNodesToFlat` → ref-map insert).
2. `refreshRef()` + exhaustive unit tests (unique/ambiguous/absent, text-changed-but-testID-same, testID-changed-but-text-same, index-shift traps).
3. Pipeline wiring for press/longpress/fill; `meta.reResolved`/`tapRetried`/`noUiChange`; `STALE_REF` payload enrichment with candidates.
4. Wedged-runtime counter (in-memory, per session): 3 consecutive `noUiChange` on distinct targets → `meta.hint` referencing the degraded-runtime recovery from spec 263.

## Acceptance criteria

- Scenario: snapshot → tap a button that re-renders the list → tap a second `@ref` from the *original* snapshot. Today: `STALE_REF`. After: succeeds with `meta.reResolved: true` when the element's identity is unique; total tool calls for the flow drops from 5 to 2.
- Ambiguous re-resolution (two nodes share testID+label) → `STALE_REF` with both candidates listed — never a guess-tap (correctness over convenience; a wrong tap is worse than a refusal).
- Swallowed tap on the fixture (target disabled mid-transition) → exactly one automatic retry, then `meta.noUiChange: true`; never an infinite loop.
- `reResolved` rate visible in observe UI / session telemetry.

## Test plan

- Unit: matcher matrix above; retry budget (exactly 2 attempts); flag surfacing.
- Integration: fake-runner scripted sequences (tap → unchanged hash → retap → changed hash).
- Live: scripted TaskWizard mutation flow measuring STALE_REF count before/after (expected: near-zero on the happy path).

## Risks & open questions

- **Guess-tap risk** is the real safety concern — mitigated by the unique-match requirement (Maestro's rule) and by never falling back to index-only matching.
- **Snapshot cost on the stale path:** bounded — Story 04's settle already produces a fresh snapshot for mutating flows; the re-resolve reuses it (GH#321 cache).
- **Interaction with the repair engine (Story 07/11):** `refreshRef` heals *runtime* staleness; the Levenshtein repair engine heals *recorded-action* drift. Same idea, different lifetimes — keep them separate implementations with a shared "match by identity attrs" helper if convenient, but do not merge policies (repair has budgets/refusal semantics that live taps must not inherit).
