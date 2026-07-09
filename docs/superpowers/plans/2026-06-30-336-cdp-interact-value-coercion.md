# Fix `cdp_interact` value-injection for Controller inputs (#336) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cdp_interact` drive react-hook-form `Controller`-wrapped inputs correctly — `press value=<v>` selects a radio/chip by passing the value (not a synthetic event), and `setFieldValue` keeps a string a string for string-typed fields.

**Architecture:** Both fixes are in the injected helpers JS (`injected-helpers.ts`), unit-tested via the existing VM harness. `interact.ts` already forwards `value` for every action, so no TS handler logic changes. `index.ts` gets schema *description* updates only. `HELPERS_VERSION` is bumped so on-device helpers re-inject.

**Tech Stack:** TypeScript compiled `src`→`dist` via `tsc`; Node built-in test runner (`node --test`); tests authored as `.js` in `test/unit/` importing `INJECTED_HELPERS` from `dist/` and running it in a `node:vm` sandbox.

## Global Constraints

- Node.js >= 22 LTS. No new dependencies. Explicit type imports. No unnecessary comments in code.
- The `value` schema union stays `z.union([z.string(), z.number(), z.boolean()])` — do NOT drop number/boolean (the passthrough is an intentional feature; `test/unit/gh-126-set-field-value.test.js:189` asserts it).
- Bug #2 coercion is **number→string only**, and **only** when `typeof formReturn.getValues(name) === 'string'`. Never string→number. A `getValues` throw → no coercion.
- Bug #1: `press` with `value` undefined keeps the current `props.onPress({ nativeEvent: {} })` behavior exactly.
- Bump `HELPERS_VERSION` once (32 → 33) for the whole change.
- `dist/` is tracked and loaded by the runtime — every task that changes `src` MUST rebuild and commit the `dist` output in the same commit.
- A changeset is REQUIRED (touches `scripts/cdp-bridge/src/`) and MUST bump BOTH `rn-dev-agent-cdp` and `rn-dev-agent-plugin` (`scripts/require-changeset.sh`).
- Build+test commands (verbatim):
  - Targeted: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-336-interact-value-injection.test.js`
  - Full suite: `cd scripts/cdp-bridge && npm test`

---

## File Structure

- **Modify:** `scripts/cdp-bridge/src/injected-helpers.ts` — `setFieldValue` block (~1576, Bug #2), `press` block (1329–1335, Bug #1), `HELPERS_VERSION` (line 5). Plus rebuilt `dist/injected-helpers.js`.
- **Modify:** `scripts/cdp-bridge/src/index.ts` — `value` describe (~983–988) and `action` enum describe (~932–934). Plus rebuilt `dist/index.js`.
- **Create:** `scripts/cdp-bridge/test/unit/gh-336-interact-value-injection.test.js`.
- **Create:** `.changeset/336-cdp-interact-value-coercion.md`.

---

### Task 1: Bug #2 — `setFieldValue` type-matches number→string for string-typed fields

**Files:**
- Modify: `scripts/cdp-bridge/src/injected-helpers.ts` (`setFieldValue` block ~1576; `HELPERS_VERSION` line 5)
- Create: `scripts/cdp-bridge/test/unit/gh-336-interact-value-injection.test.js`

**Interfaces:**
- Consumes: existing `__RN_AGENT.interact({action:'setFieldValue', testID, name, value, shouldValidate?, shouldDirty?})`; `formReturn.getValues(name)` and `formReturn.setValue(name, value, opts)`.
- Produces: setFieldValue result JSON gains `coercedToString: boolean`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/cdp-bridge/test/unit/gh-336-interact-value-injection.test.js`:

