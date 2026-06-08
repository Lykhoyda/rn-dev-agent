# #191 — JS-first text entry + post-type verification + native autocorrect suppression — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `device_fill` reliable on iOS by preferring the deterministic React `onChangeText` path, verifying the field value after every fill, and adding both a corrective clear/retype backstop and a preventive predictive-keyboard suppression on the residual native path.

**Architecture:** `device_fill` becomes the smart choke point (Approach A from the spec). It gains an opportunistic `getClient` and, when CDP is connected and the ref maps to a testID, fires the React `onChangeText`/`onChange` handler directly via the injected `__RN_AGENT.interact()` helper (deterministic — no software keyboard, no predictive bar). It then reads the field value back via a *settle-poll* of CDP evaluates (Hermes has no `awaitPromise`, and `onChangeText` may be debounced, so we poll until the controlled re-render flushes), classifies the result with a pure verifier, and — on the native fallback — runs a bounded clear+retype (using the runner's real `clearFirst`) when corruption is detected. A best-effort `simctl` keyboard-preference write at iOS session-open reduces how often the native path is hit. CDP-absent → pure-native with graceful degrade; a fill never *errors* merely because we could not *prove* it.

**Tech Stack:** TypeScript (Node ≥ 22, `tsc` build), Hermes CDP over WebSocket, in-tree `rn-fast-runner` (Swift XCTest) for iOS native interaction, `agent-device` CLI for Android, `node:test` unit harness (tests import compiled `dist/`).

**Source spec:** `docs/superpowers/specs/2026-06-08-gh191-text-input-jsfirst-design.md`

---

## Amendments applied from the multi-LLM plan review (2026-06-08)

Codex + Gemini reviewed the first draft of this plan against source before any code. All findings below were **verified against the actual code** and folded in. (Performative agreement omitted — these are the corrections.)

- **[BLOCKER] Corrective clear was a no-op (Codex B1 / Gemini M2).** `fill ref ''` builds `{command:'type', text:''}`; the Swift runner clears **only** on `clearFirst==true` (`CommandExecution.swift:456`) and `typeText("")` is a no-op → the retype *appended* to corrupted text and could flip a real corruption into a false `verified-transformed`. **Fix:** plumb a real `clearFirst` through `RunIOSArgs`/`runIOS`/`buildRunIOSArgs` (`--clear-first`) and retype as one `['fill', ref, text, '--clear-first', '--delay-ms', '40']`. (Task 4 + Task 5.)
- **[BLOCKER] `TEXT_ENTRY_UNVERIFIED` not in `ToolErrorCode` → `tsc` fails (both).** Verified closed union at `types.ts:174`. **Fix:** add `| 'TEXT_ENTRY_UNVERIFIED'` to the union (Task 4, Step 0).
- **[HIGH] Read-back races debounced `onChangeText` (both).** One round-trip ≠ a React commit barrier; debounced search fields read stale `value` → false `corrupted`. **Fix:** a `valueBefore`-aware *settle-poll* (`settleRead`, ≤3 reads) replaces the single read. The pure classifier stays `valueBefore`-free; the *poll* uses `valueBefore` to tell "not flushed yet" from "genuinely dropped." (Tasks 1, 3, 4.)
- **[HIGH] `resolveJsTestId` mishandled `@e5` snapshot refs (both).** Refs are `` `e${counter}` `` tokens (`fast-runner-ref-map.ts:120`), not testIDs. **Fix:** resolve the testID from `getCachedMetadata(ref).identifier` (already cached — zero round-trips), so JS-first now *fully* covers the normal snapshot→`@e5` flow. (Task 1 + Task 3.)
- **[HIGH] Native error returned too early, skipping the fallback chain (Codex H1).** **Fix:** on retype-exhaustion the native path escalates to the maestro fallback + a final verify; `TEXT_ENTRY_UNVERIFIED` is emitted only when that *also* fails. (Task 4.)
- **[MED] `device_batch` bypasses the handler (Gemini B2).** `device-batch.ts:217,221` call `runAgentDevice` directly. **Fix:** explicitly **de-scope** `device_batch` from JS-first in this PR (documented follow-up); correct the spec/changeset claim. (Task 7 + spec note.)
- **[MED] `meta.timings_ms` under-instrumented (Codex M2).** **Fix:** record `{resolve, jsType, verify}` (JS) and `{nativeType, verify, retype}` (native) per spec §4 + CLAUDE.md. (Tasks 3-4.)
- **[MED] Length-only classifier can't see length-preserving corruption (both H2).** An `autoCapitalize` transform and a native autocorrect swap ("teh"→"the") share the signature. **Fix:** documented known gap (§9); JS path is deterministic so it bites only on the native path, where prong-3 suppression is the mitigation. No over-engineering.
- **[MED] `simctl` key set (both).** Drop `KeyboardCapitalization` (changes behavior, not the predictive bar). Keep fail-open/LIVE-VALIDATE; note a running keyboard may need a respring. (Task 6.)
- **[LOW] Stale-helper guard (Codex L1).** If a v23 helper is injected, `attemptJsFill` degrades to native (`probe.controlled === undefined → handled:false`). (Task 3.)
- **[LOW] Changeset names (Gemini L3).** `rn-dev-agent-cdp` + **`rn-dev-agent-plugin`** (not `rn-dev-agent`). (Task 7.)
- **[INFO] `JSON.stringify` eval interpolation is injection-safe (both).** No change.

---

## Key design decisions (grounded against the 2026-06-08 code trace + review)

1. **Settle-poll read-back, not a single read.** Hermes CDP has no `awaitPromise` (`cdp-client.ts:380`) and `onChangeText` may be debounced, so we fire in eval-1 and then *poll* `readInputValue` (≤3 reads, ~70ms apart) until the value either equals the typed text (exact) or diverges from the pre-type `valueBefore` (flushed → classify). This defeats the false-`corrupted` race the reviewers found. The common exact case settles on the first read (2 evaluates total).

2. **testID resolution is cached-metadata-backed, zero round-trips.** `device_fill`'s `ref` is a `@e<N>` snapshot token. We resolve a testID from `args.testID` (new optional arg) **or** `getCachedMetadata(ref).identifier` (the real testID, cached from the last snapshot). Pure-numeric refs and unresolvable tokens → skip JS, use the *verified* native path.

3. **Injected-helper tests are source-guards** (per `issue-126-typetext-walkdown.test.js`): slice the branch out of `INJECTED_HELPERS`, regex-assert structure; behavior verified live on-device.

4. **The pure classifier ignores `valueBefore`; the settle-poll uses it.** Reconciles the two reviews: none of the four *outcomes* depend on `valueBefore`, but the *poll* needs it to distinguish "setState not flushed yet" (keep waiting) from "genuinely dropped" (corrupted).

5. **Full scope, one PR** (user decision). All three prongs ship together; prong-3 *preventive* `simctl` keys are best-known candidates marked **LIVE-VALIDATE**, fail-open, key-list-configurable. `device_batch` JS-first is the one explicit deferral.

## File structure

| File | Responsibility | New? |
|---|---|---|
| `scripts/cdp-bridge/src/tools/fill-verify.ts` | Pure `classifyFillVerification` + `resolveJsTestId` + `decideNativeRetype` + `attemptJsFill`/`settleRead` (CDP-seam-injected) + types | **new** |
| `scripts/cdp-bridge/src/injected-helpers.ts` | `interact()` typeText `verify` mode (return `handlerCalled`/`controlled`/`valueBefore`, no-fire when no handler); new `readInputValue(testID)`; `HELPERS_VERSION` 23→24 | modify |
| `scripts/cdp-bridge/src/tools/device-interact.ts` | `createDeviceFillHandler(getClient)`; JS-first branch; native settle-read + bounded clear/retype; maestro-verify escalation; `meta` instrumentation | modify |
| `scripts/cdp-bridge/src/types.ts` | Add `'TEXT_ENTRY_UNVERIFIED'` to `ToolErrorCode` (line 174) | modify |
| `scripts/cdp-bridge/src/index.ts` | Register `createDeviceFillHandler(getClient)` (line 649) | modify |
| `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts` | `RunIOSArgs.delayMs` + `RunIOSArgs.clearFirst`; `runIOS` forwards both | modify |
| `scripts/cdp-bridge/src/agent-device-wrapper.ts` | `buildRunIOSArgs` `type` reads `--delay-ms` + `--clear-first` | modify |
| `scripts/cdp-bridge/src/runners/suppress-ios-autocorrect.ts` | Best-effort `simctl` predictive/autocorrect disable (deps-injected, fail-open) | **new** |
| `scripts/cdp-bridge/src/tools/device-session.ts` | Call the suppressor in the iOS session-open path (near `ensureSingleRunner({ udid })` at line 273) | modify |
| `scripts/cdp-bridge/test/unit/fill-verify.test.js` | Classifier + resolver + `attemptJsFill` settle/dispatch + `decideNativeRetype` tests | **new** |
| `scripts/cdp-bridge/test/unit/device-fill-jsfirst.test.js` | `buildRunIOSArgs` delayMs + clearFirst guards | **new** |
| `scripts/cdp-bridge/test/unit/injected-typetext-verify.test.js` | Source-guards for verify-mode + `readInputValue` + version bump | **new** |
| `scripts/cdp-bridge/test/unit/suppress-ios-autocorrect.test.js` | Suppressor fail-open + command-shape tests | **new** |
| `.changeset/gh-191-text-input-jsfirst.md` | Minor changeset (`rn-dev-agent-cdp` + `rn-dev-agent-plugin`) | **new** |

**Build/test loop (every task):** tests import from `dist/`, so the cycle is **edit → `npm run build` (tsc) → `node --test <file>`**. `npm run test` does build+all. Run all commands from `scripts/cdp-bridge/`.

---

## Task 1: Pure verifier + testID resolver + retype decision (`fill-verify.ts`)

**Files:**
- Create: `scripts/cdp-bridge/src/tools/fill-verify.ts`
- Test: `scripts/cdp-bridge/test/unit/fill-verify.test.js`

- [ ] **Step 1: Write the failing test (classifier + resolver + retype decision)**

Create `scripts/cdp-bridge/test/unit/fill-verify.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFillVerification, resolveJsTestId, decideNativeRetype } from '../../dist/tools/fill-verify.js';

// ── classifyFillVerification ──────────────────────────────────────────
test('exact match → verified-exact', () => {
  assert.equal(classifyFillVerification({ text: 'a@b.com', valueAfter: 'a@b.com', controlled: true }), 'verified-exact');
});
test('empty-string clear → verified-exact', () => {
  assert.equal(classifyFillVerification({ text: '', valueAfter: '', controlled: true }), 'verified-exact');
});
test('mask/formatter (≥ half length) → verified-transformed', () => {
  assert.equal(classifyFillVerification({ text: '5551234', valueAfter: '(555) 1234', controlled: true }), 'verified-transformed');
  assert.equal(classifyFillVerification({ text: 'abcdefgh', valueAfter: 'abcdef', controlled: true }), 'verified-transformed');
});
test('empty value while text non-empty → corrupted', () => {
  assert.equal(classifyFillVerification({ text: 'a@b.com', valueAfter: '', controlled: true }), 'corrupted');
});
test('severe truncation (< half) → corrupted', () => {
  assert.equal(classifyFillVerification({ text: 'hello@example.com', valueAfter: 'hel', controlled: true }), 'corrupted');
});
test('null value → unverifiable', () => {
  assert.equal(classifyFillVerification({ text: 'x', valueAfter: null, controlled: false }), 'unverifiable');
});
test('stability rule: short BUT stable across retype → verified-transformed', () => {
  assert.equal(classifyFillVerification({ text: 'abcdefgh', valueAfter: 'ab', controlled: true, priorValueAfter: 'ab' }), 'verified-transformed');
});
test('stability rule does NOT rescue an empty value', () => {
  assert.equal(classifyFillVerification({ text: 'abcdefgh', valueAfter: '', controlled: true, priorValueAfter: '' }), 'corrupted');
});

// ── resolveJsTestId (cached-metadata aware) ───────────────────────────
test('explicit testID wins', () => {
  assert.equal(resolveJsTestId('@e5', { explicitTestId: 'email-input' }), 'email-input');
});
test('snapshot @eN ref resolves via cached identifier', () => {
  assert.equal(resolveJsTestId('@e5', { cachedIdentifier: 'email-input' }), 'email-input');
});
test('snapshot @eN ref with no cached identifier → null (skip JS)', () => {
  assert.equal(resolveJsTestId('@e5', {}), null);
});
test('bare numeric ref → null', () => {
  assert.equal(resolveJsTestId('@42', {}), null);
});
test('non-token semantic ref is treated as a testID', () => {
  assert.equal(resolveJsTestId('@email-input', {}), 'email-input');
});
test('empty ref → null', () => {
  assert.equal(resolveJsTestId('@', {}), null);
});

// ── decideNativeRetype ────────────────────────────────────────────────
test('corrupted + attempts left → retype with clear+delay', () => {
  assert.deepEqual(decideNativeRetype('corrupted', 0, 2), { action: 'retype', delayMs: 40 });
});
test('corrupted + exhausted → escalate', () => {
  assert.deepEqual(decideNativeRetype('corrupted', 2, 2), { action: 'escalate' });
});
test('verified-exact → accept', () => {
  assert.deepEqual(decideNativeRetype('verified-exact', 1, 2), { action: 'accept' });
});
test('unverifiable → accept', () => {
  assert.deepEqual(decideNativeRetype('unverifiable', 0, 2), { action: 'accept' });
});
```

- [ ] **Step 2: Run it — expect FAIL (module missing)**

Run: `npm run build && node --test test/unit/fill-verify.test.js`
Expected: build/test error — module does not exist.

- [ ] **Step 3: Write `fill-verify.ts` (classifier + resolver + decision)**

Create `scripts/cdp-bridge/src/tools/fill-verify.ts`:

```ts
export type FillVerifyOutcome =
  | 'verified-exact'
  | 'verified-transformed'
  | 'corrupted'
  | 'unverifiable';

export interface FillVerifyInput {
  text: string;
  valueAfter: string | null;
  controlled: boolean;
  priorValueAfter?: string | null;
}

const HALF = 0.5;

/**
 * Pure classification of a fill read-back. Escalation (`corrupted`) fires only
 * on a STRONG corruption signature — empty, or < half length and not yet proven
 * stable — exactly the #191 char-drop. Masks/formatters/maxLength → transformed.
 * Unreadable → unverifiable (soft-accept; never error merely for lack of proof).
 * NOTE (known gap, spec §9): length-only classification cannot distinguish a
 * length-preserving transform (autoCapitalize) from a length-preserving native
 * autocorrect swap; the JS path is deterministic so this bites only the native
 * path, where prong-3 suppression is the mitigation.
 */
export function classifyFillVerification(input: FillVerifyInput): FillVerifyOutcome {
  const { text, valueAfter, priorValueAfter } = input;
  if (valueAfter === null) return 'unverifiable';
  if (valueAfter === text) return 'verified-exact';
  if (valueAfter.length > 0 && valueAfter.length >= HALF * text.length) return 'verified-transformed';
  if (
    priorValueAfter !== undefined &&
    priorValueAfter !== null &&
    valueAfter !== '' &&
    valueAfter === priorValueAfter
  ) {
    return 'verified-transformed';
  }
  return 'corrupted';
}

export interface ResolveTestIdOpts {
  explicitTestId?: string;
  /** getCachedMetadata(ref).identifier — the real testID for a snapshot ref. */
  cachedIdentifier?: string;
}

const SNAPSHOT_REF_TOKEN = /^e\d+$/; // fast-runner-ref-map mints `e${counter}`

/**
 * Resolve the testID for the JS-first path. Explicit wins; a snapshot ref token
 * (`@e5`) resolves via cached identifier (null if uncached → native path); a
 * bare numeric ref → null; anything else is taken as a literal testID.
 */
export function resolveJsTestId(ref: string, opts: ResolveTestIdOpts = {}): string | null {
  if (opts.explicitTestId && opts.explicitTestId.length > 0) return opts.explicitTestId;
  const stripped = ref.replace(/^@/, '');
  if (stripped.length === 0) return null;
  if (SNAPSHOT_REF_TOKEN.test(stripped)) return opts.cachedIdentifier && opts.cachedIdentifier.length > 0 ? opts.cachedIdentifier : null;
  if (/^\d+$/.test(stripped)) return null;
  return stripped;
}

export type NativeRetypeDecision =
  | { action: 'accept' }
  | { action: 'retype'; delayMs: number }
  | { action: 'escalate' };

const RETYPE_DELAY_MS = 40;

/** Pure decision for the native read-back loop. `escalate` → try maestro + final verify. */
export function decideNativeRetype(
  outcome: FillVerifyOutcome,
  attemptsSoFar: number,
  maxAttempts: number,
): NativeRetypeDecision {
  if (outcome !== 'corrupted') return { action: 'accept' };
  if (attemptsSoFar >= maxAttempts) return { action: 'escalate' };
  return { action: 'retype', delayMs: RETYPE_DELAY_MS };
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm run build && node --test test/unit/fill-verify.test.js` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/fill-verify.ts scripts/cdp-bridge/test/unit/fill-verify.test.js
git commit -S -m "feat(#191): pure fill verifier + cached-metadata testID resolver + retype decision"
```

---

## Task 2: Injected helper — `typeText` verify-mode + `readInputValue` + version bump

**Files:**
- Modify: `scripts/cdp-bridge/src/injected-helpers.ts` (`HELPERS_VERSION` line 5; typeText branch 1125-1302; public API ~1779)
- Test: `scripts/cdp-bridge/test/unit/injected-typetext-verify.test.js`

- [ ] **Step 1: Write the failing source-guard test**

Create `scripts/cdp-bridge/test/unit/injected-typetext-verify.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS, HELPERS_VERSION } from '../../dist/injected-helpers.js';

