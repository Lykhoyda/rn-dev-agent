# RNTL-style selector resolver + durable Maestro projector

- **Date:** 2026-06-19
- **Status:** Approved design (brainstorming complete; awaiting spec review → writing-plans)
- **Goal axes (locked):** (1) **selection precision** — reliably target UI elements *including those with no testID*; (2) **replay durability** — saved Maestro flows survive UI drift (renamed testIDs, etc.). Perception-cost / token reduction is **out of scope**.
- **Approach:** "Reshaped A + relative tier" — extend the existing injected fiber-walk matcher into an RNTL-style discovery ladder that emits a **selector bundle**, projected to Maestro YAML through a **fail-closed, CONTAINS-aware, TS-owned-gated** fallback ladder, with **bundle-aware self-heal**.
- **Reuses:** React Native Testing Library v14 (MIT) query/matcher *algorithms*; maestro-runner (`pkg/flow/selector.go`) per-platform selector *matrix data*; existing `injected-helpers.ts` fiber walk, `maestro-generate.ts` projector, `repair-engine.ts`.
- **Validation:** Codex adversarial debate (approach selection) + a 6-agent hardening pass (2026-06-19) grounded in all three repos; the CONTAINS verdict and two Section-1 corrections below come from that pass.
- **Tracking issue:** to be filed after spec review.

## 1. Problem

The agent selects elements two ways today, and both are narrow:

- **Discovery / live interaction** — the injected fiber walker (`scripts/cdp-bridge/src/injected-helpers.ts`, `interact()` ~1096-1218) matches by **only `testID` or `accessibilityLabel`**. Elements without a testID are reachable only by a brittle label/text path, and the matcher **silently picks the first hit** (testID path early-returns at :1130-1133) and **fires `onPress` on hidden elements** (:1213-1218, no visibility filter).
- **Replay / persistence** — saved actions are Maestro YAML; the projector (`tools/maestro-generate.ts`) emits **only `id:`/`text:`** with **no platform gating and no fail-closed ladder**, and **silently drops** a step when it can't form a selector (`[]` returns at :50,59,64,79,88). Self-heal (`domain/repair-engine.ts`) **only heals `id:` selectors** (`extractIdSelectors` :237, `attemptRepair` gate :308), so a no-testID element gets *zero* durable repair.

Net: the agent can't reliably **find** un-testID'd elements, can't reliably **persist** them as a durable selector, and **fails silently** in several places (wrong-element press, dropped step, no-op repair). We want precise, fail-closed discovery and durable, fail-closed replay — reusing existing machinery rather than building a parallel engine.

## 2. Goals / non-goals

**Goals**
- A **user-centric discovery ladder** on the live fiber tree: `byRole(+name)`, `byText`, `byPlaceholder` (plus existing `byTestId`/`byLabel`), with RNTL matching semantics.
- The resolver **never silent-picks**: ambiguity and traversal-truncation are **fail-closed** structured errors.
- Hidden/inaccessible elements are **excluded by default**.
- Every match yields a **selector bundle** that the projector turns into the most durable Maestro selector available, via a **fail-closed fallback ladder** that is **CONTAINS-aware** and **platform-gated in TS**.
- **Bundle-aware self-heal**: a saved action re-resolves from the bundle's richer fields when a selector breaks (e.g. testID rename), with no source edit.

**Non-goals (explicitly deferred)**
- `byDisplayValue`, accessibility `state`/`value` *as selectors* (capture `disabled` into the bundle only).
- A runtime gate inside maestro-runner (it would require forking the runner; see §3).
- Cross-machine/team selector sharing.
- The **missing-testID advisory report** is kept as an *optional, low-priority* output (aligns with `creating-actions` "add a testID at source"); it is **not load-bearing** now that the relative tier exists, and is easy to cut.

## 3. Key constraints (why the architecture is shaped this way)

These are the grounded facts from the hardening pass; each one shapes a design choice.

