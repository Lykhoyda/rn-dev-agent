# Design — #191: JS-first text entry (`onChangeText` preferred) with post-type verification + native autocorrect suppression

- **Issue:** GH #191 (`kano:must-be`). Split from #189 (secondary items 2 & 3).
- **Date:** 2026-06-08
- **Status:** Approved design (brainstorming) → pending implementation plan
- **Refs:** #189 (origin), `feedback_maestro_patterns.md` item 9, 3-tier interaction model (D497), `runnerTimeoutShim` (CLAUDE.md), #210 (one-coherent-path/self-heal precedent).

---

## 1. Problem

Native text entry on iOS is unreliable, while the JS handler path is robust:

- **`maestro inputText` drops/reorders characters** (predictive-keyboard interaction). An email field receives an invalid value ("Email format is invalid") — characters dropped/reordered.
- **`device_fill` exhausts its entire fallback chain** (pre-tap → primary native type → Pressable→TextInput re-resolve → coordinate re-tap → maestro `inputText`) and the native responder gets wedged for the session. `cdp_interact` press-by-testID keeps working the whole time; only *typing* fails.
- **`cdp_interact typeText`** (calls React `onChangeText` directly via the fiber tree) lands text reliably and is verifiable at the data layer (the input's `value` prop + inner `InternalTextInput` hookState update; validation gates flip).

Root causes (confirmed via code trace, 2026-06-08):

1. **iOS XCUITest `typeText` routes through the software keyboard**; the predictive/autocorrect bar intercepts and rewrites/drops characters (`scripts/rn-fast-runner/.../CommandExecution.swift` `.type`; `Interaction.swift` finders do nothing about autocorrect). The existing `runnerTimeoutShim` (`runners/rn-fast-runner-client.ts:650-659`) only converts a *quiescence timeout* (missing text) into success — it does **not** catch *corrupted* text.
2. **Zero dispatch logic** chooses between the reliable JS path and the fragile native path. `device_fill` (`tools/device-interact.ts:632`) and `cdp_interact` (`tools/interact.ts:21`) are independent tools; `device_fill` is native-first and never tries the working `onChangeText` handler.
3. **No post-type verification** anywhere — corruption passes silently. `getComponentState` (`injected-helpers.ts:1682`) can read `value` but is never called after a fill/type.

## 2. Scope & decision

**Full scope — all three prongs from #191:**

1. **JS-first dispatch** — prefer the JS `onChangeText`/`onChange` handler when a `testID` resolves to one; fall back to native only when there is no JS handler (true native fields) or CDP is unavailable.
2. **Post-type verification** — read the field value back after typing and escalate on a strong corruption signal (not silent pass-through).
3. **Native autocorrect/predictive suppression** at the source + a corrective retype backstop on the residual native path.

**Architecture decision — make `device_fill` itself smart (Approach A).** Not a new tool (B) and not an agent-guidance change (C). Rationale: #191 is a *reliability* failure; approaches that rely on the agent remembering to pick the JS tool reintroduce the stochastic behavior that caused the bug. Putting the smarts at the `device_fill` choke point means **every** caller (composite flows, `cdp_auto_login`, `device_batch`) benefits with no guidance change, and it mirrors the #210 "one coherent path that self-heals internally" direction.

Consequence: `device_fill` becomes the **first `device_*` tool to opportunistically use CDP** while **gracefully degrading** to pure-native when CDP is absent. (Device tools are deliberately CDP-independent today — none take `getClient`. This is a deliberate, documented exception, not a leak of layering.)

## 3. Design

### 3.1 Dispatch (prong 1)

`createDeviceFillHandler(getClient)` — gains a `getClient: () => CDPClient` parameter (matching all `cdp_*` tools). Registered as `createDeviceFillHandler(getClient)` in `index.ts`.

Per-call decision tree:

```
device_fill(ref, text):
  resolve ref → testID         # RN: accessibility id == testID. If ref is a
                               # coordinate / cannot map to a fiber → skip JS, go native.
  if CDP connected:
    r = evaluate(__RN_AGENT.interact({ action:'typeText', testID, text, verify:true }))
    if r.handlerCalled:                     # target (or descendant ≤depth 16) had onChangeText/onChange
        outcome = classifyFillVerification(text, r.valueBefore, r.valueAfter, r.controlled)
        if outcome ∈ {verified-exact, verified-transformed}: return ok(path:'js', verify:outcome)
        # 'corrupted' on the JS path is unexpected → fall through to native (safety net)
  # NATIVE PATH (no JS handler, CDP down, or JS path unverified):
  pre-tap → native type (autocorrect-suppressed)
    if CDP up: read value → classify → if 'corrupted': clear + retype (≤2) → re-verify
    → existing fallback chain (Pressable→TextInput resolve, coordinate retap, maestro inputText),
      each attempt followed by a verify when CDP is up
  return ok(path:'native'|'native-retype'|'maestro', verify) | error TEXT_ENTRY_UNVERIFIED{expected, observed, pathsTried}
```

**Single-evaluate probe+type+verify.** Extend the injected `interact()` typeText branch (`injected-helpers.ts:1125-1302`) to return `{ handlerCalled, handler, controlled, valueBefore, valueAfter }`. When no handler is found it returns `handlerCalled:false` **without firing onChangeText** (no side effect), so `device_fill` can branch to native with no wasted mutation. This keeps the hot path to **one CDP round-trip** (round-trips dominate latency; a separate probe call would double cost).

### 3.2 Verification (prong 2)

Pure, side-effect-free classifier in a new module `tools/fill-verify.ts`:

`classifyFillVerification(text, valueBefore, valueAfter, controlled)` →

| Outcome | Condition | Action |
|---|---|---|
| `verified-exact` | `valueAfter === text` (covers empty-string clears: `text==='' && valueAfter===''`) | success |
| `verified-transformed` | differs but plausible: `valueAfter` non-empty **and** `len(valueAfter) ≥ 0.5·len(text)` (masks/formatters typically make the value *longer*, e.g. `(555) 123`) | success + `meta.verify:'transformed'` |
| `corrupted` | strong drop signal: `valueAfter` empty while `text` non-empty, **or** `len(valueAfter) < 0.5·len(text)` | escalate (retype / native / maestro) |

The single boundary is `0.5·len(text)`: equal → `exact`; non-empty and ≥ half → `transformed`; empty or < half → `corrupted`.

**Stability rule (distinguishes transform from drop).** Char-drop is *non-deterministic* (a different/empty value each attempt); an app-side transform (mask, `maxLength`) is *stable*. So if a clear+retype yields the **same** `valueAfter` as the prior attempt, reclassify as `verified-transformed` and stop — this prevents a legitimate `maxLength<50%` truncation from being mistaken for corruption and retried to exhaustion.
| `unverifiable` | no readable `value` (uncontrolled input with no `value` prop, both fiber and native a11y unreadable) | soft-warn, accept |

**False-escalation guard.** Escalation fires only on a *strong corruption signature* (empty / severely truncated) — exactly the #191 failure — so transforming inputs (phone masks, currency) pass as `verified-transformed` instead of triggering wasteful retries.

**Read-back sources, in order:** (1) controlled fiber `value` prop (the real, *unmasked* string even for secure fields — masking is display-only, so secure controlled inputs **are** verifiable); (2) native accessibility `value` from a `device_snapshot` of the field (note: masked for secure fields → not authoritative there); (3) none → `unverifiable`. A fill must never *error* merely because we could not *prove* it.

### 3.3 Native suppression (prong 3)

Two layers on the residual native path (true native fields / CDP-down):

- **Preventive (source):** best-effort disable of iOS keyboard autocorrect/predictive/spell-check at iOS session open (candidate location: the `device_snapshot action=open` path near `runners/ensure-single-runner.ts`), via `xcrun simctl spawn <udid> defaults write` on the keyboard preference domain(s). **Marked for live validation** — the exact domain/keys and whether a keyboard reset is required are device-specific and will be confirmed on a booted simulator during implementation. Never blocks session open on failure (fail-open, logged).
- **Corrective (the guarantee):** the prong-2 read-back drives a bounded **clear + retype** (≤2 attempts) when corruption is detected, optionally enabling the Swift per-character `delayMs` path (`CommandExecution.swift:469-479`, currently dead because `buildRunIOSArgs` never sends `delayMs`) to reduce predictive batch-rewrite.

The corrective backstop is what makes the native path *reliable*; the preventive layer reduces how often it is hit.

## 4. Behavior model (paths & `meta`)

- `meta.textEntryPath`: `'js' | 'native' | 'native-retype' | 'maestro'`
- `meta.verify`: `'exact' | 'transformed' | 'unverifiable'` (absent when CDP down / not attempted)
- `meta.timings_ms`: `{ resolve, jsType, verify, nativeType, retype }` (per CLAUDE.md instrumentation convention)
- On success, the result is shape-compatible with today's `device_fill` result (additive `meta` only) — no breaking change for existing callers.

## 5. Error handling / edge cases

- **CDP probe/evaluate failure** → silent degrade to native (a CDP hiccup must never block a fill).
- **`TEXT_ENTRY_UNVERIFIED { expected, observed, pathsTried }`** — new typed error, emitted only when every path is exhausted and the field is still `corrupted`.
- **Empty-string fill (clear)** — `text=''` → `valueAfter===''` → `verified-exact`.
- **Transforming inputs (mask/format/`maxLength`)** — `verified-transformed`, no escalation; the stability rule (§3.2) ensures a `maxLength<50%` truncation converges instead of retrying to exhaustion.
- **Uncontrolled inputs** (no `value` prop) — `unverifiable` soft-warn.
- **Secure (password) controlled inputs** — fiber `value` is the real string → verifiable via source (1); native a11y is masked (not used as authority).
- **`device_batch` multi-field** — each fill independently JS-first; one field's path choice does not affect another.
- **Non-RN / coordinate `ref`** — JS probe skipped, native path with verification-if-CDP-up.

## 6. Testing (TDD, red → green per unit)

- **Pure** — `classifyFillVerification` table tests: exact, empty-clear, transformed (mask), corrupted (empty + <50% truncation), unverifiable (null value). 100% branch coverage.
- **Dispatch** — mock `getClient`/`evaluate`: JS path taken when `handlerCalled:true`; native path when `handlerCalled:false`, when CDP throws/disconnected, and when `ref` is a coordinate. Assert `meta.textEntryPath`.
- **Injected helper** — `handlerCalled:false` produces **no side effect** (onChangeText not fired); value read-back shape `{valueBefore, valueAfter, controlled}`; helpers **version bump** guard (helpers are versioned for freshness checks).
- **Regression** — existing `test/unit/device-interact.test.js` (`findInputForPressable`, `buildAdbInputTextArgv`, chunking) and `issue-126-typetext-walkdown.test.js` stay green.
- **Live (both platforms)** — iOS simulator + Android emulator end-to-end on a real controlled input (the quick-add task sheet from the #191 benchmark): JS path verified-exact; force a native field to exercise native-retype; validate the prong-3 sim keyboard-pref disable actually suppresses the predictive bar.

## 7. Files touched

| File | Change |
|---|---|
| `scripts/cdp-bridge/src/injected-helpers.ts` | Extend `interact()` typeText to return `{handlerCalled, handler, controlled, valueBefore, valueAfter}`; no-op (no fire) when no handler. Helpers version bump. |
| `scripts/cdp-bridge/src/tools/device-interact.ts` | `createDeviceFillHandler(getClient)`; JS-first branch; native read-back + bounded clear/retype; `meta` instrumentation. |
| `scripts/cdp-bridge/src/tools/fill-verify.ts` *(new)* | Pure `classifyFillVerification(...)`. |
| `scripts/cdp-bridge/src/runners/ensure-single-runner.ts` (or session-open path) | Best-effort iOS keyboard autocorrect/predictive suppression (fail-open). |
| `scripts/cdp-bridge/src/agent-device-wrapper.ts` | Allow `delayMs` through `buildRunIOSArgs` for the corrective native retype. |
| `scripts/cdp-bridge/src/index.ts` | Register `createDeviceFillHandler(getClient)`. |
| `scripts/cdp-bridge/test/unit/*` | New tests per §6. |
| `.changeset/*` | Changeset (patch/minor — behavior-additive, new error code). |

## 8. Explicitly rejected

- **New `device_fill_smart` tool / extend only `cdp_interact` (Approach B)** — splits the text-entry surface; existing `device_fill` callers and composite flows don't benefit; adds MCP surface against the "one coherent path" direction.
- **Guidance-only (Approach C)** — relies on the LLM remembering to pick the JS path; reintroduces the exact stochastic failure #191 cites.
- **Removing the maestro `inputText` last-resort** — kept as the final native safety net (rarely hit once JS-first lands).
- **Strict-equality verification** — rejected: false-escalates on legitimate masks/formatters; replaced by the strong-corruption-signature rule.

## 9. Deferred / open

- **Exact `simctl` keyboard-pref keys + reboot requirement** — resolved during implementation via live sim validation (fail-open until confirmed).
- **Android native predictive-keyboard suppression** — JS-first covers Android RN inputs too; native-Android source-suppression deferred unless live testing shows drops on the adb `input text` path.
- **Secure-field native-path verification** — accepted as `unverifiable` when only the masked native a11y value is available (the controlled fiber `value` still verifies the common case).