```js
// GH #336 — cdp_interact value-injection must not corrupt Controller-wrapped
// inputs: setFieldValue keeps a string a string for string-typed fields, and
// press passes a value (not a synthetic event) to value-bearing controls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

function runInteract(buildFiber, interactOpts) {
  const sandbox = {
    Array, Object, JSON, Map, WeakSet, Set, Error, Date, RegExp, Symbol,
    parseInt, parseFloat, String, Number, Boolean, Promise, setTimeout, clearTimeout,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
  };
  sandbox.globalThis = sandbox;
  const rootFiber = buildFiber();
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: () => new Set([{ current: rootFiber }]),
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  const out = vm.runInContext(`__RN_AGENT.interact(${JSON.stringify(interactOpts)})`, sandbox);
  return JSON.parse(out);
}

function linkFiber(parent, child) {
  parent.child = child;
  child.return = parent;
  return child;
}

// Form tree: root → FormProvider(value=formReturn) → anchor(testID 'f').
function buildFormTree(formReturn) {
  return function () {
    const root = { type: {}, memoizedProps: {}, child: null, sibling: null, return: null };
    const provider = {
      type: { displayName: 'FormProvider' },
      memoizedProps: { value: formReturn }, child: null, sibling: null, return: null,
    };
    const anchor = { type: {}, memoizedProps: { testID: 'f' }, child: null, sibling: null, return: null };
    linkFiber(root, provider);
    linkFiber(provider, anchor);
    return root;
  };
}

function recordingForm(getValuesImpl) {
  const calls = [];
  return {
    calls,
    form: {
      setValue(n, v) { calls.push({ v, type: typeof v }); },
      getValues: getValuesImpl,
      control: {},
    },
  };
}

test('#336 setFieldValue: number into a string-typed field coerces to string', () => {
  const { calls, form } = recordingForm((name) => (name === 'phone' ? '' : undefined));
  const res = runInteract(buildFormTree(form), { action: 'setFieldValue', testID: 'f', name: 'phone', value: 15112345678 });
  assert.deepEqual(calls, [{ v: '15112345678', type: 'string' }]);
  assert.equal(res.coercedToString, true);
});

test('#336 setFieldValue: number into a non-string field stays a number (gh-126 preserved)', () => {
  const { calls, form } = recordingForm(() => undefined);
  const res = runInteract(buildFormTree(form), { action: 'setFieldValue', testID: 'f', name: 'age', value: 42 });
  assert.deepEqual(calls, [{ v: 42, type: 'number' }]);
  assert.ok(!res.coercedToString);
});

test('#336 setFieldValue: getValues throwing does not coerce (number passes through)', () => {
  const { calls, form } = recordingForm(() => { throw new Error('not ready'); });
  runInteract(buildFormTree(form), { action: 'setFieldValue', testID: 'f', name: 'phone', value: 15112345678 });
  assert.deepEqual(calls, [{ v: 15112345678, type: 'number' }]);
});

test('#336 setFieldValue: a string value into a string field is unchanged', () => {
  const { calls, form } = recordingForm(() => '');
  runInteract(buildFormTree(form), { action: 'setFieldValue', testID: 'f', name: 'phone', value: 'abc' });
  assert.deepEqual(calls, [{ v: 'abc', type: 'string' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-336-interact-value-injection.test.js`
Expected: the first test FAILS (no coercion: `setValue` got the number `15112345678`, and `res.coercedToString` is undefined). The other three PASS already (current passthrough behavior).

- [ ] **Step 3: Implement the type-match + version bump**

In `scripts/cdp-bridge/src/injected-helpers.ts`, bump the version (line 5):

```ts
export const HELPERS_VERSION = 33;
```

In the `setFieldValue` block, AFTER the `if (!formReturn) { ... }` early-return and BEFORE the `try { formReturn.setValue(...) }`, insert:

```ts
        var coercedToString = false;
        if (typeof fieldValue === 'number') {
          var currentValue;
          try { currentValue = formReturn.getValues(fieldName); } catch (e2) { currentValue = undefined; }
          if (typeof currentValue === 'string') {
            fieldValue = String(fieldValue);
            coercedToString = true;
          }
        }
```

Then add `coercedToString` to the success return object (the `return JSON.stringify({ success: true, action: 'setFieldValue', ... })` near the end of the block):

```ts
        return JSON.stringify({
          success: true,
          action: 'setFieldValue',
          testID: selector,
          name: fieldName,
          value: fieldValue,
          coercedToString: coercedToString,
          shouldValidate: shouldValidate,
          shouldDirty: shouldDirty,
          ancestorVisits: ancestorVisits
        });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-336-interact-value-injection.test.js`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit (src + rebuilt dist + test)**

```bash
cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin
git add scripts/cdp-bridge/src/injected-helpers.ts scripts/cdp-bridge/dist/injected-helpers.js scripts/cdp-bridge/test/unit/gh-336-interact-value-injection.test.js
git commit -m "fix(336): setFieldValue type-matches number->string for string fields; HELPERS_VERSION 33

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Bug #1 — optional `value` on `press` + schema docs

**Files:**
- Modify: `scripts/cdp-bridge/src/injected-helpers.ts` (`press` block 1329–1335)
- Modify: `scripts/cdp-bridge/src/index.ts` (`value` describe ~983–988; `action` enum describe ~932–934)
- Test: `scripts/cdp-bridge/test/unit/gh-336-interact-value-injection.test.js` (append)

**Interfaces:**
- Consumes: `__RN_AGENT.interact({action:'press', testID, value?})`.
- Produces: when `value` is provided, `props.onPress(value)` is called (else `props.onPress({nativeEvent:{}})`); the press result JSON includes `value` when one was passed.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/cdp-bridge/test/unit/gh-336-interact-value-injection.test.js`:

```js
// Press tree: root → control(testID, onPress?) — onPress records its arg.
function buildPressTree(testID, withOnPress) {
  return function () {
    const root = { type: {}, memoizedProps: {}, child: null, sibling: null, return: null };
    const calls = [];
    const props = { testID: testID };
    if (withOnPress) props.onPress = (arg) => { calls.push(arg); };
    const control = { type: { displayName: 'RadioOption' }, memoizedProps: props, child: null, sibling: null, return: null, __calls: calls };
    linkFiber(root, control);
    root.__control = control;
    return root;
  };
}

test('#336 press: with value, onPress receives the value (not an event object)', () => {
  const build = buildPressTree('opt-male', true);
  let captured;
  const wrapped = () => { const r = build(); captured = r.__control.__calls; return r; };
  const res = runInteract(wrapped, { action: 'press', testID: 'opt-male', value: 'male' });
  assert.deepEqual(captured, ['male']);
  assert.equal(res.success, true);
  assert.equal(res.value, 'male');
});

test('#336 press: without value, onPress receives a synthetic event (unchanged)', () => {
  const build = buildPressTree('btn', true);
  let captured;
  const wrapped = () => { const r = build(); captured = r.__control.__calls; return r; };
  const res = runInteract(wrapped, { action: 'press', testID: 'btn' });
  assert.equal(captured.length, 1);
  assert.equal(typeof captured[0], 'object');
  assert.ok(captured[0] && 'nativeEvent' in captured[0]);
  assert.equal(res.success, true);
  assert.equal('value' in res, false);
});

test('#336 press: no onPress handler still returns the existing error', () => {
  const res = runInteract(buildPressTree('btn', false), { action: 'press', testID: 'btn', value: 'x' });
  assert.ok(res.error && /onPress/i.test(res.error));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-336-interact-value-injection.test.js`
Expected: the "with value" test FAILS (onPress currently receives `{nativeEvent:{}}`, so `captured` is `[{nativeEvent:{}}]` not `['male']`, and `res.value` is undefined). The other two PASS.

- [ ] **Step 3: Implement the press `value` branch**

In `scripts/cdp-bridge/src/injected-helpers.ts`, replace the `press` block (1329–1335) with:

```ts
      if (action === 'press') {
        if (typeof props.onPress !== 'function') {
          return JSON.stringify({ error: 'Component has no onPress handler', component: typeName, testID: selector });
        }
        if (opts.value !== undefined) {
          props.onPress(opts.value);
        } else {
          props.onPress({ nativeEvent: {} });
        }
        var pressResult = { success: true, action: 'press', component: typeName, testID: selector };
        if (opts.value !== undefined) pressResult.value = opts.value;
        return JSON.stringify(pressResult);
      }
```

> **Amendment (multi-LLM plan review, Codex + Gemini):** the injected-helpers runtime string is deliberately ES5-only (no object-spread/arrow outside string literals) so it stays safe on older Hermes. The `press` return is therefore built imperatively (`var pressResult = {…}; if (opts.value !== undefined) pressResult.value = opts.value;`) instead of with object-spread. Result shape is identical, so the Task 2 tests are unchanged.

- [ ] **Step 4: Update the schema descriptions in `index.ts`**

In the `value` describe (~983–988), replace the describe string with:

```ts
        'Value to set. For setFieldValue: passed to setValue (a digit-string is kept a string when the field is string-typed). For press: when provided, onPress receives this value instead of a synthetic event — use for radio/chip-style value-bearing controls.',
```

In the `action` enum describe (~932–934), replace the `press:` clause so the sentence reads:

```ts
        'press: calls onPress (with `value` if provided, for radio/chip-style value-bearing controls). longPress: calls onLongPress. typeText: calls onChangeText. scroll: calls scrollTo or onScroll. setFieldValue: walks UP to nearest React Hook Form FormProvider and calls setValue(name, value, {shouldValidate, shouldDirty}).',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-336-interact-value-injection.test.js`
Expected: all 7 tests PASS.

- [ ] **Step 6: Commit (src + rebuilt dist + test)**