- **Native text matching is CONTAINS, not EXACT.** *Verified.* On every replay path except WDA's tap-only exact probe, the runner matches case-insensitive substring: iOS `label CONTAINS[c] … OR name CONTAINS[c] … OR value CONTAINS[c]` (`maestro-runner/pkg/driver/wda/driver.go:543`); Android `textContains/descriptionContains/hintContains` with a source comment that exact-first *was tried and reverted* because it broke tab-label-with-count flows (`devicelab/driver.go:990-1003`). Native has **no exact-text primitive** (`textRegex ^…$` is web-only, `selector.go:345`). → The projector's "unique text" rung must be **CONTAINS-unique against the UNION of OR'd native fields** (Android `text/contentDesc/hint`; iOS `label/name/value/placeholder`), not exact-unique.
- **maestro-runner's selector gate is advisory, not enforcing.** *Verified.* `CheckUnsupportedFields` logs `"… will be ignored"` and proceeds at every call site (`wda/driver.go:421-428`, `uiautomator2/driver.go:303`, `cli/test.go:1043-1069`); the runner **silently drops** an unsupported field and matches on what remains. → The **hard gate must live entirely in the TS projector** (copy the matrix data verbatim, *refuse to emit*), kept in sync by a checksum/byte-identity test. We reuse the matrix *data*, not the runner's enforcement.
- **The runner resolves multiplicity by silent first/deepest pick.** *Verified* (`uiautomator2/pagesource.go:521-557`). The runner will never signal ambiguity, so **uniqueness must be decided at projection time**, never delegated to replay.
- **RNTL helpers assume the react-test-renderer tree, not live fibers.** RNTL hardcodes host type strings (`host-component-names.ts:14-40`) and walks `instance.parent`/`instance.children`; live fibers use `.return`/`.child`/`.sibling`, `memoizedProps`, and per-renderer host names, with no in-page `StyleSheet.flatten`. → "Port `computeAccessibleName`/`getRole`/`isHidden`" means **port the algorithm against a fiber→host adapter**, *not* copy the file. This shim is the real work.
- **The matcher path does not use the snapshot cache.** The `device_find` snapshot cache (`agent-device-wrapper.ts`) is on a different code path; `interact()` walks live fibers per call. The RNTL ladder visits far more host nodes than a testID compare, and accessible-name is O(subtree) per candidate → budget pressure (see §9).
- **Maestro executes a YAML file; the bundle is metadata.** The bundle must persist in the **sidecar state JSON**, not inline YAML (inline collides with the M7 header parser and bloats the executed flow).
- **Bundle coverage is partial by construction.** Only the recorder / save-as-action path (a live fiber walk) can populate a bundle; `maestro_generate` (no device) and hand-authored actions cannot. Those keep the legacy id-only heal.

## 4. Architecture — two phases + self-heal

```
DISCOVERY (live fiber tree, in-app injected JS)          REPLAY DURABILITY (host TS)
  selector spec {role?,name?,text?,placeholder?,            selector bundle
    testID?, exact?, matcher:{kind:'regex',…}?}                  │
        │                                                        ▼
   fiber→host adapter                                   Projector (fail-closed ladder)
   matches() + computeAccessibleName + getRole              id
   + isHidden  (ported RNTL algorithms)                     › CONTAINS-unique text
        │  fail-closed: truncation / ambiguity / hidden      › text + insideOf/childOf (anchor)
        ▼                                                     › text + index (brittle flag)
   match + SELECTOR BUNDLE ───────────────────────────►      › fail-closed: "add a testID"
   {testID,text,accessibleName,role,placeholder,            (each rung TS-platform-gated;
    disabled,bounds,anchors[]}                                scalars via isSafeMaestroScalar)
        │                                                        │
        └── persisted in sidecar state JSON ◄────── bundle ──────┘
                                   │
                                   ▼
                       SELF-HEAL (replay not-found)
                       bundle-aware re-resolve → re-project → re-gate
                       refuse on low-confidence / structural drift
```

**Units** (each: one purpose, a clear interface, a named dependency):