function typeTextSlice() {
  const open = INJECTED_HELPERS.indexOf("action === 'typeText'");
  const close = INJECTED_HELPERS.indexOf("action === 'setFieldValue'", open);
  assert.ok(open >= 0 && close > open, 'typeText branch not sliceable');
  return INJECTED_HELPERS.slice(open, close);
}
// The no-handler verify return must NOT fire a handler — slice just the verify block.
function verifyNoHandlerSlice() {
  const s = typeTextSlice();
  const open = s.indexOf('if (verify)');
  assert.ok(open >= 0, 'verify no-handler block missing');
  return s.slice(open, open + 400);
}

test('#191: HELPERS_VERSION bumped to 24', () => {
  assert.equal(HELPERS_VERSION, 24);
});
test('#191: verify mode reads opts.verify', () => {
  assert.match(typeTextSlice(), /opts\.verify/);
});
test('#191: verify no-handler return emits handlerCalled:false and fires NOTHING', () => {
  const v = verifyNoHandlerSlice();
  assert.match(v, /handlerCalled:\s*false/);
  assert.doesNotMatch(v, /props\.onChangeText\(text\)/);
  assert.doesNotMatch(v, /props\.onChange\(/);
});
test('#191: verify success payloads carry controlled + valueBefore', () => {
  const s = typeTextSlice();
  assert.match(s, /controlled:/);
  assert.match(s, /valueBefore:/);
});
test('#191: legacy non-verify path keeps the "no handler" error', () => {
  assert.match(typeTextSlice(), /Component has no onChangeText or onChange handler/);
});
test('#191: readInputValue exposed on the public API', () => {
  assert.match(INJECTED_HELPERS, /readInputValue:\s*readInputValue/);
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm run build && node --test test/unit/injected-typetext-verify.test.js`

- [ ] **Step 3a: Bump version** — `injected-helpers.ts:5` → `export const HELPERS_VERSION = 24;`

- [ ] **Step 3b: Capture verify/controlled/valueBefore + Path-1 payload**

Replace the Path-1 block (lines 1152-1170) with:

```js
        var verify = opts.verify === true;
        var controlled = typeof props.value === 'string';
        var valueBefore = controlled ? props.value : null;

        if (typeof props.onChangeText === 'function' || typeof props.onChange === 'function') {
          var p1Handler;
          if (typeof props.onChangeText === 'function') {
            p1Handler = 'onChangeText';
            props.onChangeText(text);
          } else {
            p1Handler = 'onChange';
            props.onChange({ nativeEvent: { text: text } });
          }
          return JSON.stringify({
            success: true, action: 'typeText', component: typeName, testID: selector, text: text,
            handlerCalled: p1Handler, controlled: controlled, valueBefore: valueBefore,
            resolvedFrom: 'matched-fiber'
          });
        }
```

- [ ] **Step 3c: verify-mode no-handler short-circuit (no side effect)**

Replace the `if (!picked) { ... }` block (lines 1273-1280) with:

```js
        if (!picked) {
          if (verify) {
            // #191: probe found no JS handler — no-op signal so device_fill goes native. NOTHING fired.
            return JSON.stringify({ success: true, action: 'typeText', testID: selector, handlerCalled: false, controlled: controlled, valueBefore: valueBefore });
          }
          return JSON.stringify({
            error: 'Component has no onChangeText or onChange handler',
            component: typeName, testID: selector,
            hint: 'Walked up to ' + DESCENDANT_DEPTH_CAP + ' levels (' + visited + ' fibers) — no descendant has a typeable handler. The matched fiber may not contain a TextInput. Use cdp_component_tree to inspect, or pass the inner field testID directly.'
          });
        }
```

- [ ] **Step 3d: controlled/valueBefore on the descendant-walk success return**

Replace the final return (lines 1286-1301) with:

```js
        if (picked.handler === 'onChangeText') {
          picked.match.props.onChangeText(text);
        } else {
          picked.match.props.onChange({ nativeEvent: { text: text } });
        }
        var pickedControlled = typeof picked.match.props.value === 'string';
        return JSON.stringify({
          success: true, action: 'typeText', component: typeName, testID: selector, text: text,
          handlerCalled: picked.handler, controlled: pickedControlled,
          valueBefore: pickedControlled ? picked.match.props.value : valueBefore,
          resolvedFrom: picked.match.name + (picked.match.props.testID ? ' [testID="' + picked.match.props.testID + '"]' : ''),
          visitedFibers: visited
        });
```

- [ ] **Step 3e: Add `readInputValue` after `getComponentState` (ends line 1769)**

```js
  // #191: lean value read-back for fill verification. Returns the field's
  // controlled `value` (post-render) — the real UNMASKED string even for secure
  // fields. If the matched fiber has no `value`, walk descendants for the FIRST
  // string `value`; but if >1 descendant carries a string `value`, return null
  // (ambiguous → unverifiable, never feed a guess into the destructive retype).
  function readInputValue(testID) {
    if (!testID) return JSON.stringify({ __agent_error: 'testID is required' });
    var target = null;
    function findByTestID(fiber) {
      if (!fiber || target) return;
      var p = fiber.memoizedProps;
      if (p && (p.testID === testID || p.nativeID === testID)) { target = fiber; return; }
      var child = fiber.child;
      while (child) { findByTestID(child); child = child.sibling; }
    }
    forEachRootFiber(function(rootFiber) { findByTestID(rootFiber); return target; });
    if (!target) return JSON.stringify({ __agent_error: 'Component not found: ' + testID });

    function valueOf(fiber) {
      var p = fiber && fiber.memoizedProps;
      return p && typeof p.value === 'string' ? p.value : null;
    }
    var direct = valueOf(target);
    if (direct !== null) return JSON.stringify({ value: direct, controlled: true });

    var found = [], visited = 0;
    (function walk(node, depth) {
      if (!node || depth > 16 || visited > 200 || found.length > 1) return;
      visited++;
      var v = valueOf(node);
      if (v !== null) found.push(v);
      if (node.child) walk(node.child, depth + 1);
      if (node.sibling) walk(node.sibling, depth);
    })(target.child, 1);

    if (found.length === 1) return JSON.stringify({ value: found[0], controlled: true });
    return JSON.stringify({ value: null, controlled: false }); // 0 or ambiguous → unverifiable
  }
```

Register it on the public API (after `getComponentState: getComponentState,` line 1779):

```js
    getComponentState: getComponentState,
    readInputValue: readInputValue,
```

- [ ] **Step 4: Run it — expect PASS + no regression**

Run: `npm run build && node --test test/unit/injected-typetext-verify.test.js test/unit/issue-126-typetext-walkdown.test.js`
Expected: all PASS (issue-126 guards still green — Path-1 `resolvedFrom: 'matched-fiber'` and the if/else single-fire structure are preserved).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/injected-helpers.ts scripts/cdp-bridge/test/unit/injected-typetext-verify.test.js
git commit -S -m "feat(#191): typeText verify-mode (no-op probe) + ambiguity-safe readInputValue; helpers v24"
```

---

## Task 3: `attemptJsFill` settle-poll seam + JS-first dispatch in `device_fill`

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/fill-verify.ts` (add `settleRead` + `attemptJsFill` + types)
- Modify: `scripts/cdp-bridge/src/tools/device-interact.ts` (`createDeviceFillHandler(getClient)`, `FillArgs.testID`, JS branch, timings)
- Modify: `scripts/cdp-bridge/src/index.ts` (line 649 → `getClient`)
- Test: `scripts/cdp-bridge/test/unit/fill-verify.test.js` (extend)

- [ ] **Step 1: Write the failing `attemptJsFill` tests (inject fake evaluate + sleep)**

Append to `scripts/cdp-bridge/test/unit/fill-verify.test.js`:

```js
import { attemptJsFill } from '../../dist/tools/fill-verify.js';

// Fake CDP client: probe returns script.probe; readInputValue returns the next
// entry from script.reads (array — models the settle-poll over time).
function fakeClient(script) {
  const reads = script.reads.slice();
  return {
    sleep: async () => {},
    evaluate: async (expr) => {
      if (expr.includes('interact(')) return { value: JSON.stringify(script.probe) };
      if (expr.includes('readInputValue(')) return { value: JSON.stringify(reads.shift() ?? reads[reads.length - 1]) };
      throw new Error('unexpected expr');
    },
  };
}

test('attemptJsFill: handler fired + exact first read → verified-exact', async () => {
  const r = await attemptJsFill(fakeClient({ probe: { handlerCalled: 'onChangeText', controlled: true, valueBefore: '' }, reads: [{ value: 'a@b.com', controlled: true }] }), 'email', 'a@b.com');
  assert.equal(r.handled, true);
  assert.equal(r.outcome, 'verified-exact');
  assert.equal(r.handler, 'onChangeText');
});
test('attemptJsFill: debounced field (stale==valueBefore then settles) → verified-exact, not corrupted', async () => {
  const r = await attemptJsFill(fakeClient({
    probe: { handlerCalled: 'onChangeText', controlled: true, valueBefore: '' },
    reads: [{ value: '', controlled: true }, { value: '', controlled: true }, { value: 'hello', controlled: true }],
  }), 'search', 'hello');
  assert.equal(r.outcome, 'verified-exact');
});
test('attemptJsFill: no JS handler → handled:false', async () => {
  const r = await attemptJsFill(fakeClient({ probe: { handlerCalled: false, controlled: false, valueBefore: null }, reads: [] }), 'native', 'x');
  assert.equal(r.handled, false);
});
test('attemptJsFill: stale v23 helper (no controlled field) → handled:false (degrade)', async () => {
  const r = await attemptJsFill(fakeClient({ probe: { handlerCalled: 'onChangeText' }, reads: [{ value: 'x', controlled: true }] }), 'email', 'x');
  assert.equal(r.handled, false);
});
test('attemptJsFill: probe error → handled:false', async () => {
  const r = await attemptJsFill(fakeClient({ probe: { error: 'Ambiguous' }, reads: [] }), 'amb', 'x');
  assert.equal(r.handled, false);
});
test('attemptJsFill: read unreadable → unverifiable (not corrupted)', async () => {
  const r = await attemptJsFill(fakeClient({ probe: { handlerCalled: 'onChangeText', controlled: true, valueBefore: '' }, reads: [{ __agent_error: 'Component not found' }] }), 'email', 'hello');
  assert.equal(r.handled, true);
  assert.equal(r.outcome, 'unverifiable');
});
test('attemptJsFill: evaluate throws → handled:false', async () => {
  const r = await attemptJsFill({ evaluate: async () => { throw new Error('CDP down'); }, sleep: async () => {} }, 'email', 'x');
  assert.equal(r.handled, false);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`attemptJsFill` not exported)

- [ ] **Step 3a: Add `settleRead` + `attemptJsFill` to `fill-verify.ts`**

```ts
export interface EvaluateSeam {
  evaluate: (expression: string) => Promise<{ value?: unknown; error?: unknown }>;
  /** Injectable for tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface JsFillResult {
  handled: boolean;            // a JS handler fired; false → caller goes native
  outcome?: FillVerifyOutcome;
  valueAfter?: string | null;
  controlled?: boolean;
  handler?: string;
}

const READ_SETTLE_TRIES = 3;
const READ_SETTLE_DELAY_MS = 70;

async function readInputValueOnce(
  deps: EvaluateSeam,
  testID: string,
): Promise<{ value: string | null; controlled: boolean } | null> {
  try {
    const r = await deps.evaluate('__RN_AGENT.readInputValue(' + JSON.stringify(testID) + ')');
    if (!r.error && typeof r.value === 'string') {
      const read = JSON.parse(r.value) as { value?: string | null; controlled?: boolean; __agent_error?: string };
      if (!read.__agent_error) return { value: read.value ?? null, controlled: read.controlled ?? false };
    }
  } catch { /* unreadable */ }
  return null;
}

/**
 * Poll readInputValue until the controlled re-render flushes. Stops on exact,
 * or when the value diverges from the pre-type `valueBefore` (flushed → classify
 * whatever it is). Defeats the debounced-onChangeText read race. valueBefore
 * null (uncontrolled) → polls then returns null → unverifiable upstream.
 */
export async function settleRead(
  deps: EvaluateSeam,
  testID: string,
  text: string,
  valueBefore: string | null,
): Promise<{ value: string | null; controlled: boolean }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let value: string | null = valueBefore;
  let controlled = false;
  for (let i = 0; i < READ_SETTLE_TRIES; i++) {
    const rb = await readInputValueOnce(deps, testID);
    if (rb) { value = rb.value; controlled = rb.controlled; }
    if (value === text) break;                       // exact → settled
    if (value !== valueBefore) break;                // flushed to something → classify it
    if (i < READ_SETTLE_TRIES - 1) await sleep(READ_SETTLE_DELAY_MS);
  }
  return { value, controlled };
}

/**
 * JS-first fill: eval-1 probes + fires onChangeText (no-op when no handler), then
 * settle-poll the value. Any CDP hiccup / stale helper degrades to handled:false.
 */
export async function attemptJsFill(deps: EvaluateSeam, testID: string, text: string): Promise<JsFillResult> {
  let probe: Record<string, unknown>;
  try {
    const expr = '__RN_AGENT.interact(' + JSON.stringify({ action: 'typeText', testID, text, verify: true }) + ')';
    const r = await deps.evaluate(expr);
    if (r.error || typeof r.value !== 'string') return { handled: false };
    probe = JSON.parse(r.value) as Record<string, unknown>;
  } catch {
    return { handled: false };
  }
  if (probe.error) return { handled: false };
  if (probe.controlled === undefined) return { handled: false };          // stale v23 helper → native
  if (probe.handlerCalled === false || probe.handlerCalled === undefined) return { handled: false };

  const valueBefore = typeof probe.valueBefore === 'string' ? probe.valueBefore : null;
  const settled = await settleRead(deps, testID, text, valueBefore);
  return {
    handled: true,
    outcome: classifyFillVerification({ text, valueAfter: settled.value, controlled: settled.controlled }),
    valueAfter: settled.value,
    controlled: settled.controlled,
    handler: typeof probe.handlerCalled === 'string' ? probe.handlerCalled : undefined,
  };
}
```

- [ ] **Step 3b: Wire the JS-first branch into `device_fill`**

In `scripts/cdp-bridge/src/tools/device-interact.ts`:

Imports (after line 12):

```ts
import type { CDPClient } from '../cdp-client.js';
import { getCachedMetadata } from '../fast-runner-ref-map.js';
import { resolveJsTestId, attemptJsFill, settleRead, classifyFillVerification, decideNativeRetype, type FillVerifyOutcome } from './fill-verify.js';
```

Helpers near `FOCUS_DELAY_MS` (line 605):

```ts
function cdpClientOrNull(getClient: () => CDPClient): CDPClient | null {
  try { const c = getClient(); return c && c.isConnected ? c : null; } catch { return null; }
}
function jsVerifyMeta(outcome: FillVerifyOutcome): 'exact' | 'transformed' | 'unverifiable' {
  return outcome === 'verified-exact' ? 'exact' : outcome === 'verified-transformed' ? 'transformed' : 'unverifiable';
}
```

Extend `FillArgs` (line 529):

```ts
interface FillArgs {
  ref: string;
  text: string;
  /** #191: explicit testID for the JS-first path; resolved from ref's cached identifier when omitted. */
  testID?: string;
  waitForKeyboardMs?: number;
}
```

Change the signature (line 632) and insert the JS-first branch after the Android-workaround short-circuit (after line 648):

```ts
export function createDeviceFillHandler(getClient: () => CDPClient): (args: FillArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
    const androidSession = isAndroidSession();
    const needsAndroidWorkaround = androidSession && (args.text.length > ANDROID_FILL_MAX_SAFE_LEN || ANDROID_UNSAFE_CHARS.test(args.text));
    if (needsAndroidWorkaround) {
      const pressResult = await runAgentDevice(['press', ref]);
      if (pressResult.isError) return pressResult;
      await sleep(300);
      return androidClipboardFill(args.text);
    }

    // #191 prong 1 — JS-first dispatch. Opportunistic: CDP connected AND ref→testID.
    const client = cdpClientOrNull(getClient);
    const tResolve = Date.now();
    const cachedIdentifier = getCachedMetadata(ref.replace(/^@/, ''))?.identifier;
    const jsTestId = client ? resolveJsTestId(ref, { explicitTestId: args.testID, cachedIdentifier }) : null;
    if (client && jsTestId) {
      const tJs = Date.now();
      const js = await attemptJsFill({ evaluate: (e) => client.evaluate(e) }, jsTestId, args.text);
      if (js.handled && js.outcome && js.outcome !== 'corrupted') {
        return okResult(
          { filled: true, method: 'js-onChangeText', length: args.text.length, value: js.valueAfter ?? null },
          { meta: { textEntryPath: 'js', verify: jsVerifyMeta(js.outcome), handler: js.handler,
                    timings_ms: { resolve: tJs - tResolve, jsType: Date.now() - tJs } } },
        );
      }
      // handlerCalled:false OR corrupted-on-js → native fallback (Task 4 verifies there too).
    }

    const focusWaitMs = args.waitForKeyboardMs ?? FOCUS_DELAY_MS;
    // ... existing native pre-tap + primary fill + fallback chain (Task 4 adds read-back) ...
```

> `getCachedMetadata` takes the ref WITHOUT the leading `@` (ref-map keys are `e5`); pass `ref.replace(/^@/, '')`.

- [ ] **Step 3c: Update `index.ts:649`** → `createDeviceFillHandler(getClient)`.

- [ ] **Step 4: Run it — expect PASS + no regressions**

Run: `npm run build && node --test test/unit/fill-verify.test.js test/unit/device-interact.test.js`
Expected: PASS; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/fill-verify.ts scripts/cdp-bridge/src/tools/device-interact.ts scripts/cdp-bridge/src/index.ts scripts/cdp-bridge/test/unit/fill-verify.test.js
git commit -S -m "feat(#191): JS-first device_fill dispatch with settle-poll read-back"
```

---

## Task 4: `ToolErrorCode` + native settle-read + bounded clear/retype + maestro-verify escalation

**Files:**
- Modify: `scripts/cdp-bridge/src/types.ts` (`ToolErrorCode` line 174)
- Modify: `scripts/cdp-bridge/src/tools/device-interact.ts` (native path)
- Test: `scripts/cdp-bridge/test/unit/device-fill-jsfirst.test.js` (decideNativeRetype already covered in Task 1; this task is integration-shaped — guard via decideNativeRetype + live)

- [ ] **Step 0: Add the error code (fixes the tsc blocker)**

In `scripts/cdp-bridge/src/types.ts`, add to the `ToolErrorCode` union (line 174):

```ts
  | 'TEXT_ENTRY_UNVERIFIED'
```

- [ ] **Step 1: (decision already TDD'd in Task 1)** Confirm `decideNativeRetype` covers accept / retype / escalate. No new pure unit needed; the loop wiring is verified live (Task 8). Add a guard test that `escalate` is returned at exhaustion (already in Task 1 Step 1).

- [ ] **Step 2: Run** `npm run build` — expect the build to FAIL until Step 0 lands; after Step 0, clean.

- [ ] **Step 3: Native read-back + clear/retype + maestro-verify escalation**

Add constants + a native verify helper above the handler:

```ts
const MAX_NATIVE_RETYPE = 2;

async function nativeSettle(
  client: CDPClient | null,
  testID: string | null,
  text: string,
  valueBefore: string | null,
): Promise<{ outcome: FillVerifyOutcome; value: string | null }> {
  if (!client || !testID) return { outcome: 'unverifiable', value: null };
  const settled = await settleRead({ evaluate: (e) => client.evaluate(e) }, testID, text, valueBefore);
  return { outcome: classifyFillVerification({ text, valueAfter: settled.value, priorValueAfter: valueBefore, controlled: settled.controlled }), value: settled.value };
}

async function readValueBefore(client: CDPClient | null, testID: string | null): Promise<string | null> {
  if (!client || !testID) return null;
  const settled = await settleRead({ evaluate: (e) => client.evaluate(e) }, testID, ' __rn_never__', null);
  return settled.value; // never matches sentinel → returns the first read (current value)
}
```

Replace the primary-fill block (lines 662-665) with the verifying version:

```ts
    const primary = await runAgentDevice(['fill', ref, args.text]);
    if (!primary.isError) {
      const verifyTestId = jsTestId; // null when ref didn't resolve to a testID
      if (client && verifyTestId) {
        const tNative = Date.now();
        let valueBefore = await readValueBefore(client, verifyTestId);
        for (let attempt = 0; attempt <= MAX_NATIVE_RETYPE; attempt++) {
          const { outcome, value } = await nativeSettle(client, verifyTestId, args.text, valueBefore);
          const decision = decideNativeRetype(outcome, attempt, MAX_NATIVE_RETYPE);
          if (decision.action === 'accept') {
            return okResult(
              { filled: true, method: 'native', length: args.text.length, value },
              { meta: { textEntryPath: attempt === 0 ? 'native' : 'native-retype', verify: jsVerifyMeta(outcome), retypes: attempt, timings_ms: { nativeType: Date.now() - tNative } } },
            );
          }
          if (decision.action === 'escalate') break; // fall through to maestro + final verify
          // retype: real clear (clearFirst) + per-char delay to defeat predictive batch-rewrite.
          valueBefore = value;
          await runAgentDevice(['fill', ref, args.text, '--clear-first', '--delay-ms', String(decision.delayMs)]);
        }
        // Exhausted retypes still corrupted → last-resort maestro, then verify ONE more time.
        const maestro = await maestroFillFallback(ref, args.text, androidSession ? 'android' : 'ios');
        if (!maestro.isError) {
          const { outcome, value } = await nativeSettle(client, verifyTestId, args.text, null);
          if (outcome !== 'corrupted') {
            return okResult({ filled: true, method: 'maestro', length: args.text.length, value },
              { meta: { textEntryPath: 'maestro', verify: jsVerifyMeta(outcome), timings_ms: { nativeType: Date.now() - tNative } } });
          }
        }
        return failResult('Text entry could not be verified after retype + maestro fallback', 'TEXT_ENTRY_UNVERIFIED',
          { expected: args.text, pathsTried: ['js?', 'native', 'native-retype', 'maestro'] });
      }
      return primary; // CDP down / no testID → legacy behavior (unverified accept)
    }
```

> The existing focus-error fallback chain (Pressable-resolution → coordinate retap → adb/maestro at lines 668-730) is unchanged — it handles `primary.isError` (focus failures), a different mode than corruption.

- [ ] **Step 4: Run it — expect PASS + full suite**

Run: `npm run test` (build + all). Expected: all pass; `tsc` clean (`TEXT_ENTRY_UNVERIFIED` now valid).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/types.ts scripts/cdp-bridge/src/tools/device-interact.ts scripts/cdp-bridge/test/unit/device-fill-jsfirst.test.js
git commit -S -m "feat(#191): native settle-read + real clear/retype + maestro-verify escalation + TEXT_ENTRY_UNVERIFIED"
```

---

## Task 5: `--delay-ms` + `--clear-first` plumbing for the corrective retype

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts` (`RunIOSArgs` line 473; `runIOS` body line 622)
- Modify: `scripts/cdp-bridge/src/agent-device-wrapper.ts` (`buildRunIOSArgs` `type` case line 351)
- Test: `scripts/cdp-bridge/test/unit/device-fill-jsfirst.test.js`

- [ ] **Step 1: Write the failing test**

Create/extend `scripts/cdp-bridge/test/unit/device-fill-jsfirst.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunIOSArgs } from '../../dist/agent-device-wrapper.js';

test('buildRunIOSArgs type forwards --delay-ms', () => {
  const a = buildRunIOSArgs(['fill', '@email', 'hello', '--delay-ms', '40'], 'com.x.app');
  assert.equal(a.command, 'type'); assert.equal(a.text, 'hello'); assert.equal(a.delayMs, 40);
});
test('buildRunIOSArgs type forwards --clear-first (presence flag)', () => {
  const a = buildRunIOSArgs(['fill', '@email', 'hello', '--clear-first', '--delay-ms', '40'], 'com.x.app');
  assert.equal(a.clearFirst, true); assert.equal(a.delayMs, 40); assert.equal(a.text, 'hello');
});
test('buildRunIOSArgs type without flags omits both', () => {
  const a = buildRunIOSArgs(['fill', '@email', 'hello'], 'com.x.app');
  assert.equal(a.delayMs, undefined); assert.equal(a.clearFirst, undefined);
});
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3a: `RunIOSArgs` + `runIOS` body** (`rn-fast-runner-client.ts`)

After `durationMs?: number;` (~line 497):

```ts
  /** #191: per-character typing delay (ms) for the corrective retype. */
  delayMs?: number;
  /** #191: clear the field before typing (the runner only clears on this flag). */
  clearFirst?: boolean;
```

In `runIOS` after line 629 (`if (args.durationMs !== undefined) body.durationMs = args.durationMs;`):

```ts
  if (args.delayMs !== undefined) body.delayMs = args.delayMs;
  if (args.clearFirst !== undefined) body.clearFirst = args.clearFirst;
```

- [ ] **Step 3b: `buildRunIOSArgs` `type` case** (`agent-device-wrapper.ts:351-367`)

```ts
    case 'fill':
    case 'type': {
      const ref = positionals[0];
      const text = positionals.slice(1).join(' ');
      const delayRaw = optionValue(cliArgs, '--delay-ms');
      const delayMs = delayRaw !== undefined && !Number.isNaN(Number(delayRaw)) ? Number(delayRaw) : undefined;
      const extra: { delayMs?: number; clearFirst?: boolean } = {};
      if (delayMs !== undefined) extra.delayMs = delayMs;
      if (cliArgs.includes('--clear-first')) extra.clearFirst = true;
      if (ref && ref.startsWith('@')) {
        const center = isRefMapFresh() ? refCenter(ref) : null;
        if (!center) return { command: 'type', _staleRef: ref, text, ...extra, ...(bundleId ? { bundleId } : {}) };
        return { command: 'type', x: center.x, y: center.y, text, ...extra, ...(bundleId ? { bundleId } : {}) };
      }
      return { command: 'type', text, ...extra, ...(bundleId ? { bundleId } : {}) };
    }
```

> `positionalArgs` strips `--delay-ms`+value and `--clear-first`, so `text` is unaffected. (Known pre-existing edge: user text that begins with `-` is mishandled by `positionalArgs` — out of scope; noted in §9.)

- [ ] **Step 4: Run it — expect PASS**

Run: `npm run build && node --test test/unit/device-fill-jsfirst.test.js`

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts scripts/cdp-bridge/src/agent-device-wrapper.ts scripts/cdp-bridge/test/unit/device-fill-jsfirst.test.js
git commit -S -m "feat(#191): plumb --delay-ms + --clear-first through buildRunIOSArgs/runIOS"
```

---

## Task 6: Prong 3 preventive — best-effort iOS predictive-keyboard suppression at session-open

**Files:**
- Create: `scripts/cdp-bridge/src/runners/suppress-ios-autocorrect.ts`
- Modify: `scripts/cdp-bridge/src/tools/device-session.ts` (iOS open path near line 273)
- Test: `scripts/cdp-bridge/test/unit/suppress-ios-autocorrect.test.js`

**LIVE-VALIDATE:** exact keys are device-specific; ship the candidate set (sans `KeyboardCapitalization` — that changes app behavior, not the predictive bar), fail-open, key-list-configurable. A write to an already-running keyboard may not take effect without a respring (confirm in Task 8).

- [ ] **Step 1: Write the failing test**

Create `scripts/cdp-bridge/test/unit/suppress-ios-autocorrect.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suppressIOSAutocorrect, IOS_KEYBOARD_PREF_KEYS } from '../../dist/runners/suppress-ios-autocorrect.js';

test('one defaults write per key, scoped to the udid', async () => {
  const calls = [];
  const res = await suppressIOSAutocorrect('UDID-123', { run: async (a) => { calls.push(a); } });
  assert.equal(calls.length, IOS_KEYBOARD_PREF_KEYS.length);
  for (const c of calls) assert.deepEqual(c.slice(0, 5), ['simctl', 'spawn', 'UDID-123', 'defaults', 'write']);
  assert.deepEqual(res.warnings, []);
});
test('does NOT include KeyboardCapitalization (behavior-changing)', () => {
  assert.ok(!IOS_KEYBOARD_PREF_KEYS.some((k) => k[0] === 'KeyboardCapitalization'));
});
test('fail-open: a failing write becomes a warning, others continue', async () => {
  let n = 0;
  const res = await suppressIOSAutocorrect('UDID-123', { run: async () => { n++; if (n === 1) throw new Error('boom'); } });
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /boom/);
});
test('no udid → no-op', async () => {
  const calls = [];
  const res = await suppressIOSAutocorrect('', { run: async (a) => { calls.push(a); } });
  assert.equal(calls.length, 0); assert.equal(res.skipped, true);
});
```

- [ ] **Step 2: Run it — expect FAIL**

- [ ] **Step 3a: Create the suppressor**

`scripts/cdp-bridge/src/runners/suppress-ios-autocorrect.ts`:

```ts
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/**
 * LIVE-VALIDATE (#191): best-known NSGlobalDomain (`-g`) keys that disable the
 * iOS predictive/autocorrect bar in the simulator. Confirm/trim on a booted sim;
 * fail-open so a wrong key is a logged no-op. KeyboardCapitalization is
 * intentionally EXCLUDED — it alters app behavior, not the predictive bar.
 */
export const IOS_KEYBOARD_PREF_KEYS: ReadonlyArray<readonly [string, string, string]> = [
  ['KeyboardAutocorrection', '-bool', 'false'],
  ['KeyboardPrediction', '-bool', 'false'],
  ['KeyboardShowPredictionBar', '-bool', 'false'],
];

export interface SuppressDeps { run: (args: string[]) => Promise<unknown>; }
export interface SuppressResult { warnings: string[]; skipped: boolean; meta: { timings_ms: Record<string, number> }; }

function defaultDeps(): SuppressDeps { return { run: (args) => execFile('xcrun', args, { timeout: 5_000 }) }; }

/** Best-effort, fail-open, scoped to `udid`. Never throws. */
export async function suppressIOSAutocorrect(udid: string, deps: SuppressDeps = defaultDeps()): Promise<SuppressResult> {
  const warnings: string[] = [];
  const timings: Record<string, number> = {};
  if (!udid) return { warnings, skipped: true, meta: { timings_ms: timings } };
  const t = Date.now();
  for (const [key, type, value] of IOS_KEYBOARD_PREF_KEYS) {
    try {
      await deps.run(['simctl', 'spawn', udid, 'defaults', 'write', '-g', key, type, value]);
    } catch (err) {
      warnings.push(`defaults write -g ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  timings.suppress = Date.now() - t;
  return { warnings, skipped: false, meta: { timings_ms: timings } };
}
```

- [ ] **Step 3b: Wire into the iOS session-open path**

In `scripts/cdp-bridge/src/tools/device-session.ts`, after the `const r = await ensureSingleRunner({ udid: deviceId });` line (273) and its existing handling, add:

```ts
            try {
              const sup = await suppressIOSAutocorrect(deviceId);
              if (sup.warnings.length) logger.info('rn-device', `suppressIOSAutocorrect: ${sup.warnings.join('; ')}`);
            } catch { /* fail-open: never block session-open on keyboard prefs */ }
```

Import at top: `import { suppressIOSAutocorrect } from '../runners/suppress-ios-autocorrect.js';` (match the existing `logger` usage in this file).

- [ ] **Step 4: Run it — expect PASS** — `npm run build && node --test test/unit/suppress-ios-autocorrect.test.js`

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/runners/suppress-ios-autocorrect.ts scripts/cdp-bridge/src/tools/device-session.ts scripts/cdp-bridge/test/unit/suppress-ios-autocorrect.test.js
git commit -S -m "feat(#191): best-effort iOS predictive-keyboard suppression at session-open (fail-open)"
```

---

## Task 7: Changeset, docs, full suite

**Files:**
- Create: `.changeset/gh-191-text-input-jsfirst.md`
- Modify: `CLAUDE.md` (device_fill quirks note) + `docs/superpowers/specs/2026-06-08-gh191-text-input-jsfirst-design.md` (correct the `device_batch` claim)

- [ ] **Step 1: Write the changeset** (`rn-dev-agent-cdp` + `rn-dev-agent-plugin`; no `device_batch` claim)

`.changeset/gh-191-text-input-jsfirst.md`:

```markdown
---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

fix(#191): JS-first text entry — `device_fill` now prefers the deterministic React `onChangeText` path when CDP is connected and the ref resolves to a testID (via cached snapshot identifier), settle-polls the field value to verify it, and on the native fallback runs a bounded clear+retype (real `clearFirst` + per-char delay) on corruption, escalating to a verified maestro fallback before erroring. Adds best-effort iOS predictive-keyboard suppression at session-open and a new `TEXT_ENTRY_UNVERIFIED` error for the exhausted-and-still-corrupted case. Additive `meta` (`textEntryPath`, `verify`, `timings_ms`); no breaking change. NOTE: `device_batch` fills are not yet JS-first (follow-up) — they still use the native path directly.
```

- [ ] **Step 2: Correct the spec's `device_batch` claim** — in §5 of the design spec, change the `device_batch` bullet to note it is a documented follow-up (bypasses `createDeviceFillHandler`), not covered in this PR. (Append-style edit; do not delete the spec.)

- [ ] **Step 3: Add a `device_fill` quirks note to `CLAUDE.md`** (under the iOS-only quirks list) describing JS-first dispatch + settle-poll verification + `TEXT_ENTRY_UNVERIFIED`.

- [ ] **Step 4: Build + run the FULL suite** — `npm run test:all` → ALL pass, `tsc` clean. Confirm regressions green: `device-interact.test.js`, `issue-126-typetext-walkdown.test.js`.

- [ ] **Step 5: Stage rebuilt `dist/` + commit**

```bash
git add scripts/cdp-bridge/dist .changeset/gh-191-text-input-jsfirst.md CLAUDE.md docs/superpowers/specs/2026-06-08-gh191-text-input-jsfirst-design.md
git commit -S -m "chore(#191): changeset, docs, spec correction, rebuilt dist"
```

---

## Task 8: Live device validation (both platforms) — gates merge

> Manual/interactive; plugin tools against a booted sim/emulator with the workspace test-app + Metro (`cd ../rn-dev-agent-workspace/test-app && npx expo start`). Spec §6 "Live (both platforms)".

- [ ] **Step 1 (iOS, controlled):** quick-add task sheet email field → `device_fill` → assert `meta.textEntryPath==='js'`, `meta.verify==='exact'`, no dropped chars (the #191 failure).
- [ ] **Step 2 (iOS, native + retype):** CDP-disconnected or no-handler field → `textEntryPath` `native`/`native-retype`; verify the **real clear** happens (no append) and a flaky field triggers `retypes>0`, escalating to verified maestro if needed.
- [ ] **Step 3 (iOS, prong-3 keys):** confirm the predictive bar is actually suppressed; if a respring is required, note it; **trim `IOS_KEYBOARD_PREF_KEYS`** to keys that demonstrably work. Re-commit trimmed list + dist if changed.
- [ ] **Step 4 (Android):** repeat Step 1 — JS-first covers RN inputs on Android too; `textEntryPath==='js'`, exact.
- [ ] **Step 5 (transform input):** phone/currency-masked field → `verify==='transformed'`, NO retype loop.
- [ ] **Step 6 (debounce):** a debounced search field → confirm the settle-poll yields `verified-exact` (NOT a false `corrupted`).
- [ ] **Step 7:** capture timings + record a passing walk as a learned action for the PR body.

---

## Self-review (run before execution)

**Spec coverage:** §3.1 dispatch → Task 3 (settle-poll adaptation, Key Decision #1). §3.2 verification → Task 1 + Task 2 (`readInputValue`). §3.3 suppression → Task 6 (preventive) + Task 4 (corrective, real `clearFirst`) + Task 5 (delayMs). §4 meta → Tasks 3-4 (timings amended). §5 edge cases → classifier tests + null-path degrade; `device_batch` explicitly de-scoped (Task 7). §6 testing → Tasks 1-6 unit + Task 8 live. §7 files → table matches (verified). ✓

**Placeholder scan:** no TBD / "add error handling" / "similar to Task N" — every code step shows real code. ✓

**Type consistency:** `classifyFillVerification(FillVerifyInput)`, `resolveJsTestId(ref, ResolveTestIdOpts)`, `decideNativeRetype(outcome, n, max)→NativeRetypeDecision`, `settleRead(EvaluateSeam, testID, text, valueBefore)`, `attemptJsFill(EvaluateSeam, testID, text)→JsFillResult`, `readInputValue(testID)→{value,controlled}`, `RunIOSArgs.{delayMs,clearFirst}` — consistent across tasks. ✓

**Known gaps (documented, accepted):**
1. Length-preserving corruption (autocapitalize vs native autocorrect swap) indistinguishable by length-only classifier — JS path deterministic; native path mitigated by prong-3. (§9)
2. `device_batch` not JS-first this PR (follow-up). (Task 7)
3. `positionalArgs` mishandles user text beginning with `-` (pre-existing; the retype appends flags after text, so happy path unaffected). (§9)
4. `simctl` keys unverified until Task 8; fail-open contains blast radius.

**Resolved review open-questions:** numeric/`@eN` refs now resolve via cached identifier (H3/M1 → full coverage); `valueBefore` kept out of the pure classifier but used in the settle-poll (Decision #4); `simctl` keys LIVE-VALIDATE w/o `KeyboardCapitalization`; settle-poll chosen over a single read or `evaluateAsync` polling (simpler, injectable, testable).