```bash
cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin
git add scripts/cdp-bridge/src/injected-helpers.ts scripts/cdp-bridge/src/index.ts scripts/cdp-bridge/dist/injected-helpers.js scripts/cdp-bridge/dist/index.js scripts/cdp-bridge/test/unit/gh-336-interact-value-injection.test.js
git commit -m "fix(336): press passes value to onPress for value-bearing controls; doc value/action

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Full-suite regression + changeset

**Files:**
- Create: `.changeset/336-cdp-interact-value-coercion.md`

- [ ] **Step 1: Run the full unit suite (regression gate)**

Run: `cd scripts/cdp-bridge && npm test`
Expected: the entire suite PASSES, including `gh-126-set-field-value.test.js` (numeric/boolean passthrough still green) and the existing interact/press tests. If a pre-existing flaky test (e.g. the order-dependent `cdp_restart` test, #333) fails, re-run once to confirm it's unrelated.

- [ ] **Step 2: Create the changeset**

Create `.changeset/336-cdp-interact-value-coercion.md`:

```markdown
---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

fix(interact): cdp_interact no longer corrupts react-hook-form Controller-wrapped inputs (#336). `setFieldValue` keeps a string a string for string-typed fields (a digit-string injected as a number is coerced back to string only when the field currently holds a string — number/boolean fields are untouched). `press` gains an optional `value`: when provided, `onPress` receives the value instead of a synthetic event, so radio/chip-style controls whose onPress sets a form value select correctly. HELPERS_VERSION bumped to 33.
```

- [ ] **Step 3: Verify the changeset guard passes locally**

Run: `cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin && CHANGED_FILES="scripts/cdp-bridge/src/injected-helpers.ts" bash scripts/require-changeset.sh`
Expected: prints a success line and exits 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin
git add .changeset/336-cdp-interact-value-coercion.md
git commit -m "chore(changeset): cdp_interact value-injection fix (#336, cdp + plugin patch)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Device verification (iOS + Android, parent session)

> Runs in the **parent session** with the live MCP tools against a booted simulator/emulator with Metro from `../rn-dev-agent-workspace/test-app`. Verification, not code — do not dispatch to a code subagent.

- [ ] **Step 1: Confirm the running bridge has the rebuilt helpers**

Run `cdp_status`; confirm connected + healthy. The injected helpers re-inject on the next CDP tool call because `HELPERS_VERSION` changed (33) — confirm via a `cdp_evaluate` of `globalThis.__RN_AGENT && __HELPERS_VERSION__` or simply that interact calls work.

- [ ] **Step 2: Verify Bug #1 (radio via press value) on iOS**

Find a screen with an RHF radio/chip group (e.g. the task wizard's `wizard-priority-*` or a RadioChip). Use `cdp_interact action=press testID=<option> value=<optionValue>`. Then read the form state (`cdp_component_state` / `cdp_store_state` or submit) and confirm the field holds the option VALUE (not an event object) and validation passes.

- [ ] **Step 3: Verify Bug #2 (phone via setFieldValue) on iOS**

On a screen with a `z.string()` phone field, `cdp_interact action=setFieldValue testID=<anchor> name=<field> value="15112345678"`. Confirm the result `coercedToString` reflects behavior and the field value is the string `"15112345678"` (submit / inspect — no Zod "expected string, received number").

- [ ] **Step 4: Repeat on Android**

Boot the Android emulator, repeat Steps 2–3. Capture before/after screenshots into `../rn-dev-agent-workspace/docs/proof/336-cdp-interact-value-coercion/`.

- [ ] **Step 5: Record the outcome**

Note results in the PR body and the workspace `ROADMAP.md`; open or update GitHub Issues for bugs per the logging rules.

---

## Self-Review

**1. Spec coverage:**
- Bug #2 type-match (number→string, string-typed only, getValues-throw safe) → Task 1. ✓
- Bug #1 optional press value (verbatim, backward-compatible) → Task 2. ✓
- Schema describe docs (value + action) → Task 2. ✓
- HELPERS_VERSION 32→33 → Task 1. ✓
- Preserve gh-126 numeric/boolean passthrough → Task 1 test "stays a number" + Task 3 full-suite gate. ✓
- Changeset dual-bump → Task 3. ✓
- Device verification iOS+Android → Task 4. ✓
- Out-of-scope (drop union, symmetric coercion, press type-match, native path) → not touched. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; commands show expected output. ✓

**3. Type consistency:** `coercedToString` (boolean) named identically in impl + tests + result JSON. `props.onPress(opts.value)` matches the `value` forwarded by `interact.ts`. `getValues(fieldName)`/`setValue(fieldName, fieldValue, ...)` match the existing helper symbols. Test harness `runInteract`/`linkFiber` copied verbatim from `gh-126-set-field-value.test.js`. ✓

No gaps found.