| Unit | Purpose | Reuse / New |
|---|---|---|
| `matches` | text match: string \| tagged-regex + normalizer | **copy** RNTL `matches.ts` (algorithm) |
| fiber→host adapter | normalize per-renderer host names (Text/TextInput/Switch/Image), host-only children, `.return` walk, `StyleSheet`-free `display:none` | **new** (the real shim) |
| a11y semantics | `computeAccessibleName` / `getRole` / `isHidden` / `disabled` over the adapter | **port** RNTL `accessibility.ts` + `find-all.ts` algorithm |
| Resolver | the ladder over the fiber walk; fail-closed; emits bundle | **extend** `interact()` |
| Selector bundle | durable record of one match | **new** versioned type in `reusable-action.ts` |
| Platform matrix | what each platform can replay; **errors** in TS | **copy** maestro-runner `selector.go` data + drift test |
| Projector | bundle → Maestro YAML via CONTAINS-aware fallback ladder | **extend** `maestro-generate.ts` |
| Self-heal | bundle-aware re-resolve + re-emit + re-gate | **extend** `repair-engine.ts` |
| *(opt)* missing-testID report | flag actionable nodes lacking a testID | new, low-priority |

## 5. Phase 1 — discovery resolver

**Selector spec** accepted by `cdp_interact` / `device_find`:
`{ testID?, role?, name?, text?, placeholder?, exact?, includeHidden?, matcher?: { kind:'regex', source, flags } }`.

**Engine (ported against the adapter):**
- `matches(matcher, text, normalizer, exact)` — string `exact===true` is full-string equality on the normalizer output; `exact===false` is case-insensitive substring. **The ported normalizer trims + collapses whitespace but does NOT lowercase** (RNTL `matches.ts:37-44`), unlike the existing injected `norm()` (`injected-helpers.ts:1115`); the two must never silently merge.
- `computeAccessibleName` replicates the six RNTL edge cases the digest's `collectText` cannot: `accessibilityLabelledBy`/`aria-labelledby` nativeID-ref resolution (container-wide find), `aria-label`/`accessibilityLabel` precedence, image `alt`, placeholder-as-name *only at root*, recursive child name accumulation, and inline-text join (`''` vs `' '` so `Sign`+`In` → `SignIn`).
- `getRole` returns explicit `role`/`accessibilityRole`, host `Text`→`text`, else `none` (**not** the digest's `inferRole` `button` default).
- `isHidden` excludes by default (`aria-hidden`, `accessibilityElementsHidden`, `importantForAccessibility==='no-hide-descendants'`, flattened `display:'none'`, `aria-modal` siblings), walking `.return`.

**Fail-closed invariants:**
1. **Truncation** — replace `if (findCount > 8000) return;` (`:1126`) with a budget that scales by `rootsSeeded` + a wall-clock guard (digest pattern `:400/:406`); on trip, set `truncated:true` and return a **structured truncation error** distinct from no-match. Never run the multiplicity check, return "not found", or `tier[0]`-pick on a partial set.
2. **Multiplicity** — collect-all-then-count on **every** ladder tier (RNTL `getAllBy` throws on >1); >1 after hidden-filter + cross-renderer dedupe (WeakSet visited-guard) → return the `Ambiguous component match` shape enriched with bundle descriptors. The testID fast early-return is allowed **only** when the caller explicitly passes `testID`.
3. **Hidden** — exclude before counting and before `onPress`.
4. **Regex** — carried as a tagged `{kind:'regex',source,flags}` (a bare `RegExp` is dropped to `{}` by `JSON.stringify` at the CDP boundary, `interact.ts:52`); reconstructed in-page in try/catch (fail-closed on bad pattern), `lastIndex` reset, `/g` stripped, candidate text length-capped (ReDoS).
5. **byText leaf → pressable** — a matched host-Text leaf with no `onPress` walks `.return` to the nearest pressable (bounded), recording both in the bundle; fail-closed if none.
6. **Overlay roots** (LogBox/RedBox) skipped by default.

**Unified engine:** the salient digest must call the **same** `computeAccessibleName`/`getRole` as the resolver (or mark `digest.text` as a non-matchable preview), so the agent never perceives `{role:'button',text:'Add'}` and then fails `byRole('button')`/`byText('Add')` under RNTL semantics.

**Selector bundle** (output of a match): `{ testID?, text?, accessibleName?, role?, placeholder?, disabled?, bounds?, anchors?: Anchor[] }` where `Anchor = { testID? | text, relation:'childOf'|'insideOf'|'below'|…, depth, bounds, provenance:'authored-testID'|'text'|'geometric' }`, captured via a bounded `.return` ancestor walk (reuse `setFieldValue`'s pattern ~:1438-1451), nearest-first.

## 6. Phase 2 — durable projector

`project(bundle, platform) → MaestroSelector | FailClosedError`. **`platform` is required (no default).** Ladder, top-down, each rung TS-platform-gated:

1. **`id`** (bundle.testID) — always preferred; lossless across runner, CLI, CDP-replay.
2. **CONTAINS-unique text** — emit `text:`/`accessibleName:` **only if** the captured string is **not a case-insensitive substring** of any other element's `UNION(text, accessibilityLabel/contentDesc, value, placeholder/hint)` in the captured tree. Else drop.
3. **Anchored containment** — `text + insideOf/childOf/below`, emitted **only when the anchor is a user-authored container testID** (resolved by id, exact, single) or a CONTAINS-unique container text. A `VirtualizedList`/`ScrollView` ancestor detected at capture **downgrades/flags** a recycled-cell or geometric anchor as brittle. Prefer `childOf` (full-bounds) for true parent/child; `insideOf` (center-containment) for visual overlap.
4. **`text + index`** — emitted with `brittle:true` (positional against page-source order, not stable).
5. **Fail-closed** — structured error with hint `"add a testID"`. **Replaces today's silent `[]` drops** (`maestro-generate.ts:50,59,64,79,88`).

**Platform gate (TS-owned):** copy `selector.go:321-348` `platformSupportedFields` verbatim into TS; a byte-identity/checksum test fails CI on drift. Reject at projection: `role`/`placeholder`/`testId`/`textRegex` on iOS or Android; `checked` on iOS; relative selectors on web. The runner will *not* enforce this — the TS projector is the only gate.

**Scalar safety:** every emitted scalar (text, accessibleName, placeholder, anchor text) is on-screen-derived and attacker-influenceable; route through `buildMaestroFlow` + `isSafeMaestroScalar` (reject CR/LF, `---`, control chars), never string-concat the `insideOf/childOf` composition. Applies at projection **and** self-heal re-emit.

## 7. Self-heal — bundle-aware repair

Extend `repair-engine.ts` so that, on replay not-found for a non-id step **with a bundle present**:
- re-resolve against the live snapshot using the ported `matches`/`computeAccessibleName`/`getRole` over the bundle's richer fields (not Levenshtein on the stale id),
- re-emit through the projector ladder **+ platform gate** (so a heal never introduces a platform-invalid field), replacing the whole step block,
- preserve `isSafeMaestroScalar` on every re-emitted scalar.

Keep the existing id→id Levenshtein path as the **no-bundle fallback** (back-compat). **Refuse** (don't patch to a different element) on: low confidence, disagreeing fields (accessibleName matches one node, anchors another), or structural drift (all richer fields stale together) — cap attempts and **escalate to a human-actionable artifact** (screenshot + candidate set + testID snippet) rather than looping. Apply a deterministic field precedence: `testID > accessibleName+role > anchored text > text`. Extend `RepairRecord.diff` to represent a **selector-kind transition** (id → `text+insideOf` block), preserving the `{from,to}` string pair for id-only repairs.

## 8. Persistence — selector bundle

- Bundle lives in the **sidecar state JSON** (`ActionRuntimeState`), keyed by current selector string — **not** inline YAML (collides with `parseM7Header`, `reusable-action.ts:487-534`).
- `schemaVersion` becomes a `1 | 2` union; `loadOrInitSidecar` accepts both with **lazy v1→v2 migration** (proven lossless by test). A v1 sidecar with no bundle behaves exactly as today (legacy id-only heal).
- A **versioned discriminated `SelectorBundle`** (`bundleVersion`, optional fields grouped primary / accessibility / content / state / geometry / anchors) records *which tiers are populated* — every field except `testID` is fallible.
- `RecordedEvent` (`test-recorder-generators.ts:125-136`, today testID/label/value/direction only) is **widened to carry the captured bundle**, injected in save-as-action before `pairWrite`. Coverage is partial by construction (recorder only).

## 9. Error handling (fail-closed everywhere)

| Component | Condition | Behavior |
|---|---|---|
| Resolver | budget / wall-clock exceeded mid-walk | `truncated:true` + structured error; no ambiguity check / no "not found" / no `tier[0]` on partial set; distinct TRUNCATED status so repair refuses rather than burning budget |
| Resolver | >1 match after hidden-filter (any tier) | `Ambiguous` error + bundle descriptors + "add a testID"; collect-all-then-count; no first-hit early-return unless explicit `testID` |
| Resolver | candidate / `.return` ancestor hidden | exclude before counting & before `onPress`; `includeHidden` opt |
| Resolver | byText leaf without `onPress` | walk `.return` to nearest pressable (bounded); fail-closed if none |
| Resolver | regex across CDP boundary | tagged `{kind,source,flags}`; in-page try/catch fail-closed; `lastIndex` reset; strip `/g`; length-cap |
| Projector | field unsupported on target platform | hard-fail in TS, drop to next rung; require explicit `platform` |
| Projector | bare text/name rung | emit only if CONTAINS-unique vs OR'd field union; else anchor or id |
| Projector | no durable rung exists | structured error "add a testID" (replace silent `[]`) |
| Projector | any emitted scalar | `buildMaestroFlow` + `isSafeMaestroScalar`; reject CR/LF/`---`; at projection **and** re-emit |
| Self-heal | non-id step fails, bundle present | re-resolve from bundle, re-emit through ladder + gate; keep id→id Levenshtein when no bundle |
| Self-heal | low-confidence / fields disagree / drift | refuse; cap attempts; escalate to human artifact; never loop or silent no-op |

## 10. Testing strategy & TDD sequence

**Dependency-ordered, RED-first on the behaviors shipped code gets wrong today** (the silent 8000-cap and the no-op non-id repair):

1. `matches()` port + `getDefaultNormalizer` (leaf, no deps) — 6 cases incl. the **no-lowercase divergence guard** vs the existing `norm()`.
2. `computeAccessibleName` (+`computeAriaLabel`/`getAriaLabelledByIds`/`joinAccessibleNameParts`) — 8 precedence cases (labelledBy-first; placeholder only at root; alt; inline join `SignIn`).
3. `getRole` + `normalizeRole` — 5 cases + the **Pressable→`none` divergence guard** (catches re-faking via `inferRole`).
4. `isHidden` — 9 cases incl. nested child of `aria-hidden` ancestor; `opacity:0`→visible; WeakMap cache.
5. **Resolver ladder** in `interact()` — write the **truncation test RED first**, then byRole/byText/byPlaceholder, ambiguity (fail-closed), bundle/anchors. Prerequisite spike: the **fiber→host adapter**.
6. **Projector ladder** — rungs top-down; write the **fail-closed terminal RED before any fallback**; CONTAINS-aware rung-2 validation against the OR'd union.
7. **Platform gating errors** — `ios-checked` and `web-relative` cases RED first; byte-identity/checksum test vs `selector.go`.
8. **Bundle-aware self-heal** — lock the id→id regression GREEN first, then fail-closed RED, then fall-forward; composes 5+6+7.
9. **Integration** (live `com.rndevagent.testapp`, gated/skipped in CI): `byRole('button',{name:'Go to Dashboard'})`→`go-to-dashboard`; `role:'tab'`+name→`tab-tasks`; a non-unique row text → projector emits `text + insideOf(real row testID)`; a duplicate-no-testID screen → fail-closed Ambiguous; a **CONTAINS-uniqueness** case (exact-unique but substring of a sibling) → projector refuses bare text; **replay-after-rename** durability round-trip.
10. **Source-drift guards** shipped in the same commit as each port (CI fails if name/role is re-faked or the silent 8000-cap returns).

## 11. Success criteria

- Resolve every interactive element in the test app by role/name/text **including un-testID'd** ones.
- A saved action **replays after a testID rename** via bundle-aware self-heal, no source edit.
- The resolver **never silent-picks**: truncation → `{truncated:true}`+hint; >1 match → `Ambiguous` with descriptors (proven by a >8000-node test and a two-`Continue` test).
- Hidden elements **excluded by default** (a `display:none`/`aria-hidden`/off-screen-modal `Continue` is neither counted nor pressed).
- The projector **never emits a platform-invalid field** (byte-identical to `selector.go`; drift test) and **never drops a step silently**.
- The "unique text" rung is **CONTAINS-unique** vs the OR'd native field union (verified on a live screen).
- `computeAccessibleName`/`getRole` parity with RNTL **on real device fibers** (Fabric+Paper, iOS+Android), proven by live tests — synthetic-fiber unit tests can pass while device host-type detection is wrong.
- Every emitted scalar passes `isSafeMaestroScalar` at projection **and** re-emit (hostile CRLF/`---`/`- launchApp` label is refused).
- **Back-compat**: a v1 sidecar with no bundle loads losslessly and heals via the legacy id-only path.

## 12. Residual risks (accepted)

- **[HIGH] Fail-open at the trust boundary.** The TS gate is bypassable (hand-edited YAML, the legacy string path, a self-heal that skips re-gating); the runner won't catch a web-only field on a native flow (silent drop → wrong tap + a buried log). A true runtime gate would require forking maestro-runner (warning→error), breaking every flow that relies on graceful field-ignore — out of scope. **Mitigation is discipline (single projector chokepoint + matrix checksum test), not enforcement.**
- **[HIGH] Cross-platform accessible-name divergence.** `bundle.accessibleName` is computed from JS fiber state at capture but matched against iOS XCUITest AX label / Android content-desc at replay (different engines, whitespace, ordering). One `accessibleName` field can't represent both; an iOS-captured flow can fail silently on Android. **This bounds the cross-platform-durability premise** — fully durable only for `id` + stable-testID anchoring. Platform-qualifying the name or validating against a live snapshot before persist only partially mitigates.
- **[MED]** CONTAINS re-widening if the replay screen changed since capture · anchor instability on virtualized lists (recycled/reordered cells make anchored containment *less* durable than unique text) · O(subtree) name-compute perf, uncached on the interact() path → legitimate targets on large screens may return TRUNCATED and force re-scope · self-heal dead-end on genuine structural drift (the source edit is unavailable in CI) · widened prompt-injection surface (on-screen text round-trips through planning context and into YAML).
- **[LOW]** `disabled`/`checked` state lag and `checked` being iOS-unsupported · v1→v2 sidecar migration must be proven lossless · actions authored via `maestro_generate`/by hand never get bundles (legacy heal forever unless back-filled on first live replay).

## 13. Reuse map

| Source | Action | Notes |
|---|---|---|
| RNTL `src/matches.ts` | copy algorithm | dependency-free; carry regex as tagged object, not `RegExp` |
| RNTL `src/helpers/accessibility.ts`, `find-all.ts` | **port** algorithm against the fiber→host adapter | NOT a file copy — host names + tree shape differ on live fibers |
| maestro-runner `pkg/flow/selector.go` | copy the platform matrix **data** | enforce in TS; the runner gate is advisory only |
| `injected-helpers.ts` `interact()` + digest `inferRole`/`collectText` | extend / unify | replace `inferRole`/`collectText` with the ported engine |
| `tools/maestro-generate.ts` | extend into the fail-closed ladder | replace silent `[]` drops |
| `domain/repair-engine.ts` | extend to bundle-aware | keep id→id as no-bundle fallback |
| `reusable-action.ts` / sidecar | new versioned `SelectorBundle`, v1→v2 migration | bundle in sidecar, not YAML |
