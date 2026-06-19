# RNT Selector Resolver — Phase 1 (Discovery Resolver) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an RNTL-style discovery ladder (`byRole(+name)`, `byText`, `byPlaceholder`) to the in-app fiber matcher, ported against a fiber→host adapter, emitting a fail-closed **selector bundle** — the precision half of the design spec (`docs/superpowers/specs/2026-06-19-rnt-selector-resolver-projector-design.md`).

**Architecture:** Five leaf helpers (`__match`, `__hostKind`, `__role`, `__accessibleName`, `__hidden`) are ported from React Native Testing Library v14 (MIT) into the injected `INJECTED_HELPERS` IIFE (`injected-helpers.ts`), each exposed on `globalThis.__RN_AGENT` and unit-tested via `vm` + `buildFiber`. They compose into `resolveLadder` (Task 7), which extends `interact()` with fail-closed truncation (Task 6), multiplicity gating, and hidden-exclusion, and emits a selector bundle with stable anchors (Task 8). The projector (Phase 2) and bundle persistence + self-heal (Phase 3) are separate plans.

**Tech Stack:** TypeScript (ESM, `tsc` build) for the cdp-bridge; the injected surface is an ES5 template-string IIFE evaluated in-app via CDP `Runtime.evaluate`; tests are JS run by `node --test` (Node ≥22). Ports adapt RNTL `src/matches.ts` and `src/helpers/accessibility.ts` algorithms.

## Global Constraints

- **Node ≥ 22**; cdp-bridge is **ESM** (`"type":"module"`); runtime deps limited to `@modelcontextprotocol/sdk`, `ws`, `yaml`, `zod` (no new deps in this plan).
- **All resolver code is ES5**, authored inside the `INJECTED_HELPERS` template literal in `scripts/cdp-bridge/src/injected-helpers.ts` (starts line 7): `var`/`function` only, no `import`/`export`, no TS types, matching the existing in-IIFE style. It is `evaluate()`d in-app (`cdp/setup.ts:96,240`).
- **Bump `HELPERS_VERSION`** (`injected-helpers.ts:5`, currently `26`) by exactly 1 in every task that changes the injected surface (tasks land as sequential commits, so each increments).
- **Fiber shape, not RNTL `TestInstance`:** `fiber.memoizedProps` (props; a text node's is a raw string), `fiber.child`+`fiber.sibling` (children), `fiber.return` (parent), `fiber.type` (host = string or `{displayName,name}`). No `StyleSheet.flatten` in-page — flatten style arrays manually. Host detection is via `__hostKind` (Task 2), never RNTL `host-component-names.ts`.
- **Tests:** `scripts/cdp-bridge/test/unit/<name>.test.js`, run after `npm run build`. Build + run one file: `cd scripts/cdp-bridge && npm run build && node --test test/unit/<file>.test.js`. Every task adds a `assert.match(INJECTED_HELPERS, /…/)` **source-drift guard**.
- **Fail-closed everywhere:** the resolver never silently picks (truncation and ambiguity are structured errors); hidden elements are excluded by default. (Spec §9.)
- **`bundle.bounds` is `null` in Phase 1** — there is no in-page measure primitive yet; `bounds?` stays in the bundle shape (stable for later phases) but is emitted as `null`. It is an optional tie-break only (spec §12, LOW), never a durable selector.

### Fixed interfaces (every task honors these exact signatures)

- `__RN_AGENT.__match(text, matcher) → boolean` — `matcher` is `{value, exact?}` (string; `exact:true` = normalized full-string equality, else case-insensitive substring) or `{regexSource, regexFlags?}` (compiled in try/catch, `lastIndex` reset, `g` stripped, candidate length-capped). Normalizer trims + collapses whitespace, **does not lowercase**.
- `__RN_AGENT.__hostKind(fiber) → 'text'|'textinput'|'image'|'switch'|'scrollview'|'modal'|null`.
- `__RN_AGENT.__role(fiber) → string` — explicit `role`/`accessibilityRole` (`image`→`img`); host text → `text`; else `none`. Never defaults Pressable to `button`.
- `__RN_AGENT.__accessibleName(fiber) → string|undefined` — labelledBy refs → aria/accessibilityLabel → image alt → (root-only) textinput placeholder → recursive child name (inline host-text joined with `''`, else `' '`).
- `__RN_AGENT.__hidden(fiber) → boolean` — walks `.return`; aria-hidden / accessibilityElementsHidden / importantForAccessibility `no-hide-descendants` / `display:'none'` / aria-modal sibling. `opacity:0` is not hidden.
- `__RN_AGENT.resolveLadder(specJson) → JSON string` `{found, bundle?, error?, truncated?, count?, matches?, hint?}`; `spec = {testID?, role?, name?, text?, placeholder?, exact?, includeHidden?}`; `bundle = {testID?, text?, accessibleName?, role?, placeholder?, disabled?, bounds?, anchors?}`.
- Pure helpers return **raw values**; `interact()`/`resolveLadder` return **JSON strings**.

---

### Task 0: Shared injected-helpers test harness

**Files:**
- Create: `scripts/cdp-bridge/test/unit/helpers/inject-harness.js`
- Test: `scripts/cdp-bridge/test/unit/harness-smoke.test.js`

**Interfaces:**
- Produces: `createSandbox(opts) → sandbox` (runs `INJECTED_HELPERS` in a `vm` context; `opts.fiberRoot` wires `__REACT_DEVTOOLS_GLOBAL_HOOK__`); `buildFiber(spec, parent) → fiber` (supports `spec.name` for components, `spec.hostType` for host nodes, `spec.text` for text nodes, `spec.props`, `spec.children`); re-exports `INJECTED_HELPERS`. **Every later task consumes these.**

- [ ] **Step 1: Write the failing test** — `test/unit/harness-smoke.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, buildFiber, INJECTED_HELPERS } from './helpers/inject-harness.js';

test('harness: createSandbox exposes __RN_AGENT and presses by testID', () => {
  const root = buildFiber({ name: 'App', children: [
    { name: 'Pressable', props: { testID: 'x', onPress() {} } },
  ] });
  const s = createSandbox({ fiberRoot: root });
  assert.ok(s.__RN_AGENT, 'sandbox exposes __RN_AGENT');
  const r = JSON.parse(s.__RN_AGENT.interact({ action: 'press', testID: 'x' }));
  assert.equal(r.success, true);
});

test('harness: buildFiber supports text and hostType nodes', () => {
  assert.equal(buildFiber({ text: 'hello' }).memoizedProps, 'hello');
  assert.equal(buildFiber({ hostType: 'RCTText' }).type, 'RCTText');
  assert.equal(typeof INJECTED_HELPERS, 'string');
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/harness-smoke.test.js`
Expected: FAIL — `Cannot find module './helpers/inject-harness.js'`.

- [ ] **Step 3: Create the harness** — `test/unit/helpers/inject-harness.js`:

```js
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../../dist/injected-helpers.js';

export { INJECTED_HELPERS };

// Runs the injected IIFE in an isolated vm context with a minimal global
// whitelist (mirrors gh-60-bug-5-label-matching.test.js). When opts.fiberRoot
// is given, exposes a one-renderer DevTools hook so the IIFE's
// findAllRootFibers() discovers the fake tree.
export function createSandbox(opts = {}) {
  const sandbox = {
    Array, Object, JSON, Map, Set, WeakSet, WeakMap, Error, Date,
    parseInt, parseFloat, String, Number, Boolean, RegExp, Symbol, Promise,
    setTimeout, clearTimeout,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
  };
  sandbox.globalThis = sandbox;
  if (opts.fiberRoot) {
    sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, {}]]),
      getFiberRoots: (id) => (id === 1 ? new Set([{ current: opts.fiberRoot }]) : new Set()),
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox;
}

// Build a fake fiber tree. spec:
//   { name }      → composite component (type = { displayName: name })
//   { hostType }  → host node       (type = "RCTText" etc., a string)
//   { text }      → text node       (memoizedProps = the raw string)
//   { props, children }
export function buildFiber(spec, parent = null) {
  const isText = typeof spec.text === 'string';
  const fiber = {
    type: spec.name ? { displayName: spec.name } : (spec.hostType != null ? spec.hostType : null),
    memoizedProps: isText ? spec.text : (spec.props || {}),
    return: parent,
    child: null,
    sibling: null,
    stateNode: spec.stateNode || null,
  };
  if (spec.children && spec.children.length) {
    let prev = null;
    for (const c of spec.children) {
      const child = buildFiber(c, fiber);
      if (!fiber.child) fiber.child = child; else prev.sibling = child;
      prev = child;
    }
  }
  return fiber;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/harness-smoke.test.js`
Expected: PASS — `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/test/unit/helpers/inject-harness.js scripts/cdp-bridge/test/unit/harness-smoke.test.js
git commit -m "test(selector): shared injected-helpers vm test harness (Phase 1 Task 0)"
```

---

### Task 1 — Port matches() and normalizer to __match

Port RNTL `src/matches.ts` (`matches()` + `getDefaultNormalizer()`) to ES5 as `__RN_AGENT.__match`. The RNTL source (`/Users/anton_personal/GitHub/react-native-testing-library/src/matches.ts`) has two functions: `matches(matcher, text, normalizer, exact)` returns `false` when `typeof text !== 'string'`, normalizes `text`, and for a string matcher compares normalized exact-equality (`exact`) or case-insensitive `includes` (`!exact`); for a regex matcher it resets `lastIndex = 0` then `test()`s. `getDefaultNormalizer()` returns a fn that `trim()`s then `replace(/\s+/g, ' ')`s — it does NOT lowercase.

Our `__match` collapses RNTL's two args (matcher, text) plus options into a single `matcher` object per INTERFACES: `{value, exact?}` for strings, `{regexSource, regexFlags?}` for regexes. The string lowercasing for non-exact matching lives INSIDE the comparison (RNTL line 24 `.toLowerCase()`), NOT in the normalizer — this is the divergence the guard test proves. The new normalizer must stay separate from the existing `norm()` at `injected-helpers.ts:1114` which DOES lowercase.

**Files**
- Create: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/gh-port-task1-match.test.js`
- Modify: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/src/injected-helpers.ts`
- Test: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/gh-port-task1-match.test.js`

**Interfaces**
- Consumes (from Task 0 harness `./helpers/inject-harness.js`):
  - `createSandbox(opts) -> sandbox` — when `opts.fiberRoot` is set, wires `__REACT_DEVTOOLS_GLOBAL_HOOK__`; returns the vm sandbox exposing `sandbox.__RN_AGENT`.
  - `buildFiber(spec, parent) -> fiber` — `{type, memoizedProps, return, child, sibling}`.
  - `INJECTED_HELPERS` (string) re-exported for source-drift guards (or imported directly from `../../dist/injected-helpers.js`).
- Produces (later tasks rely on this EXACT signature):
  - `__RN_AGENT.__match(text, matcher) -> boolean`. `matcher` is `{value: string, exact?: boolean}` (string match: `exact:true` → normalized full-string equality; `exact` false/absent → case-insensitive substring) OR `{regexSource: string, regexFlags?: string}` (compiled in try/catch, `lastIndex` reset, global flag stripped, candidate length-capped). Returns `false` when `text` is not a string or matcher is malformed. Normalizer trims + collapses whitespace runs to one space and does NOT lowercase. Consumed by `__accessibleName`/`resolveLadder` (testID/role/name/text/placeholder ladder) in later tasks.

**Steps**

- [ ] **Step 1 — Write the failing test.** Create `test/unit/gh-port-task1-match.test.js`:

```js
// Task 1 / port: RNTL matches() + getDefaultNormalizer -> __RN_AGENT.__match.
// Single-matcher form: {value,exact?} for strings, {regexSource,regexFlags?}
// for regexes. Normalizer trims + collapses whitespace but does NOT lowercase
// (RNTL's case-insensitivity lives in the non-exact string compare, not the
// normalizer — kept separate from the existing lowercasing norm() at
// injected-helpers.ts:1114).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

function sb() {
  // __match is a pure helper; a minimal root keeps createSandbox happy.
  const root = buildFiber({ name: 'App', children: [] });
  return createSandbox({ fiberRoot: root });
}

test('1: {value:"Login",exact:true} matches "Login" not "Login button"', () => {
  const s = sb();
  assert.equal(s.__RN_AGENT.__match('Login', { value: 'Login', exact: true }), true);
  assert.equal(s.__RN_AGENT.__match('Login button', { value: 'Login', exact: true }), false);
});

test('2: {value:"detail"} case-insensitively substring-matches "DeTaiLs"', () => {
  const s = sb();
  assert.equal(s.__RN_AGENT.__match('DeTaiLs', { value: 'detail' }), true);
});

test('3: normalizer trims + collapses inner whitespace before compare', () => {
  const s = sb();
  assert.equal(s.__RN_AGENT.__match('  Hello   World  ', { value: 'Hello World', exact: true }), true);
});

test('4: {regexSource:"^Save$"} matches "Save" not "Saved"', () => {
  const s = sb();
  assert.equal(s.__RN_AGENT.__match('Save', { regexSource: '^Save$' }), true);
  assert.equal(s.__RN_AGENT.__match('Saved', { regexSource: '^Save$' }), false);
});

test('5: {regexSource:"a",regexFlags:"g"} matches on two consecutive calls (lastIndex reset)', () => {
  const s = sb();
  const m = { regexSource: 'a', regexFlags: 'g' };
  assert.equal(s.__RN_AGENT.__match('cat', m), true);
  assert.equal(s.__RN_AGENT.__match('cat', m), true);
});

test('6: text undefined returns false', () => {
  const s = sb();
  assert.equal(s.__RN_AGENT.__match(undefined, { value: 'x' }), false);
});

test('divergence guard: {value:"ABC",exact:true} does NOT match "abc" (no lowercasing)', () => {
  const s = sb();
  assert.equal(s.__RN_AGENT.__match('abc', { value: 'ABC', exact: true }), false);
});

// ── source-grep regression guard (mirrors gh-60-bug-5-label-matching.test.js:422-432) ──
test('source guard: __match helper is attached and wired', () => {
  assert.match(INJECTED_HELPERS, /function __match\(/);
  assert.match(INJECTED_HELPERS, /__match: __match/);
  assert.match(INJECTED_HELPERS, /function __matchNormalize\(/);
});
```

- [ ] **Step 2 — Run the test, verify it fails.** Command:
  ```
  cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/gh-port-task1-match.test.js
  ```
  Expected failure: the build succeeds but every test errors with `TypeError: s.__RN_AGENT.__match is not a function` (method not yet attached), and the source guard fails with `AssertionError ... INJECTED_HELPERS ... /function __match\(/`. TAP summary shows `# pass 0` / `# fail 8`.

- [ ] **Step 3 — Write the minimal implementation.** Two edits in `src/injected-helpers.ts`.

  **Edit 3a — define `__matchNormalize` + `__match` as a private helper before the public surface.** Insert immediately AFTER the `readControlledState` closer `}` at `injected-helpers.ts:1900` and BEFORE the `// Public API` comment at line 1902. Anchor (exact existing lines):
  ```js
      if (found.length === 1) return JSON.stringify({ value: found[0], controlled: true });
      return JSON.stringify({ value: null, controlled: false });
    }

    // Public API
    globalThis.__RN_AGENT = {
  ```
  Becomes (insert the new block between the closing `}` and `// Public API`):
  ```js
      if (found.length === 1) return JSON.stringify({ value: found[0], controlled: true });
      return JSON.stringify({ value: null, controlled: false });
    }

    // Port of RNTL getDefaultNormalizer (matches.ts:37-47): trim + collapse
    // whitespace runs to a single space. Does NOT lowercase — case-insensitivity
    // for non-exact string matching lives in __match's compare (RNTL matches.ts:24),
    // NOT here. Kept deliberately separate from norm() (line ~1114) which DOES
    // lowercase for the legacy interact() label tiers.
    function __matchNormalize(v) {
      return String(v).replace(/^\\s+|\\s+$/g, '').replace(/\\s+/g, ' ');
    }

    // Port of RNTL matches() (matches.ts:9-30) collapsed to a single matcher
    // object: {value,exact?} for strings, {regexSource,regexFlags?} for regexes.
    // Returns false on non-string text or malformed matcher. Regex is compiled in
    // try/catch, the global flag is stripped so lastIndex never carries across
    // calls, and the candidate is length-capped to bound catastrophic backtracking.
    var __MATCH_MAX_LEN = 10000;
    function __match(text, matcher) {
      if (typeof text !== 'string') return false;
      if (!matcher || typeof matcher !== 'object') return false;
      var normalizedText = __matchNormalize(text);
      if (normalizedText.length > __MATCH_MAX_LEN) {
        normalizedText = normalizedText.slice(0, __MATCH_MAX_LEN);
      }
      if (typeof matcher.regexSource === 'string') {
        try {
          var flags = (matcher.regexFlags || '').replace(/g/g, '');
          var re = new RegExp(matcher.regexSource, flags);
          re.lastIndex = 0;
          return re.test(normalizedText);
        } catch (_) {
          return false;
        }
      }
      if (typeof matcher.value !== 'string') return false;
      var normalizedMatcher = __matchNormalize(matcher.value);
      if (matcher.exact) {
        return normalizedText === normalizedMatcher;
      }
      return normalizedText.toLowerCase().indexOf(normalizedMatcher.toLowerCase()) >= 0;
    }

    // Public API
    globalThis.__RN_AGENT = {
  ```
  (Note: the backslashes in the regex literals are doubled — `\\s` — because the entire IIFE is a JS template string; the existing `norm()` at line 1115 uses the same `\\s+` convention.)

  **Edit 3b — attach `__match` to the public surface.** In the `globalThis.__RN_AGENT = {` object literal (`injected-helpers.ts:1903`), add the method next to the other `__`-prefixed internals. Anchor:
  ```js
      __extractFiberFromInstance: extractFiberFromInstance,
      __findAllRootFibers: findAllRootFibers,
      __forEachRootFiber: forEachRootFiber,
  ```
  Becomes:
  ```js
      __extractFiberFromInstance: extractFiberFromInstance,
      __findAllRootFibers: findAllRootFibers,
      __forEachRootFiber: forEachRootFiber,
      __match: __match,
  ```

  **Edit 3c — increment `HELPERS_VERSION`.** At `injected-helpers.ts:5`:
  ```js
  export const HELPERS_VERSION = 26;
  ```
  Becomes:
  ```js
  export const HELPERS_VERSION = 27;
  ```

- [ ] **Step 4 — Run the test, verify it passes.** Command:
  ```
  cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/gh-port-task1-match.test.js
  ```
  Expected: `tsc` build clean, TAP summary `# tests 8` / `# pass 8` / `# fail 0`.

- [ ] **Step 5 — Commit.** Stage the exact files and commit:
  ```
  cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && \
  git add src/injected-helpers.ts test/unit/gh-port-task1-match.test.js && \
  git commit -m "feat(resolver): port RNTL matches() + normalizer to __RN_AGENT.__match

Single-matcher form ({value,exact?} | {regexSource,regexFlags?}); trim+collapse
normalizer that does NOT lowercase (case-insensitivity lives in the non-exact
compare). Bumps HELPERS_VERSION 26->27.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

**Notes (DRY/YAGNI/TDD):** `__matchNormalize` is intentionally NOT reusing `norm()` (line 1114) because `norm()` lowercases, which would break the divergence guard — the two normalizers serve different callers and must stay separate per INTERFACES. No StyleSheet/host logic is touched here (YAGNI for Task 1). The length cap (`__MATCH_MAX_LEN`) is the only addition beyond a literal RNTL port and is required by the INTERFACES contract ("candidate length-capped").

---

### Task 2: Fiber host-kind adapter `__hostKind`

Port RNTL's `isHostText` / `isHostTextInput` / `isHostImage` / `isHostSwitch` / `isHostScrollView` / `isHostModal` family (`react-native-testing-library/src/helpers/host-component-names.ts:14-56`) into a single live-fiber classifier `__RN_AGENT.__hostKind(fiber)`. RNTL keys off `instance.type` being a `string`; live fibers store the host name either as a raw `string` `fiber.type` OR as `fiber.type.displayName`/`fiber.type.name` (native views like `RCTSinglelineTextInputView`). We reuse the existing `getName` (`injected-helpers.ts:252-255`) so both shapes resolve, then map the name to one of `text | textinput | image | switch | scrollview | modal | null`. The name lists are widened beyond RNTL's RNTL-renderer-only set to the native host names per FIXED INTERFACES (e.g. `RCTTextInput`, `RCTImageView`, `RCTModalHostView`) because live fibers expose the platform view name, not the JS component name.

This is a pure helper: it returns a RAW string (or `null`), not JSON. Later tasks (`__role` Task 3, `__accessibleName`, `__hidden`, `resolveLadder`) consume it directly.

#### Files
- Modify: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/src/injected-helpers.ts` (add `hostKind` fn inside the IIFE; attach as `__hostKind` on the `__RN_AGENT` surface; bump `HELPERS_VERSION` 26 → 27)
- Test: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/gh-task2-hostkind.test.js` (new)

#### Interfaces
**Consumes** (from Task 0 harness `test/unit/helpers/inject-harness.js`):
- `createSandbox(opts) → sandbox` — runs `INJECTED_HELPERS` in a vm; with `opts.fiberRoot` set, installs `__REACT_DEVTOOLS_GLOBAL_HOOK__` (renderers `Map([[1,{}]])`, `getFiberRoots(1) → Set([{current: opts.fiberRoot}])`). Returns the sandbox; `sandbox.__RN_AGENT` is the public surface.
- `buildFiber(spec, parent?) → fiber` — `fiber.type` is `{displayName: spec.name}` when `spec.name` set, else the `spec.hostType` string, else `null`; `fiber.memoizedProps` is `spec.props` (or the raw `spec.text` string for a text node); `fiber.return = parent`; `child`/`sibling` wired from `spec.children`.
- `getName(fiber)` (internal, `injected-helpers.ts:252-255`): `fiber.type.displayName || fiber.type.name || null`; returns `null` when `fiber.type` is itself a string, so `hostKind` reads `fiber.type` directly first.

**Produces** (relied on by Tasks 3+):
- `__RN_AGENT.__hostKind(fiber) → 'text' | 'textinput' | 'image' | 'switch' | 'scrollview' | 'modal' | null`. Pure, side-effect-free, returns a RAW value. `null` for plain Views, user components, text nodes (tag 6), and `fiber.type === null`.

---

- [ ] **Step 1 — Write the failing test**

Create `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/gh-task2-hostkind.test.js`:

```js
// Task 2 / FIXED INTERFACES: __RN_AGENT.__hostKind(fiber) classifies a live host
// fiber into text|textinput|image|switch|scrollview|modal|null. Ports RNTL
// host-component-names.ts (isHostText/isHostTextInput/...), widened to native
// view names (RCTText, RCTSinglelineTextInputView, RCTImageView, RCTModalHostView,
// ...) because live fibers carry the platform view name, not the JS name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

// Helper: wrap one host/component child under an App root so createSandbox has a
// fiberRoot to mount, then hand the child fiber straight to __hostKind.
function kindOf(childSpec) {
  const root = buildFiber({ name: 'App', children: [childSpec] });
  const sb = createSandbox({ fiberRoot: root });
  return sb.__RN_AGENT.__hostKind(root.child);
}

test('__hostKind: host Text (string type) → "text"', () => {
  assert.equal(kindOf({ hostType: 'Text' }), 'text');
});

test('__hostKind: native RCTText → "text"', () => {
  assert.equal(kindOf({ hostType: 'RCTText' }), 'text');
});

test('__hostKind: host TextInput → "textinput"', () => {
  assert.equal(kindOf({ hostType: 'TextInput' }), 'textinput');
});

test('__hostKind: native RCTSinglelineTextInputView → "textinput"', () => {
  assert.equal(kindOf({ hostType: 'RCTSinglelineTextInputView' }), 'textinput');
});

test('__hostKind: host Image → "image"', () => {
  assert.equal(kindOf({ hostType: 'Image' }), 'image');
});

test('__hostKind: native RCTImageView → "image"', () => {
  assert.equal(kindOf({ hostType: 'RCTImageView' }), 'image');
});

test('__hostKind: host Switch → "switch"', () => {
  assert.equal(kindOf({ hostType: 'Switch' }), 'switch');
});

test('__hostKind: native RCTScrollView → "scrollview"', () => {
  assert.equal(kindOf({ hostType: 'RCTScrollView' }), 'scrollview');
});

test('__hostKind: native RCTModalHostView → "modal"', () => {
  assert.equal(kindOf({ hostType: 'RCTModalHostView' }), 'modal');
});

test('__hostKind: plain host View → null', () => {
  assert.equal(kindOf({ hostType: 'View' }), null);
});

test('__hostKind: user component MyButton → null', () => {
  assert.equal(kindOf({ name: 'MyButton' }), null);
});

test('__hostKind: fiber with null type → null', () => {
  const root = buildFiber({ name: 'App', children: [{ name: 'MyButton' }] });
  const sb = createSandbox({ fiberRoot: root });
  // App root's own type is {displayName:'App'} — a component, not a host kind.
  assert.equal(sb.__RN_AGENT.__hostKind({ type: null, memoizedProps: {} }), null);
});

test('__hostKind: text node (tag 6, string memoizedProps) → null', () => {
  const root = buildFiber({ name: 'App', children: [{ text: 'hello' }] });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__RN_AGENT.__hostKind(root.child), null);
});

test('__hostKind: undefined fiber → null (defensive)', () => {
  const root = buildFiber({ name: 'App', children: [{ hostType: 'Text' }] });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__RN_AGENT.__hostKind(undefined), null);
});

// ── source-drift guard: a refactor that drops __hostKind fails CI ──────────
// Mirrors gh-60-bug-5-label-matching.test.js:422-432.
test('source guard: __hostKind is defined and exported on the surface', () => {
  assert.match(INJECTED_HELPERS, /function hostKind\(fiber\)/);
  assert.match(INJECTED_HELPERS, /__hostKind: hostKind/);
  assert.match(INJECTED_HELPERS, /RCTSinglelineTextInputView/);
  assert.match(INJECTED_HELPERS, /RCTModalHostView/);
});
```

- [ ] **Step 2 — Run the test, verify it fails**

```bash
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/gh-task2-hostkind.test.js
```

Expected: the build succeeds (no `__hostKind` change yet), then the runtime tests fail because `sb.__RN_AGENT.__hostKind` is `undefined` — e.g.:

```
✖ __hostKind: host Text (string type) → "text"
  TypeError: sb.__RN_AGENT.__hostKind is not a function
...
✖ source guard: __hostKind is defined and exported on the surface
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /function hostKind\(fiber\)/
...
# fail 15
```

(A non-zero `# fail` count — the exact number is the test count above — confirms RED.)

- [ ] **Step 3 — Write the minimal implementation**

**3a. Add the `hostKind` function.** Insert it immediately after `getName` so it sits next to the name-resolution it reuses. Anchor (`injected-helpers.ts:252-255`):

```js
    function getName(fiber) {
      if (!fiber || !fiber.type) return null;
      return fiber.type.displayName || fiber.type.name || null;
    }
```

Insert directly below that closing brace:

```js

    // Task 2 — live-fiber host-kind classifier. Ports RNTL host-component-names.ts
    // (isHostText/isHostTextInput/isHostImage/isHostSwitch/isHostScrollView/
    // isHostModal). RNTL keys off a STRING instance.type; live fibers carry the
    // host name as a raw string fiber.type OR as fiber.type.displayName/name for
    // native views, so we resolve a string `name` from both shapes via getName.
    // Name lists are widened to the native view names (RCTSinglelineTextInputView,
    // RCTImageView, RCTModalHostView, ...) per FIXED INTERFACES because the live
    // tree exposes the platform view name, not the JS component name. Returns null
    // for plain Views, user components, text nodes (tag 6) and null types.
    var HOST_KIND_NAMES = {
      text: ['Text', 'RCTText'],
      textinput: ['TextInput', 'RCTTextInput', 'RCTSinglelineTextInputView', 'RCTMultilineTextInputView'],
      image: ['Image', 'RCTImageView', 'RCTImage'],
      switch: ['Switch', 'RCTSwitch'],
      scrollview: ['ScrollView', 'RCTScrollView'],
      modal: ['Modal', 'RCTModalHostView']
    };
    var HOST_KIND_LOOKUP = (function() {
      var map = {};
      var kinds = Object.keys(HOST_KIND_NAMES);
      for (var ki = 0; ki < kinds.length; ki++) {
        var names = HOST_KIND_NAMES[kinds[ki]];
        for (var ni = 0; ni < names.length; ni++) map[names[ni]] = kinds[ki];
      }
      return map;
    })();

    function hostKind(fiber) {
      if (!fiber || !fiber.type) return null;
      // Text nodes (tag 6) have a string memoizedProps and are NOT a host kind.
      if (fiber.tag === 6) return null;
      var name = typeof fiber.type === 'string' ? fiber.type : getName(fiber);
      if (!name) return null;
      var kind = HOST_KIND_LOOKUP[name];
      return kind || null;
    }
```

**3b. Attach to the public surface.** Anchor (`injected-helpers.ts:1918-1920`):

```js
    __extractFiberFromInstance: extractFiberFromInstance,
    __findAllRootFibers: findAllRootFibers,
    __forEachRootFiber: forEachRootFiber,
```

Add the `__hostKind` line directly after `__forEachRootFiber`:

```js
    __extractFiberFromInstance: extractFiberFromInstance,
    __findAllRootFibers: findAllRootFibers,
    __forEachRootFiber: forEachRootFiber,
    __hostKind: hostKind,
```

**3c. Bump the version.** Anchor (`injected-helpers.ts:5`):

```js
export const HELPERS_VERSION = 26;
```

Change to:

```js
export const HELPERS_VERSION = 27;
```

- [ ] **Step 4 — Run the test, verify it passes**

```bash
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/gh-task2-hostkind.test.js
```

Expected: a node `--test` TAP summary with all 15 tests passing and `# fail 0`, e.g.:

```
# tests 15
# pass 15
# fail 0
```

- [ ] **Step 5 — Commit**

```bash
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && git add src/injected-helpers.ts test/unit/gh-task2-hostkind.test.js && git commit -m "$(cat <<'EOF'
feat(cdp): add __RN_AGENT.__hostKind live-fiber host classifier

Port RNTL host-component-names (isHostText/TextInput/Image/Switch/
ScrollView/Modal) into a single hostKind(fiber) that maps a host name
(string fiber.type or fiber.type.displayName/name) to one of
text|textinput|image|switch|scrollview|modal|null. Name lists widened
to native view names (RCTSinglelineTextInputView, RCTImageView,
RCTModalHostView, ...) since live fibers expose the platform view name.
Reuses getName; returns null for Views, user components, text nodes,
and null types. Bumps HELPERS_VERSION 26 -> 27.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Port getRole to __role

Port RNTL `getRole` + `normalizeRole` (`/Users/anton_personal/GitHub/react-native-testing-library/src/helpers/accessibility.ts:117-146`) to ES5 as `__RN_AGENT.__role`, consuming `__hostKind` from Task 2. The role resolution order is: explicit `memoizedProps.role` else `memoizedProps.accessibilityRole` (normalized, `image`→`img`); else if `__hostKind` is `text` return `text`; else `none`. This deliberately does NOT reuse the digest `inferRole` at `injected-helpers.ts:369-380`, which defaults Pressable/Touchable/Button to `button` and falls through to `button` — behavior the divergence-guard test pins against.

#### Files

- Modify: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/src/injected-helpers.ts` (add `__role` + `normalizeRole` inside the IIFE, attach to `__RN_AGENT`, bump `HELPERS_VERSION` 26→27)
- Test: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/gh-task3-role.test.js` (create)

#### Interfaces

Consumes (from Task 2, already attached to the IIFE surface):

- `__RN_AGENT.__hostKind(fiber)` → returns one of `text`, `textinput`, `image`, `switch`, `scrollview`, `modal`, or `null`. `__role` calls the in-IIFE `__hostKind` function directly (not via the surface object) to derive the `text` fallback.

Produces (later tasks — `__accessibleName` Task 4 host-text detection, `resolveLadder`/`interact` role filtering — rely on this exact signature):

- `__RN_AGENT.__role(fiber)` → returns a `string`. Always a string: explicit normalized role, or `text`, or `none`. Never `undefined`/`null`. Pure (no side effects, returns a RAW value, not JSON).

#### Step 1 — Write the failing test

- [ ] Create `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/gh-task3-role.test.js`:

```js
// Task 3 / __role: port of RNTL getRole + normalizeRole
// (react-native-testing-library/src/helpers/accessibility.ts:117-146).
//
// Role order: explicit role prop → accessibilityRole (image→img) → host
// Text gives "text" → "none". Critically NOT the digest inferRole
// (injected-helpers.ts:369-380), which defaults Pressable/Touchable/Button
// and the final fall-through to "button". The last test pins that divergence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

function role(spec) {
  const root = buildFiber(spec);
  const sb = createSandbox({ fiberRoot: root });
  return sb.__RN_AGENT.__role(root);
}

test('__role: explicit accessibilityRole button gives button', () => {
  assert.equal(role({ name: 'View', props: { accessibilityRole: 'button' } }), 'button');
});

test('__role: role prop wins over accessibilityRole', () => {
  assert.equal(
    role({ name: 'View', props: { role: 'link', accessibilityRole: 'button' } }),
    'link',
  );
});

test('__role: role image gives img', () => {
  assert.equal(role({ name: 'View', props: { role: 'image' } }), 'img');
});

test('__role: host Text gives text', () => {
  assert.equal(role({ hostType: 'Text', props: {} }), 'text');
});

test('__role: plain View gives none', () => {
  assert.equal(role({ name: 'View', props: {} }), 'none');
});

// Divergence guard: digest inferRole (injected-helpers.ts:369-380) would
// return "button" for a Pressable with an onPress handler and no role.
// __role must NOT reuse it: it returns "none".
test('__role: Pressable with onPress and NO role gives none (not button)', () => {
  assert.equal(
    role({ name: 'Pressable', props: { onPress: function () {} } }),
    'none',
  );
});

// Source-drift guard: a refactor that drops __role fails CI.
test('source guard: __role is present in injected helpers', () => {
  assert.match(INJECTED_HELPERS, /__role: __role/);
  assert.match(INJECTED_HELPERS, /function __role\(/);
  assert.match(INJECTED_HELPERS, /return 'img';/);
});
```

#### Step 2 — Run the test, verify it fails

- [ ] Run:

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/gh-task3-role.test.js
```

Expected failure: the surface has no `__role`, so `sb.__RN_AGENT.__role` is `undefined` and the call throws. The run reports failing tests with `TypeError: sb.__RN_AGENT.__role is not a function` (and the source guard fails its `assert.match` for `/__role: __role/`). The TAP summary shows `# pass 0` / `# fail 7` (non-zero fail).

#### Step 3 — Write the minimal implementation

- [ ] In `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/src/injected-helpers.ts`, bump `HELPERS_VERSION` from 26 to 27 (line 5):

Replace:

```ts
export const HELPERS_VERSION = 26;
```

with:

```ts
export const HELPERS_VERSION = 27;
```

- [ ] Add the `normalizeRole` + `__role` ES5 functions inside the IIFE, immediately before the `// Public API` comment at `injected-helpers.ts:1902`. The closing `}` of `getControlledValue` (`return JSON.stringify({ value: null, controlled: false });` / `}` at lines 1899-1900) is the anchor.

Replace:

```js
    if (found.length === 1) return JSON.stringify({ value: found[0], controlled: true });
    return JSON.stringify({ value: null, controlled: false });
  }

  // Public API
  globalThis.__RN_AGENT = {
```

with:

```js
    if (found.length === 1) return JSON.stringify({ value: found[0], controlled: true });
    return JSON.stringify({ value: null, controlled: false });
  }

  // ── Accessibility role (RNTL getRole + normalizeRole port) ──────────────
  // Port of react-native-testing-library accessibility.ts:117-146. Order:
  // explicit role prop → accessibilityRole (image→img) → host Text → none.
  // Deliberately NOT the digest inferRole (defaults Pressable/Touchable to
  // button); see gh-task3-role.test.js divergence guard.
  function normalizeRole(role) {
    if (role === 'image') return 'img';
    return role;
  }

  function __role(fiber) {
    if (!fiber) return 'none';
    var props = fiber.memoizedProps;
    var explicitRole = props && typeof props === 'object'
      ? (props.role != null ? props.role : props.accessibilityRole)
      : null;
    if (explicitRole) return normalizeRole(String(explicitRole));
    if (__hostKind(fiber) === 'text') return 'text';
    return 'none';
  }

  // Public API
  globalThis.__RN_AGENT = {
```

- [ ] Attach `__role` to the `__RN_AGENT` surface object. The `isReady` method at `injected-helpers.ts:1921` is the anchor; insert the `__role` entry just before it.

Replace:

```js
    __extractFiberFromInstance: extractFiberFromInstance,
    __findAllRootFibers: findAllRootFibers,
    __forEachRootFiber: forEachRootFiber,
    isReady: function() {
```

with:

```js
    __extractFiberFromInstance: extractFiberFromInstance,
    __findAllRootFibers: findAllRootFibers,
    __forEachRootFiber: forEachRootFiber,
    __role: __role,
    isReady: function() {
```

Notes:
- Uses `props.role != null ? ... : props.accessibilityRole` so `role` wins (mirrors RNTL's `??`), and an empty-string `role` (falsy) correctly falls through to the host-Text/none branches.
- Calls the in-IIFE `__hostKind` directly. Task 2 attaches `__hostKind` as both an IIFE function and a surface method, so this reference resolves at runtime.
- `normalizeRole` is local to the IIFE (YAGNI: not added to the surface; no test or later task references it via `__RN_AGENT`).

#### Step 4 — Run the test, verify it passes

- [ ] Run:

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/gh-task3-role.test.js
```

Expected: TAP summary with `# pass 7` and `# fail 0`. The 6 behavioral tests plus the source guard all pass.

#### Step 5 — Commit

- [ ] Stage the exact files and commit:

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && \
git add src/injected-helpers.ts test/unit/gh-task3-role.test.js && \
git commit -m "feat(injected-helpers): port RNTL getRole to __RN_AGENT.__role

Add normalizeRole + __role (explicit role → accessibilityRole image→img →
host Text → none), reusing __hostKind from Task 2. Does not reuse the digest
inferRole (which defaults Pressable to button); divergence pinned by test.
Bump HELPERS_VERSION 26→27.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Port computeAccessibleName to `__accessibleName`

Port RNTL's `computeAccessibleName` + `computeAriaLabel` + `getAriaLabelledByIds` + `joinAccessibleNameParts` (`/Users/anton_personal/GitHub/react-native-testing-library/src/helpers/accessibility.ts:152-318`) to ES5 as `__RN_AGENT.__accessibleName(fiber)`. The `labelledBy` resolver searches the whole fiber root (reachable via the DevTools hook `getFiberRoots`) for a node whose `memoizedProps.nativeID` matches the referenced id. Depends on `__hostKind` (Task 2).

**Files**
- Modify: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/src/injected-helpers.ts`
- Test: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/gh-accessible-name.test.js`
- (Consumed, not edited) Harness: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/helpers/inject-harness.js`

**Interfaces**

Consumes (from earlier tasks):
- `__RN_AGENT.__hostKind(fiber) -> 'text'|'textinput'|'image'|'switch'|'scrollview'|'modal'|null` (Task 2) — used to detect host text (inline join), host image (alt), host textinput (placeholder).
- `createSandbox({ fiberRoot }) -> sandbox` and `buildFiber(spec, parent) -> fiber` (Task 0 harness). `createSandbox` defines `__REACT_DEVTOOLS_GLOBAL_HOOK__` with `getFiberRoots(1) -> Set([{ current: fiberRoot }])`; the in-page `findActiveRenderer()` (injected-helpers.ts:22) walks renderer id 1 and exposes those roots.
- In-IIFE `forEachRootFiber(cb)` (injected-helpers.ts:111) — iterates every root fiber's `current`; reused by the labelledBy resolver to scan the whole tree.

Produces (later tasks rely on this exact signature):
- `__RN_AGENT.__accessibleName(fiber) -> string | undefined` — used by Task 7 (`resolveLadder` bundle `accessibleName` + `name` matching) and Task 7 (`interact` role/name routing).

---

- [ ] **Step 1 — Write the failing test**

Create `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/gh-accessible-name.test.js`:

```js
// Task 4: __accessibleName ports RNTL computeAccessibleName +
// computeAriaLabel + getAriaLabelledByIds + joinAccessibleNameParts
// (react-native-testing-library/src/helpers/accessibility.ts:152-318).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

// Build a tree, run helpers in a vm sandbox seeded with that root, and
// return the sandbox so tests can call sb.__RN_AGENT.__accessibleName(fiber).
function mount(spec) {
  const root = buildFiber(spec, null);
  const sb = createSandbox({ fiberRoot: root });
  return { sb, root };
}

// Walk child/sibling to find the first fiber matching a predicate.
function find(fiber, pred) {
  if (!fiber) return null;
  if (pred(fiber)) return fiber;
  return find(fiber.child, pred) || find(fiber.sibling, pred);
}

// (1) accessibilityLabelledBy nativeID ref wins over same-node accessibilityLabel
test('labelledBy nativeID ref wins over same-node accessibilityLabel', () => {
  const { sb, root } = mount({
    name: 'View',
    children: [
      { name: 'View', props: { nativeID: 'lbl', accessibilityLabel: 'From ref' } },
      {
        name: 'Pressable',
        props: { accessibilityLabelledBy: ['lbl'], accessibilityLabel: 'On node' },
      },
    ],
  });
  const target = find(root, (f) => f.memoizedProps && f.memoizedProps.accessibilityLabelledBy);
  assert.equal(sb.__RN_AGENT.__accessibleName(target), 'From ref');
});

// (2) labelledBy array joins multiple refs with a single space
test('labelledBy array joins refs with single space', () => {
  const { sb, root } = mount({
    name: 'View',
    children: [
      { name: 'View', props: { nativeID: 'a', accessibilityLabel: 'Hello' } },
      { name: 'View', props: { nativeID: 'b', accessibilityLabel: 'World' } },
      { name: 'Pressable', props: { accessibilityLabelledBy: ['a', 'b'] } },
    ],
  });
  const target = find(root, (f) => f.memoizedProps && f.memoizedProps.accessibilityLabelledBy);
  assert.equal(sb.__RN_AGENT.__accessibleName(target), 'Hello World');
});

// (3) aria-labelledby string form resolves the single ref
test('aria-labelledby string form resolves', () => {
  const { sb, root } = mount({
    name: 'View',
    children: [
      { name: 'View', props: { nativeID: 'x', accessibilityLabel: 'Labelled' } },
      { name: 'Pressable', props: { 'aria-labelledby': 'x' } },
    ],
  });
  const target = find(root, (f) => f.memoizedProps && f.memoizedProps['aria-labelledby']);
  assert.equal(sb.__RN_AGENT.__accessibleName(target), 'Labelled');
});

// (4) labelledBy resolving to empty does NOT fall back to accessibilityLabel
test('labelledBy resolving to empty does not fall back to accessibilityLabel', () => {
  const { sb, root } = mount({
    name: 'View',
    children: [
      // ref target exists but has no text/label -> empty accessible name
      { name: 'View', props: { nativeID: 'empty' } },
      { name: 'Pressable', props: { accessibilityLabelledBy: ['empty'], accessibilityLabel: 'Fallback' } },
    ],
  });
  const target = find(root, (f) => f.memoizedProps && f.memoizedProps.accessibilityLabelledBy);
  // RNTL: labelTexts filtered to defined; here the ref yields undefined text so
  // labelTexts is empty -> computeAriaLabel proceeds to explicit label branch.
  assert.equal(sb.__RN_AGENT.__accessibleName(target), 'Fallback');
});

// (5) plain accessibilityLabel / aria-label when no labelledBy
test('plain accessibilityLabel used when no labelledBy', () => {
  const { sb, root } = mount({ name: 'Pressable', props: { accessibilityLabel: 'Submit' } });
  assert.equal(sb.__RN_AGENT.__accessibleName(root), 'Submit');
});

test('aria-label used when no labelledBy', () => {
  const { sb, root } = mount({ name: 'Pressable', props: { 'aria-label': 'Close' } });
  assert.equal(sb.__RN_AGENT.__accessibleName(root), 'Close');
});

// (6) TextInput placeholder becomes name only at root; nested input does not leak up
test('TextInput placeholder is name at root', () => {
  const { sb, root } = mount({ hostType: 'TextInput', props: { placeholder: 'Email' } });
  assert.equal(sb.__RN_AGENT.__accessibleName(root), 'Email');
});

test('nested TextInput placeholder does not leak to ancestor name', () => {
  const { sb, root } = mount({
    name: 'View',
    children: [{ hostType: 'TextInput', props: { placeholder: 'Email' } }],
  });
  // root View has no label and its only child is a nested input (root:false),
  // whose placeholder is suppressed -> no parts -> empty -> undefined.
  assert.equal(sb.__RN_AGENT.__accessibleName(root), undefined);
});

// (7) Image alt gives name
test('host image alt gives name', () => {
  const { sb, root } = mount({ hostType: 'Image', props: { alt: 'Logo' } });
  assert.equal(sb.__RN_AGENT.__accessibleName(root), 'Logo');
});

// (8) inline-text join: two host-Text string children "Sign" + "In" -> "SignIn"
test('inline host-text string children join with empty string', () => {
  const { sb, root } = mount({
    hostType: 'Text',
    children: [
      { hostType: 'Text', children: [{ text: 'Sign' }] },
      { hostType: 'Text', children: [{ text: 'In' }] },
    ],
  });
  assert.equal(sb.__RN_AGENT.__accessibleName(root), 'SignIn');
});

// ── source-drift guard ─────────────────────────────────────────────────
test('source guard: __accessibleName helper present in injected source', () => {
  assert.match(INJECTED_HELPERS, /__accessibleName:\s*__accessibleName/);
  assert.match(INJECTED_HELPERS, /function __accessibleName\(/);
  assert.match(INJECTED_HELPERS, /function __ariaLabelledByIds\(/);
  assert.match(INJECTED_HELPERS, /accessibilityLabelledBy/);
});
```

- [ ] **Step 2 — Run the test, verify it fails**

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/gh-accessible-name.test.js
```

Expected failure: `__RN_AGENT.__accessibleName` is not yet on the surface, so every behavior assertion throws `TypeError: sb.__RN_AGENT.__accessibleName is not a function`, and the source guard fails with `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /__accessibleName:\s*__accessibleName/`. The TAP summary ends with a non-zero `# fail` count (`fail 11`).

- [ ] **Step 3 — Write the minimal implementation**

In `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/src/injected-helpers.ts`, insert the ES5 helper block **immediately before** the `// Public API` anchor at line 1902 (the line directly above `globalThis.__RN_AGENT = {`):

```
  }

  // Public API
  globalThis.__RN_AGENT = {
```

Insert between the closing `}` and `// Public API`:

```js
  }

  // ── Task 4: accessible-name computation (port of RNTL accessibility.ts:152-318) ──
  // Whitespace normalizer that preserves case (distinct from norm() at the
  // interact() tier matcher which lowercases). Trim + collapse ws runs to one.
  function __anNorm(s) {
    return String(s).replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '');
  }

  // getAriaLabelledByIds: aria-labelledby (string) -> [id]; accessibilityLabelledBy
  // array -> as-is; accessibilityLabelledBy string -> [id]; else [].
  function __ariaLabelledByIds(fiber) {
    var props = (fiber && fiber.memoizedProps) || {};
    var ariaLabelledBy = props['aria-labelledby'];
    if (typeof ariaLabelledBy === 'string') return [ariaLabelledBy];
    var accLabelledBy = props.accessibilityLabelledBy;
    if (Array.isArray(accLabelledBy)) return accLabelledBy;
    if (typeof accLabelledBy === 'string') return [accLabelledBy];
    return [];
  }

  // Find the first fiber in ANY root whose memoizedProps.nativeID === id.
  function __findByNativeID(id) {
    return forEachRootFiber(function(rootFiber) {
      var stack = [rootFiber];
      var guard = 0;
      while (stack.length) {
        if (++guard > 20000) return null;
        var f = stack.pop();
        if (!f) continue;
        if (f.memoizedProps && f.memoizedProps.nativeID === id) return f;
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
      return null;
    });
  }

  // computeAriaLabel: labelledBy refs (resolved to their accessible name) win;
  // then explicit aria-label/accessibilityLabel; then host image alt.
  function __ariaLabel(fiber) {
    var ids = __ariaLabelledByIds(fiber);
    if (ids.length > 0) {
      var labelTexts = [];
      for (var i = 0; i < ids.length; i++) {
        var ref = __findByNativeID(ids[i]);
        if (ref) {
          var refName = __accessibleName(ref);
          if (refName !== undefined) labelTexts.push(refName);
        }
      }
      if (labelTexts.length > 0) {
        return __anNorm(labelTexts.join(' '));
      }
    }

    var props = (fiber && fiber.memoizedProps) || {};
    var explicit = props['aria-label'];
    if (explicit === undefined || explicit === null) explicit = props.accessibilityLabel;
    if (explicit) return explicit;

    if (__hostKind(fiber) === 'image' && props.alt) return props.alt;

    return undefined;
  }

  // joinAccessibleNameParts: inline host-text neighbours join with '' else ' '.
  function __joinNameParts(parts, inline) {
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      if (i === 0) { out = parts[i].text; continue; }
      var prev = parts[i - 1];
      var sep = (inline && prev.isInlineText && parts[i].isInlineText) ? '' : ' ';
      out = out + sep + parts[i].text;
    }
    return out;
  }

  // computeAccessibleName: aria-label first; then host textinput placeholder
  // (root only); then recurse children, joining inline host-text with ''.
  function __accessibleName(fiber, root) {
    if (!fiber) return undefined;
    var label = __ariaLabel(fiber);
    if (label) return label;

    var props = fiber.memoizedProps || {};
    if (__hostKind(fiber) === 'textinput' && props.placeholder && root !== false) {
      return props.placeholder;
    }

    var parts = [];
    var child = fiber.child;
    while (child) {
      // A text node's memoizedProps is the raw string (RNTL string child).
      if (typeof child.memoizedProps === 'string') {
        if (child.memoizedProps) {
          parts.push({ text: child.memoizedProps, isInlineText: true });
        }
      } else {
        var childLabel = __accessibleName(child, false);
        if (childLabel) {
          parts.push({ text: childLabel, isInlineText: __hostKind(child) === 'text' });
        }
      }
      child = child.sibling;
    }

    var joined = __joinNameParts(parts, __hostKind(fiber) === 'text');
    return joined ? joined : undefined;
  }

  // Public API
  globalThis.__RN_AGENT = {
```

Then attach the helper to the public surface. Edit the `__RN_AGENT` object literal (injected-helpers.ts:1903-1920) to add the method alongside the other `__`-prefixed helpers — insert after the `__forEachRootFiber: forEachRootFiber,` line:

```js
    __forEachRootFiber: forEachRootFiber,
    __accessibleName: __accessibleName,
```

Finally, increment `HELPERS_VERSION` at injected-helpers.ts:5 by exactly 1:

```js
export const HELPERS_VERSION = 27;
```

Notes on the port:
- `instance.children` (RNTL) → the live `fiber.child` + `fiber.sibling` chain.
- RNTL string children → text fibers whose `memoizedProps` is the raw string (`buildFiber` wires `spec.text` to `memoizedProps`); detected with `typeof child.memoizedProps === 'string'`.
- `isHostText`/`isHostImage`/`isHostTextInput` → `__hostKind(fiber)` equality checks (Task 2), per shared constraints (no RNTL `host-component-names`).
- `getContainerInstance` + `findAll` over the container → `__findByNativeID` scanning every root via `forEachRootFiber` (whole-root search, as the interface requires).
- The empty-fallback case (test 4) follows RNTL exactly: a ref that resolves to `undefined` is filtered out of `labelTexts`, leaving it empty, so `__ariaLabel` proceeds to the explicit `accessibilityLabel` branch.

- [ ] **Step 4 — Run the test, verify it passes**

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/gh-accessible-name.test.js
```

Expected: TAP summary with `# pass 11`, `# fail 0` (8 behavior tests — two of which are split across the "plain label" and "TextInput"/"nested" groups for 11 total assertions blocks — plus the source guard), exit code 0.

- [ ] **Step 5 — Commit**

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && \
git add src/injected-helpers.ts test/unit/gh-accessible-name.test.js && \
git commit -m "feat(cdp-bridge): port computeAccessibleName to __accessibleName

Port RNTL computeAccessibleName + computeAriaLabel + getAriaLabelledByIds +
joinAccessibleNameParts to ES5 on __RN_AGENT. labelledBy refs resolved by
scanning all fiber roots for memoizedProps.nativeID; inline host-text joins
with empty string. Bumps HELPERS_VERSION 26 -> 27.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5 — Port `isHiddenFromAccessibility` to `__RN_AGENT.__hidden`

Port RNTL `isHiddenFromAccessibility` + `isSubtreeInaccessible` (`react-native-testing-library/src/helpers/accessibility.ts:25-85`, consumed by `find-all.ts:25-33`) to ES5 inside the `INJECTED_HELPERS` IIFE as `__RN_AGENT.__hidden`. Differences from the RNTL source we are porting: walk **`fiber.return`** instead of `instance.parent`; read **`fiber.memoizedProps`** instead of `instance.props`; there is **no `StyleSheet.flatten`** in-page, so flatten `memoizedProps.style` arrays manually; host-sibling aria-modal detection walks the live `fiber.return.child` + `.sibling` chain. The per-call `cache` WeakMap from RNTL is dropped (YAGNI — `__hidden` is called per-candidate, not in a hot filter loop here).

#### Files
- **Modify:** `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/src/injected-helpers.ts` (add `flattenStyle` + `isSubtreeInaccessible` + `__hidden` to the IIFE; attach `__hidden` to the `__RN_AGENT` surface; bump `HELPERS_VERSION` 26 → 27)
- **Test:** `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/gh-a11y-task5-hidden.test.js` (new)

#### Interfaces
**Consumes** (from earlier tasks / shared harness):
- `createSandbox(opts)` → `sandbox`; when `opts.fiberRoot` is set, defines `__REACT_DEVTOOLS_GLOBAL_HOOK__` with `renderers = Map([[1,{}]])` and `getFiberRoots(1)` → `Set([{ current: opts.fiberRoot }])`. From `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/helpers/inject-harness.js` (Task 0).
- `buildFiber(spec, parent)` → fiber-shaped object: `type` is `{ displayName: spec.name }` when `spec.name` set, else `spec.hostType` string, else `null`; `memoizedProps` is `spec.props` (or raw string `spec.text` for a text node); `return` is `parent`; `child`/`sibling` wired from `spec.children`. From the same harness.
- `INJECTED_HELPERS: string` from `../../dist/injected-helpers.js` (compiled by `npm run build`).

**Produces** (later tasks rely on this exact signature):
- `__RN_AGENT.__hidden(fiber) → boolean` — `true` if `fiber` is `null` OR any ancestor (self-inclusive, climbing `fiber.return`) is an inaccessible subtree (`aria-hidden`, `accessibilityElementsHidden`, `importantForAccessibility === 'no-hide-descendants'`, flattened `style.display === 'none'`, or an `aria-modal` / `accessibilityViewIsModal` host sibling); `false` otherwise. `opacity: 0` is NOT hidden. Task 6 (`resolveLadder`) and `interact()` filter candidates through `__hidden` unless `spec.includeHidden`.

---

- [ ] **Step 1 — Write the failing test**

Create `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/gh-a11y-task5-hidden.test.js`:

```js
// Task 5 / a11y ladder: __RN_AGENT.__hidden ports RNTL isHiddenFromAccessibility
// + isSubtreeInaccessible (accessibility.ts:25-85) to live fibers — climbing
// fiber.return (not instance.parent), reading memoizedProps, and flattening
// memoizedProps.style arrays manually (no StyleSheet.flatten in-page).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

// Build a single-child tree (root → leaf) and return { root, leaf }.
// rootProps lands on the ancestor, leafProps on the visible target.
function tree(rootProps, leafProps) {
  const root = buildFiber({ name: 'View', props: rootProps || {}, children: [] }, null);
  const leaf = buildFiber({ name: 'View', props: leafProps || {}, children: [] }, root);
  root.child = leaf;
  return { root, leaf };
}

test('__hidden: visible leaf → false', () => {
  const { root, leaf } = tree({}, {});
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__RN_AGENT.__hidden(leaf), false);
});

test('__hidden: null fiber → true', () => {
  const { root } = tree({}, {});
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__RN_AGENT.__hidden(null), true);
});

test('__hidden: aria-hidden on the node → true', () => {
  const { root, leaf } = tree({}, { 'aria-hidden': true });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__RN_AGENT.__hidden(leaf), true);
});

test('__hidden: accessibilityElementsHidden → true', () => {
  const { root, leaf } = tree({}, { accessibilityElementsHidden: true });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__RN_AGENT.__hidden(leaf), true);
});

test('__hidden: importantForAccessibility no-hide-descendants → true', () => {
  const { root, leaf } = tree({}, { importantForAccessibility: 'no-hide-descendants' });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__RN_AGENT.__hidden(leaf), true);
});

test('__hidden: style {display:none} → true', () => {
  const { root, leaf } = tree({}, { style: { display: 'none' } });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__RN_AGENT.__hidden(leaf), true);
});

test('__hidden: style array [{}, {display:none}] → true (flatten manually)', () => {
  const { root, leaf } = tree({}, { style: [{}, { display: 'none' }] });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__RN_AGENT.__hidden(leaf), true);
});

test('__hidden: visible child under aria-hidden ancestor → true (climb .return)', () => {
  const { root, leaf } = tree({ 'aria-hidden': true }, {});
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__RN_AGENT.__hidden(leaf), true);
});

test('__hidden: opacity 0 is NOT hidden → false', () => {
  const { root, leaf } = tree({}, { style: { opacity: 0 } });
  const sb = createSandbox({ fiberRoot: root });
  assert.equal(sb.__RN_AGENT.__hidden(leaf), false);
});

// ── source-drift guard (mirrors gh-60-bug-5-label-matching.test.js:422-432) ──
test('source guard: __hidden present in injected helpers', () => {
  assert.match(INJECTED_HELPERS, /__hidden:\s*__hidden/);
  assert.match(INJECTED_HELPERS, /function __hidden\(/);
  assert.match(INJECTED_HELPERS, /no-hide-descendants/);
});
```

- [ ] **Step 2 — Run the test, verify it fails**

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/gh-a11y-task5-hidden.test.js
```

Expected failure: `npm run build` succeeds (no source change yet), then `node --test` reports failures because `sb.__RN_AGENT.__hidden` is `undefined`. The first behavioural test throws `TypeError: sb.__RN_AGENT.__hidden is not a function`, and the source guard fails with `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /__hidden:\s*__hidden/`. The TAP summary shows a non-zero `# fail` (e.g. `# fail 10`).

- [ ] **Step 3 — Write the minimal implementation**

**3a. Insert the helper functions inside the IIFE.** Anchor on the `valueOf` / `readInputValue` block that ends just before the `// Public API` comment at `injected-helpers.ts:1900-1902`. Insert the new code **between** the closing `}` of that function and the `// Public API` line:

Existing anchor (`injected-helpers.ts:1899-1903`):
```js
    if (found.length === 1) return JSON.stringify({ value: found[0], controlled: true });
    return JSON.stringify({ value: null, controlled: false });
  }

  // Public API
  globalThis.__RN_AGENT = {
```

Replace with (new block inserted before `// Public API`):
```js
    if (found.length === 1) return JSON.stringify({ value: found[0], controlled: true });
    return JSON.stringify({ value: null, controlled: false });
  }

  // ── Task 5: accessibility "hidden" port (RNTL isHiddenFromAccessibility +
  // isSubtreeInaccessible). No StyleSheet.flatten in-page → flatten manually.
  // Walks fiber.return (live fibers) not instance.parent. opacity:0 is NOT
  // hidden (RNTL accessibility.ts:73). Per-call cache WeakMap dropped (YAGNI).
  function flattenStyle(style) {
    var out = {};
    if (style == null) return out;
    if (Array.isArray(style)) {
      for (var i = 0; i < style.length; i++) {
        var part = flattenStyle(style[i]);
        for (var k in part) if (part.hasOwnProperty(k)) out[k] = part[k];
      }
      return out;
    }
    if (typeof style === 'object') {
      for (var key in style) if (style.hasOwnProperty(key)) out[key] = style[key];
    }
    return out;
  }

  // True if `fiber` itself is an inaccessible-subtree root.
  function isSubtreeInaccessible(fiber) {
    var props = (fiber && fiber.memoizedProps) || {};
    if (props['aria-hidden']) return true;
    if (props.accessibilityElementsHidden) return true;
    if (props.importantForAccessibility === 'no-hide-descendants') return true;

    var flat = flattenStyle(props.style);
    if (flat.display === 'none') return true;

    // iOS: a host sibling marked aria-modal / accessibilityViewIsModal hides
    // this subtree. Siblings = children of fiber.return other than fiber.
    var parent = fiber && fiber.return;
    if (parent && parent.child) {
      for (var sib = parent.child; sib; sib = sib.sibling) {
        if (sib === fiber) continue;
        var sp = sib.memoizedProps;
        if (sp && (sp['aria-modal'] || sp.accessibilityViewIsModal)) return true;
      }
    }
    return false;
  }

  function __hidden(fiber) {
    if (fiber == null) return true;
    var current = fiber;
    var guard = 0;
    while (current && guard < 1000) {
      if (isSubtreeInaccessible(current)) return true;
      current = current.return;
      guard++;
    }
    return false;
  }

  // Public API
  globalThis.__RN_AGENT = {
```

**3b. Attach `__hidden` to the `__RN_AGENT` surface** (`injected-helpers.ts:1918-1920`, alongside the other `__`-prefixed pure helpers):

```js
    __extractFiberFromInstance: extractFiberFromInstance,
    __findAllRootFibers: findAllRootFibers,
    __forEachRootFiber: forEachRootFiber,
```
becomes:
```js
    __extractFiberFromInstance: extractFiberFromInstance,
    __findAllRootFibers: findAllRootFibers,
    __forEachRootFiber: forEachRootFiber,
    __hidden: __hidden,
```

**3c. Bump `HELPERS_VERSION`** at `injected-helpers.ts:5`:
```js
export const HELPERS_VERSION = 26;
```
becomes:
```js
export const HELPERS_VERSION = 27;
```

- [ ] **Step 4 — Run the test, verify it passes**

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/gh-a11y-task5-hidden.test.js
```

Expected: TAP summary with `# pass 10` / `# fail 0` (9 behavioural + 1 source-drift guard). Confirm the run ends with `# fail 0`.

- [ ] **Step 5 — Commit**

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && \
git add src/injected-helpers.ts test/unit/gh-a11y-task5-hidden.test.js && \
git commit -m "feat(a11y): port isHiddenFromAccessibility to __RN_AGENT.__hidden

Climbs fiber.return, flattens memoizedProps.style arrays manually (no
StyleSheet.flatten in-page), and treats aria-hidden /
accessibilityElementsHidden / importantForAccessibility=no-hide-descendants
/ display:none / aria-modal host siblings as hidden. opacity:0 is not
hidden. Bumps HELPERS_VERSION 26 -> 27.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Fail-closed truncation in interact() findFiber

Today `interact()`'s recursive `findFiber` walk has a bare silent cap at `src/injected-helpers.ts:1126` — `if (findCount > 8000) return;` — that unwinds the recursion without recording WHY. On a large tree whose target sits beyond node 8000, the walk stops, `found` stays `null` (or, for label matching, the partial tier arrays are evaluated), and `interact()` returns either `Component not found` or — worse — silently picks `tier[0]` from a PARTIAL scan and FIRES its `onPress`. That is a false action against the wrong element. This task makes the cap fail-closed: a budget that scales with `rootsSeeded` plus a 3s wall-clock guard, and on trip a `truncated` flag that forces `interact()` to return a structured `Resolution truncated` error and NEVER press anything.

The budget mirrors the salient-digest at `injected-helpers.ts:400` (`Math.min(cap, perRoot * roots)`) and its wall-clock guard at `:406` (`Date.now() - start < 3000`).

#### Files
- Modify: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/src/injected-helpers.ts`
- Test: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/gh-task6-interact-truncation.test.js`

#### Interfaces

Consumes (from earlier tasks / existing code, exact signatures):
- `createSandbox(opts)` and `buildFiber(spec, parent)` from `./helpers/inject-harness.js` (Task 0). `createSandbox({fiberRoot: root})` seeds `__REACT_DEVTOOLS_GLOBAL_HOOK__` (renderers `Map([[1,{}]])`, `getFiberRoots(1)` → `Set([{current: root}])`) and returns the sandbox. `buildFiber(spec,parent)` wires `type` ( `{displayName: spec.name}` when `spec.name`, else `spec.hostType` string, else `null`), `memoizedProps` (`spec.props`, or raw `spec.text` for text), `return`/`child`/`sibling`.
- `INJECTED_HELPERS` (string) and `HELPERS_VERSION` (number) exported from `../../dist/injected-helpers.js`.
- `__RN_AGENT.interact(opts)` → JSON string. `opts` includes `{action, testID?, accessibilityLabel?, text?}`. Existing returns: `{success:true,...}`, `{error:'Component not found',...}`, `{error:'Ambiguous component match',...}`, `{success:false, action_executed:true, handler_error}` (GH#250).

Produces (relied on by later tasks — the `resolveLadder`/`interact` extension in Task that follows):
- `__RN_AGENT.interact(opts)` gains a fail-closed branch: when the `findFiber` walk exceeds its node budget OR the 3s wall-clock guard, it returns the JSON string `{"error":"Resolution truncated","truncated":true,"scanned":<n>,"hint":"increase budget or scope with a container/anchor"}` and fires NO handler. The node budget is `Math.min(40000, 8000 * Math.max(1, rootsSeeded))` where `rootsSeeded` is the count of root fibers seeded into the walk via `forEachRootFiber`. This is the canonical "the resolver gave up, do not guess" signal later resolution layers branch on.

---

- [ ] **Step 1 — Write the failing test**

Create `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/gh-task6-interact-truncation.test.js`:

```js
// Task 6 / fail-closed truncation: interact()'s findFiber walk had a bare
// silent cap (if (findCount > 8000) return;) that unwound the recursion
// without recording WHY. On a tree whose target sits beyond the cap, interact()
// either returned "Component not found" or silently picked tier[0] from a
// PARTIAL scan and FIRED its onPress — a false action against the wrong node.
// The cap is now fail-closed: a rootsSeeded-scaled node budget + a 3s wall-clock
// guard set a `truncated` flag that forces a structured "Resolution truncated"
// error and fires NO handler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

// Build a single-root tree with `count` filler leaves BEFORE the target so the
// target is only reachable past the node budget. Fillers carry no matching
// testID; the target carries testID 'deep-target' with a press spy.
function buildOversizedTree(count, pressSpy) {
  const fillers = [];
  for (let i = 0; i < count; i++) {
    fillers.push({ name: 'Filler', props: { testID: 'filler-' + i } });
  }
  fillers.push({
    name: 'Pressable',
    props: { testID: 'deep-target', onPress: pressSpy },
  });
  return buildFiber({ name: 'App', children: fillers });
}

test('task6: target beyond the node budget returns truncated:true and fires no press', () => {
  let pressed = false;
  // Budget for 1 root = min(40000, 8000*1) = 8000. 12000 fillers pushes the
  // target well past the cap.
  const root = buildOversizedTree(12000, () => { pressed = true; });
  const sb = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sb.__RN_AGENT.interact({ action: 'press', testID: 'deep-target' }),
  );
  assert.equal(result.truncated, true);
  assert.equal(result.error, 'Resolution truncated');
  assert.equal(typeof result.scanned, 'number');
  assert.ok(result.scanned > 0);
  assert.match(result.hint, /increase budget or scope with a container\/anchor/);
  assert.equal(pressed, false, 'onPress must NOT fire on a truncated walk');
});

test('task6: truncation NEVER reports "Component not found" (fail-closed, not fail-missing)', () => {
  const root = buildOversizedTree(12000, () => {});
  const sb = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sb.__RN_AGENT.interact({ action: 'press', testID: 'deep-target' }),
  );
  assert.notEqual(result.error, 'Component not found');
  assert.equal(result.truncated, true);
});

test('task6: label-match truncation does NOT pick tier[0] from a partial scan', () => {
  // Two ambiguous-looking labels, both AFTER the cap; a partial scan must not
  // collapse to a single tier[0] pick and press it.
  let pressed = false;
  const fillers = [];
  for (let i = 0; i < 12000; i++) {
    fillers.push({ name: 'Filler', props: { testID: 'f-' + i } });
  }
  fillers.push({
    name: 'Pressable',
    props: { accessibilityLabel: 'Continue', onPress: () => { pressed = true; } },
  });
  const root = buildFiber({ name: 'App', children: fillers });
  const sb = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sb.__RN_AGENT.interact({ action: 'press', accessibilityLabel: 'Continue' }),
  );
  assert.equal(result.truncated, true);
  assert.equal(result.error, 'Resolution truncated');
  assert.equal(pressed, false);
});

test('task6 regression: a small tree still resolves and presses normally', () => {
  let pressed = false;
  const root = buildFiber({
    name: 'App',
    children: [
      { name: 'Filler', props: { testID: 'a' } },
      { name: 'Pressable', props: { testID: 'ok-btn', onPress: () => { pressed = true; } } },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const result = JSON.parse(
    sb.__RN_AGENT.interact({ action: 'press', testID: 'ok-btn' }),
  );
  assert.equal(result.success, true);
  assert.equal(result.truncated, undefined);
  assert.equal(pressed, true);
});

// ── source-drift guard (mirrors gh-60-bug-5-label-matching.test.js:422-432) ──

test('source guard: findFiber no longer has a bare cap-return without a truncation flag', () => {
  // The old silent unwind: `if (findCount > 8000) return;` with no flag set.
  assert.doesNotMatch(INJECTED_HELPERS, /if \(findCount > 8000\) return;/);
});

test('source guard: interact() carries the fail-closed truncation contract', () => {
  assert.match(INJECTED_HELPERS, /Resolution truncated/);
  assert.match(INJECTED_HELPERS, /findTruncated/);
  assert.match(INJECTED_HELPERS, /increase budget or scope with a container\/anchor/);
});
```

- [ ] **Step 2 — Run the test, verify it fails**

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/gh-task6-interact-truncation.test.js
```

Expected failure (against the current `:1126` bare cap): the budget tests fail because the current code returns `{error:'Component not found', ...}` (testID path) or evaluates an empty/partial tier — there is no `truncated`/`scanned`/`Resolution truncated` field, so `assert.equal(result.truncated, true)` and `assert.equal(result.error, 'Resolution truncated')` throw `AssertionError`. The source guards fail: `assert.doesNotMatch(INJECTED_HELPERS, /if \(findCount > 8000\) return;/)` throws because that exact line still exists, and `assert.match(INJECTED_HELPERS, /Resolution truncated/)` throws because the token is absent. TAP summary shows `# fail` > 0.

- [ ] **Step 3 — Write the minimal implementation**

All edits are in `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/src/injected-helpers.ts`, inside the `INJECTED_HELPERS` IIFE template string. No new `__RN_AGENT` surface method is needed — `interact` is already attached at `:1917`; the budget logic lives entirely inside `interact()`.

**3a. Add the budget + truncation state next to `findCount` (anchor `:1106-1107`).** Replace:

```js
    var found = null;
    var findCount = 0;
```

with:

```js
    var found = null;
    var findCount = 0;
    // Fail-closed truncation budget. Mirrors the salient-digest budget
    // (Math.min(cap, perRoot * roots)) and its wall-clock guard
    // (Date.now() - start < 3000). rootsSeeded is counted as roots are fed
    // into findFiber via forEachRootFiber below. On trip we set findTruncated
    // and unwind WITHOUT recording any match, so interact() returns a
    // structured "Resolution truncated" error and NEVER presses a partial pick.
    var findTruncated = false;
    var findStart = Date.now();
    var rootsSeeded = 0;
    var findBudget = 8000; // recomputed once rootsSeeded is known
```

**3b. Replace the bare cap-return inside `findFiber` (anchor `:1124-1126`).** Replace:

```js
      while (current) {
        findCount++;
        if (findCount > 8000) return;
```

with:

```js
      while (current) {
        if (findTruncated) return;
        findCount++;
        if (findCount > findBudget || (Date.now() - findStart) > 3000) {
          findTruncated = true;
          return;
        }
```

**3c. Count roots and recompute the budget at the `forEachRootFiber` call (anchor `:1160-1164`).** Replace:

```js
    forEachRootFiber(function(rootFiber) {
      if (!isLabelMatch && found) return found;
      findFiber(rootFiber);
      return isLabelMatch ? null : found;
    });
```

with:

```js
    // First pass purely to size the budget by how many roots we'll seed,
    // so a multi-renderer tree (LogBox + Fabric + Reanimated) gets proportional
    // headroom — same shape as the digest's Math.min(cap, perRoot * roots).
    forEachRootFiber(function() { rootsSeeded++; return null; });
    findBudget = Math.min(40000, 8000 * Math.max(1, rootsSeeded));
    forEachRootFiber(function(rootFiber) {
      if (findTruncated) return found;
      if (!isLabelMatch && found) return found;
      findFiber(rootFiber);
      return isLabelMatch ? null : found;
    });
```

**3d. Fail closed BEFORE any tier-select, Component-not-found, or press (anchor: immediately after the `forEachRootFiber` block, before the `if (isLabelMatch)` block at `:1166`).** Insert:

```js
    // Fail-closed: a tripped budget means the scan is INCOMPLETE. Never fall
    // through to the tier[0] pick, the "Component not found" branch, or onPress
    // — any of those would act on a partial view of the tree.
    if (findTruncated) {
      return JSON.stringify({
        error: 'Resolution truncated',
        truncated: true,
        scanned: findCount,
        hint: 'increase budget or scope with a container/anchor'
      });
    }

    if (isLabelMatch) {
```

(The original line `    if (isLabelMatch) {` is consumed by this replacement; keep the rest of the tier-select block unchanged.)

**3e. Bump `HELPERS_VERSION` (anchor `:5`).** Replace:

```js
export const HELPERS_VERSION = 26;
```

with:

```js
export const HELPERS_VERSION = 27;
```

No change to the `globalThis.__RN_AGENT = { ... interact: interact, ... }` surface at `:1903` — `interact` is already exposed and its signature is unchanged.

- [ ] **Step 4 — Run the test, verify it passes**

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/gh-task6-interact-truncation.test.js
```

Expected: TAP summary with all 6 tests passing and `# fail 0`. The oversized-tree tests now return `{error:'Resolution truncated', truncated:true, scanned:<n>, hint:'increase budget or scope with a container/anchor'}` with `pressed === false`; the small-tree regression still returns `{success:true}` with `pressed === true`; both source guards pass (`if (findCount > 8000) return;` is gone, and `Resolution truncated` / `findTruncated` / the hint string are present).

- [ ] **Step 5 — Commit**

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && \
git add src/injected-helpers.ts test/unit/gh-task6-interact-truncation.test.js && \
git commit -m "$(cat <<'EOF'
fix(injected): fail-closed truncation in interact() findFiber

Replace the silent `if (findCount > 8000) return;` cap with a
rootsSeeded-scaled node budget (Math.min(40000, 8000*roots)) plus a 3s
wall-clock guard, mirroring the salient-digest budget. On trip, set a
findTruncated flag and short-circuit interact() to return
{error:"Resolution truncated", truncated:true, scanned:<n>, hint:...}
BEFORE any tier[0] pick, "Component not found" branch, or onPress fire —
so a partial scan can never trigger a false action. Bump HELPERS_VERSION
26 -> 27.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

**Why fail-closed, not fail-missing:** the prior cap let a partial walk masquerade as "the element isn't here" (`Component not found`) or, on the label path, collapse the partial tier arrays into a single `tier[0]` and press it. Both are silent wrong answers. Returning `truncated:true` with `scanned` makes the incompleteness explicit and gives the caller (and the later `resolveLadder`/`interact` routing) an unambiguous signal to scope the query rather than guess. The budget scales with `rootsSeeded` because multi-renderer apps (LogBox + Fabric + Reanimated) legitimately have several roots; sizing off root count keeps real screens resolvable while still capping a pathological tree, and the 3s wall-clock guard bounds latency even when node count alone wouldn't.

---

### Task 7: resolveLadder and interact() ladder routing

Add `__RN_AGENT.resolveLadder(specJson)` and route `interact()` ladder specs (role/name/text/placeholder, no testID/accessibilityLabel) through it. Compose the pure helpers from Tasks 1-5 (`__match`, `__role`, `__accessibleName`, `__hidden`, `__hostKind`) plus the existing `forEachRootFiber(cb)` primitive. Collect ALL matches (no early return), exclude hidden unless `spec.includeHidden`, and return found/not-found/ambiguous in a JSON string. `interact()` presses the resolved fiber or walks `.return` to its nearest `onPress` ancestor.

**Files**
- Modify: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/src/injected-helpers.ts` (add `resolveLadder` inside the IIFE, attach to `__RN_AGENT`, route `interact()`, bump `HELPERS_VERSION` 26 → 27)
- Test: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/task7-resolve-ladder.test.js` (new)

**Interfaces**

Consumes (from earlier tasks, all attached to `__RN_AGENT` and callable as free functions inside the IIFE):
- `__match(text, matcher) -> boolean` — Task 1. `matcher = {value, exact?}`; absent `exact` is case-insensitive substring.
- `__hostKind(fiber) -> 'text'|'textinput'|'image'|'switch'|'scrollview'|'modal'|null` — Task 2.
- `__role(fiber) -> string` — Task 3. Explicit role/accessibilityRole (image→img), else `text` for host-Text, else `none`.
- `__accessibleName(fiber) -> string|undefined` — Task 4.
- `__hidden(fiber) -> boolean` — Task 5.
- `forEachRootFiber(cb)` — existing (`injected-helpers.ts:111`); `cb(rootFiber, rendererId)`, truthy return short-circuits, returns `null` to keep walking.

Produces (Task 8 / consumers rely on these exact shapes):
- `__RN_AGENT.resolveLadder(specJson: string) -> string` (JSON). `spec = {testID?, role?, name?, text?, placeholder?, exact?, includeHidden?}`. Returns `{found:true, bundle:{testID,text,accessibleName,role,placeholder,disabled,bounds}}` on a single match; `{found:false, error:"Component not found", hint}` on zero; `{found:false, error:"Ambiguous component match", count, matches:[descriptors], hint:"Add a testID"}` on >1.
- `interact(opts)` extension: when `opts` carries `role|name|text|placeholder` and NO `testID`/`accessibilityLabel`, route through `resolveLadder` then press the resolved fiber or its nearest `onPress` ancestor.

---

- [ ] **Step 1 — Write the failing test**

Create `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/task7-resolve-ladder.test.js`:

```js
// Task 7: resolveLadder() composes __match/__role/__accessibleName/__hidden
// into a byRole/byText/byPlaceholder ladder, and interact() routes role/name/
// text/placeholder specs through it, pressing the resolved fiber or its nearest
// onPress ancestor. Collect-all (no early return); 0 → not found, >1 → ambiguous,
// 1 → bundle. Hidden excluded unless includeHidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

// ── byRole + name → single match, bundle.role/accessibleName ────────────
test('resolveLadder: byRole button + name resolves a Pressable wrapping Text', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: { accessibilityRole: 'button', testID: 'go-dash', onPress: () => {} },
        children: [{ hostType: 'Text', children: [{ text: 'Go to Dashboard' }] }],
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(sb.__RN_AGENT.resolveLadder(JSON.stringify({ role: 'button', name: 'Go to Dashboard' })));
  assert.equal(res.found, true);
  assert.equal(res.bundle.role, 'button');
  assert.equal(res.bundle.accessibleName, 'Go to Dashboard');
  assert.equal(res.bundle.testID, 'go-dash');
});

// ── two identically-named un-testID Pressables → ambiguous, count 2 ─────
test('resolveLadder: two Continue buttons → Ambiguous component match, count 2', () => {
  const mk = () => ({
    name: 'Pressable',
    props: { accessibilityRole: 'button', onPress: () => {} },
    children: [{ hostType: 'Text', children: [{ text: 'Continue' }] }],
  });
  const root = buildFiber({ name: 'App', children: [mk(), mk()] });
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(sb.__RN_AGENT.resolveLadder(JSON.stringify({ role: 'button', name: 'Continue' })));
  assert.equal(res.found, false);
  assert.equal(res.error, 'Ambiguous component match');
  assert.equal(res.count, 2);
  assert.equal(res.matches.length, 2);
  assert.match(res.hint, /testID/);
});

// ── aria-hidden match excluded → not found unless includeHidden ─────────
test('resolveLadder: aria-hidden match excluded → Component not found', () => {
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'View',
        props: { 'aria-hidden': true },
        children: [
          {
            name: 'Pressable',
            props: { accessibilityRole: 'button', onPress: () => {} },
            children: [{ hostType: 'Text', children: [{ text: 'Hidden Action' }] }],
          },
        ],
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const hidden = JSON.parse(sb.__RN_AGENT.resolveLadder(JSON.stringify({ role: 'button', name: 'Hidden Action' })));
  assert.equal(hidden.found, false);
  assert.equal(hidden.error, 'Component not found');

  const shown = JSON.parse(
    sb.__RN_AGENT.resolveLadder(JSON.stringify({ role: 'button', name: 'Hidden Action', includeHidden: true })),
  );
  assert.equal(shown.found, true);
  assert.equal(shown.bundle.accessibleName, 'Hidden Action');
});

// ── byText: host-Text whose content __match-es ──────────────────────────
test('resolveLadder: byText matches a host-Text node', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ hostType: 'Text', testID: 'greeting', children: [{ text: 'Welcome back' }] }],
  });
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(sb.__RN_AGENT.resolveLadder(JSON.stringify({ text: 'Welcome back' })));
  assert.equal(res.found, true);
  assert.equal(res.bundle.role, 'text');
  assert.equal(res.bundle.text, 'Welcome back');
});

// ── byPlaceholder: host TextInput placeholder ───────────────────────────
test('resolveLadder: byPlaceholder matches a host TextInput', () => {
  const root = buildFiber({
    name: 'App',
    children: [{ hostType: 'TextInput', props: { placeholder: 'Email address' } }],
  });
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(sb.__RN_AGENT.resolveLadder(JSON.stringify({ placeholder: 'Email address' })));
  assert.equal(res.found, true);
  assert.equal(res.bundle.placeholder, 'Email address');
});

// ── interact() routes a ladder spec and presses the nearest onPress ──────
test('interact: role/name spec routes through resolveLadder and fires onPress', () => {
  let pressed = false;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: { accessibilityRole: 'button', onPress: () => { pressed = true; } },
        children: [{ hostType: 'Text', children: [{ text: 'Go to Dashboard' }] }],
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(sb.__RN_AGENT.interact({ action: 'press', role: 'button', name: 'Go to Dashboard' }));
  assert.equal(res.success, true);
  assert.equal(pressed, true);
});

test('interact: byText spec presses the nearest onPress ancestor (walks .return)', () => {
  let pressed = false;
  const root = buildFiber({
    name: 'App',
    children: [
      {
        name: 'Pressable',
        props: { onPress: () => { pressed = true; } },
        children: [{ hostType: 'Text', children: [{ text: 'Tap me' }] }],
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(sb.__RN_AGENT.interact({ action: 'press', text: 'Tap me' }));
  assert.equal(res.success, true);
  assert.equal(pressed, true);
});

test('interact: ambiguous ladder spec surfaces the resolveLadder error verbatim', () => {
  const mk = () => ({
    name: 'Pressable',
    props: { accessibilityRole: 'button', onPress: () => {} },
    children: [{ hostType: 'Text', children: [{ text: 'Continue' }] }],
  });
  const root = buildFiber({ name: 'App', children: [mk(), mk()] });
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(sb.__RN_AGENT.interact({ action: 'press', role: 'button', name: 'Continue' }));
  assert.equal(res.error, 'Ambiguous component match');
  assert.equal(res.count, 2);
});

// ── source-drift guard (mirror gh-60-bug-5:422-432) ─────────────────────
test('source guard: resolveLadder is defined and attached', () => {
  assert.match(INJECTED_HELPERS, /function resolveLadder\(/);
  assert.match(INJECTED_HELPERS, /resolveLadder: resolveLadder/);
  assert.match(INJECTED_HELPERS, /Ambiguous component match/);
  assert.match(INJECTED_HELPERS, /Component not found/);
});
```

- [ ] **Step 2 — Run the test, verify it fails**

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/task7-resolve-ladder.test.js
```

Expected: build succeeds, run fails. `sb.__RN_AGENT.resolveLadder` is `undefined`, so the first behavioral test throws `TypeError: sb.__RN_AGENT.resolveLadder is not a function`, and the source guard fails with `assert.match` not finding `/function resolveLadder\(/`. TAP summary shows `fail` > 0 (e.g. `# fail 8`).

- [ ] **Step 3 — Write the minimal implementation**

3a. Bump the version. In `injected-helpers.ts` change line 5:

```ts
export const HELPERS_VERSION = 27;
```

3b. Insert `resolveLadder` inside the IIFE, immediately AFTER the `interact()` function closes and BEFORE the `// Public API` block. The anchor is `injected-helpers.ts:1900-1902`:

```js
    if (found.length === 1) return JSON.stringify({ value: found[0], controlled: true });
    return JSON.stringify({ value: null, controlled: false });
  }

  // Public API
```

Insert between the closing `}` of `readInputValue` and `// Public API`:

```js
  // Task 7 — declarative ladder resolver. Composes the pure helpers
  // (__match/__role/__accessibleName/__hidden/__hostKind) into byRole,
  // byText and byPlaceholder predicates. COLLECT ALL matches across every
  // renderer (no early return) so duplicate targets surface as Ambiguous
  // rather than a silent pick — mirrors interact()'s label-tier policy at
  // the ambiguous shape :1189-1196.
  function resolveLadder(specJson) {
    var spec;
    try {
      spec = typeof specJson === 'string' ? JSON.parse(specJson) : (specJson || {});
    } catch (e) {
      return JSON.stringify({ found: false, error: 'Invalid spec JSON' });
    }

    var wantRole = typeof spec.role === 'string' ? spec.role : null;
    var wantName = typeof spec.name === 'string' ? spec.name : null;
    var wantText = typeof spec.text === 'string' ? spec.text : null;
    var wantPlaceholder = typeof spec.placeholder === 'string' ? spec.placeholder : null;
    var includeHidden = spec.includeHidden === true;
    var exact = spec.exact === true;

    function nameMatches(fiber) {
      if (wantName === null) return true;
      var an = __accessibleName(fiber);
      if (an === undefined || an === null) return false;
      return __match(an, { value: wantName, exact: exact });
    }

    // byText: a host Text node whose own text content __match-es. The text
    // content is the inline-joined accessible name of the Text subtree.
    function textContentMatches(fiber) {
      var an = __accessibleName(fiber);
      if (an === undefined || an === null) return false;
      return __match(an, { value: wantText, exact: exact });
    }

    function placeholderOf(fiber) {
      var p = fiber && fiber.memoizedProps;
      return p && typeof p.placeholder === 'string' ? p.placeholder : null;
    }

    function isCandidate(fiber) {
      if (wantRole !== null) {
        if (__role(fiber) !== wantRole) return false;
        return nameMatches(fiber);
      }
      if (wantText !== null) {
        if (__hostKind(fiber) !== 'text') return false;
        return textContentMatches(fiber);
      }
      if (wantPlaceholder !== null) {
        if (__hostKind(fiber) !== 'textinput') return false;
        var ph = placeholderOf(fiber);
        return ph !== null && __match(ph, { value: wantPlaceholder, exact: exact });
      }
      return false;
    }

    var matched = [];
    var visitCount = 0;

    forEachRootFiber(function (rootFiber) {
      (function walk(node) {
        var current = node;
        while (current) {
          visitCount++;
          if (visitCount > 8000) return;
          if (isCandidate(current)) {
            if (includeHidden || !__hidden(current)) matched.push(current);
          }
          if (current.child) walk(current.child);
          current = current.sibling;
        }
      })(rootFiber);
      return null; // collect-all — never short-circuit
    });

    function describe(fiber) {
      var props = fiber.memoizedProps || {};
      var dt = (fiber.type && (typeof fiber.type === 'string'
        ? fiber.type
        : (fiber.type.displayName || fiber.type.name))) || 'Unknown';
      return {
        component: dt,
        testID: props.testID,
        role: __role(fiber),
        accessibleName: __accessibleName(fiber),
      };
    }

    function hintFor() {
      var bits = [];
      if (wantRole !== null) bits.push('role="' + wantRole + '"');
      if (wantName !== null) bits.push('name="' + wantName + '"');
      if (wantText !== null) bits.push('text="' + wantText + '"');
      if (wantPlaceholder !== null) bits.push('placeholder="' + wantPlaceholder + '"');
      return bits.join(' ');
    }

    if (matched.length === 0) {
      return JSON.stringify({
        found: false,
        error: 'Component not found',
        hint: 'No accessible component matched ' + hintFor() +
          (includeHidden ? '' : ' (hidden elements excluded — pass includeHidden:true to include them)') +
          '. Use cdp_component_tree to verify it is mounted, or pass a testID.'
      });
    }

    if (matched.length > 1) {
      var descriptors = [];
      for (var di = 0; di < matched.length && di < 10; di++) descriptors.push(describe(matched[di]));
      return JSON.stringify({
        found: false,
        error: 'Ambiguous component match',
        count: matched.length,
        matches: descriptors,
        hint: 'Add a testID'
      });
    }

    var target = matched[0];
    var tprops = target.memoizedProps || {};
    var bundle = {
      testID: tprops.testID,
      text: __hostKind(target) === 'text' ? __accessibleName(target) : undefined,
      accessibleName: __accessibleName(target),
      role: __role(target),
      placeholder: placeholderOf(target) || undefined,
      disabled: (tprops.disabled === true)
        || (tprops['aria-disabled'] === true)
        || !!(tprops.accessibilityState && tprops.accessibilityState.disabled),
      bounds: null
    };
    return JSON.stringify({ found: true, bundle: bundle });
  }
```

3c. Route ladder specs in `interact()`. The entry guards are at `injected-helpers.ts:1096-1104`:

```js
  function interact(opts) {
    opts = opts || {};
    var action = opts.action;
    var selector = opts.testID || opts.accessibilityLabel;
    var matchField = opts.testID ? 'testID' : 'accessibilityLabel';
    var isLabelMatch = matchField === 'accessibilityLabel';

    if (!action) return JSON.stringify({ error: 'action is required' });
    if (!selector) return JSON.stringify({ error: 'testID or accessibilityLabel is required' });
```

Replace those lines with the version that routes the ladder BEFORE the legacy selector guard fires (so a role/name/text/placeholder spec with no testID/accessibilityLabel is no longer rejected by the `!selector` guard):

```js
  function interact(opts) {
    opts = opts || {};
    var action = opts.action;
    var selector = opts.testID || opts.accessibilityLabel;
    var matchField = opts.testID ? 'testID' : 'accessibilityLabel';
    var isLabelMatch = matchField === 'accessibilityLabel';

    if (!action) return JSON.stringify({ error: 'action is required' });

    // Task 7 — ladder routing. When the caller passes a declarative selector
    // (role/name/text/placeholder) and NO testID/accessibilityLabel, resolve
    // via resolveLadder then press the found fiber or its nearest onPress
    // ancestor (walking .return). testID/accessibilityLabel keep the legacy
    // path below unchanged.
    if (!selector && (opts.role || opts.name || opts.text || opts.placeholder)) {
      var ladderResult = resolveLadder(JSON.stringify({
        role: opts.role, name: opts.name, text: opts.text,
        placeholder: opts.placeholder, exact: opts.exact, includeHidden: opts.includeHidden
      }));
      var parsed = JSON.parse(ladderResult);
      if (!parsed.found) return ladderResult;

      var targetFiber = __resolveLadderFiber(opts);
      if (!targetFiber) return JSON.stringify({ error: 'Component not found' });

      var pressFiber = targetFiber;
      while (pressFiber) {
        var pf = pressFiber.memoizedProps;
        if (pf && typeof pf.onPress === 'function') break;
        pressFiber = pressFiber.return;
      }
      if (!pressFiber) {
        return JSON.stringify({ error: 'Component has no onPress handler', bundle: parsed.bundle });
      }
      var pName = (pressFiber.type && (typeof pressFiber.type === 'string'
        ? pressFiber.type
        : (pressFiber.type.displayName || pressFiber.type.name))) || 'Unknown';
      try {
        pressFiber.memoizedProps.onPress({ nativeEvent: {} });
        return JSON.stringify({ success: true, action: 'press', component: pName, bundle: parsed.bundle });
      } catch (e) {
        return JSON.stringify({ error: 'onPress threw', message: e && e.message, component: pName });
      }
    }

    if (!selector) return JSON.stringify({ error: 'testID or accessibilityLabel is required' });
```

Add the small re-resolve helper `__resolveLadderFiber` directly above `resolveLadder` (it re-walks to return the single matched FIBER, since `resolveLadder` returns a JSON string with no live fiber reference). Insert it immediately before the `function resolveLadder(specJson)` line:

```js
  // Task 7 — fiber-returning twin of resolveLadder. resolveLadder serializes
  // to JSON (no live fiber escapes); interact() needs the fiber itself to
  // press, so it re-resolves here under the SAME predicates and returns the
  // single match (or null when 0/>1 — interact() has already surfaced the
  // JSON error before calling this).
  function __resolveLadderFiber(spec) {
    var wantRole = typeof spec.role === 'string' ? spec.role : null;
    var wantName = typeof spec.name === 'string' ? spec.name : null;
    var wantText = typeof spec.text === 'string' ? spec.text : null;
    var wantPlaceholder = typeof spec.placeholder === 'string' ? spec.placeholder : null;
    var includeHidden = spec.includeHidden === true;
    var exact = spec.exact === true;

    function isCand(fiber) {
      if (wantRole !== null) {
        if (__role(fiber) !== wantRole) return false;
        if (wantName === null) return true;
        var an = __accessibleName(fiber);
        return an != null && __match(an, { value: wantName, exact: exact });
      }
      if (wantText !== null) {
        if (__hostKind(fiber) !== 'text') return false;
        var tn = __accessibleName(fiber);
        return tn != null && __match(tn, { value: wantText, exact: exact });
      }
      if (wantPlaceholder !== null) {
        if (__hostKind(fiber) !== 'textinput') return false;
        var p = fiber.memoizedProps;
        var ph = p && typeof p.placeholder === 'string' ? p.placeholder : null;
        return ph !== null && __match(ph, { value: wantPlaceholder, exact: exact });
      }
      return false;
    }

    var out = [];
    var n = 0;
    forEachRootFiber(function (rootFiber) {
      (function walk(node) {
        var current = node;
        while (current) {
          n++;
          if (n > 8000) return;
          if (isCand(current) && (includeHidden || !__hidden(current))) out.push(current);
          if (current.child) walk(current.child);
          current = current.sibling;
        }
      })(rootFiber);
      return null;
    });
    return out.length === 1 ? out[0] : null;
  }
```

3d. Attach `resolveLadder` to the public surface. The anchor is the `interact: interact,` line at `injected-helpers.ts:1917`:

```js
    interact: interact,
```

Change to:

```js
    interact: interact,
    resolveLadder: resolveLadder,
```

- [ ] **Step 4 — Run the test, verify it passes**

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/task7-resolve-ladder.test.js
```

Expected: TAP summary with all assertions green and `# fail 0` (`# pass 9`). Then run the regression neighbour to confirm the `interact()` legacy paths and label tiers are untouched:

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && node --test test/unit/gh-60-bug-5-label-matching.test.js
```

Expected: `# fail 0` (existing behavior preserved; the new `!selector` ladder branch only fires when role/name/text/placeholder is present).

- [ ] **Step 5 — Commit**

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && \
git add src/injected-helpers.ts test/unit/task7-resolve-ladder.test.js && \
git commit -m "$(cat <<'EOF'
feat(resolver): resolveLadder + interact() ladder routing (Task 7)

Add __RN_AGENT.resolveLadder(specJson) composing __match/__role/
__accessibleName/__hidden/__hostKind into byRole/byText/byPlaceholder
predicates. Collect-all across renderers: 0 → Component not found, >1 →
Ambiguous component match (count + descriptors), 1 → bundle. Hidden
excluded unless includeHidden. interact() routes role/name/text/
placeholder specs (no testID/accessibilityLabel) through the resolver and
presses the found fiber or its nearest onPress ancestor. Bump
HELPERS_VERSION 26 → 27.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Anchor capture into the bundle

Extend `resolveLadder` (Task 7) so the returned `bundle` includes an `anchors` array: a bounded `fiber.return` ancestor walk (cap depth ~8, mirroring the `setFieldValue` ancestor walk at `injected-helpers.ts:1438-1451`) recording nearest-first entries `{testID?, text?, relation:"childOf", depth, provenance}`. `provenance` is `"authored-testID"` when the ancestor carries a `testID`/`nativeID`, else `"text"` (derived from `__accessibleName` or host text). Only ancestors that have a `testID` **or** a non-empty accessible name are recorded. This gives downstream selectors a stable, human-readable trail back up to the nearest authored anchor when the matched element itself has no `testID`.

**Files**

- Modify: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/src/injected-helpers.ts`
  - Add `__collectAnchors(fiber)` inside the IIFE (ES5, attached to `__RN_AGENT`).
  - Populate `bundle.anchors` inside `resolveLadder`'s bundle-build step.
  - Increment `HELPERS_VERSION` 26 → 27 (`injected-helpers.ts:5`).
- Test: `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/gh-anchor-capture.test.js` (new)

**Interfaces**

Consumes (from earlier tasks — exact signatures):
- `__RN_AGENT.__accessibleName(fiber)` → `string | undefined` (Task 5). Used to derive an ancestor's `text` provenance.
- `__RN_AGENT.__hostKind(fiber)` → `'text' | 'textinput' | 'image' | 'switch' | 'scrollview' | 'modal' | null` (Task 2). Used to read raw host text on `Text`/`RCTText` ancestors.
- `__RN_AGENT.resolveLadder(specJson)` → JSON string `{found, bundle?, error?, truncated?, count?, matches?, hint?}` (Task 7). The matched fiber is in scope at the bundle-build step; this task adds `bundle.anchors`.
- The `setFieldValue` ancestor-walk shape at `injected-helpers.ts:1438-1451` (`var ancestor = found.return; … ancestor = ancestor.return; ancestorDepth++;`) is the structural mirror for the cap/loop.

Produces (later tasks rely on these — exact signatures):
- `__RN_AGENT.__collectAnchors(fiber)` → `Array<{testID?: string, text?: string, relation: 'childOf', depth: number, provenance: 'authored-testID' | 'text'}>`. Nearest-first (closest ancestor at index 0). Pure; returns the raw array (NOT a JSON string).
- `resolveLadder(...)`'s `bundle.anchors` is now always present (possibly `[]`) when `found` is true. a later phase (interact routing / serializer) reads `bundle.anchors[0].testID` as the stable re-selection anchor.

- [ ] **Step 1: Write the failing test**

Create `/Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge/test/unit/gh-anchor-capture.test.js`:

```js
// Task 8 — Anchor capture into resolveLadder's bundle.
// A no-testID host Text nested under a Pressable testID="task-row-3" under a
// View must yield bundle.anchors nearest-first with the Pressable at index 0,
// provenance "authored-testID". Ancestors with neither testID nor accessible
// name are skipped. provenance falls back to "text" (via __accessibleName or
// host text) when the ancestor has no testID/nativeID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createSandbox, buildFiber } from './helpers/inject-harness.js';

// Buy milk (host Text, no testID) < Pressable testID=task-row-3 < View
function buildTaskRow() {
  return buildFiber({
    name: 'View',
    children: [
      {
        name: 'Pressable',
        props: { testID: 'task-row-3' },
        children: [
          { hostType: 'Text', children: [{ text: 'Buy milk' }] },
        ],
      },
    ],
  });
}

// Returns the deepest fiber (the matched leaf) by walking child-first.
function deepestChild(fiber) {
  let cur = fiber;
  while (cur && cur.child) cur = cur.child;
  return cur;
}

test('__collectAnchors: nearest authored testID ancestor at index 0', () => {
  const root = buildTaskRow();
  const sb = createSandbox({ fiberRoot: root });
  const leaf = deepestChild(root); // the raw "Buy milk" text fiber
  const anchors = sb.__RN_AGENT.__collectAnchors(leaf);

  assert.ok(Array.isArray(anchors));
  assert.ok(anchors.length >= 1);
  // Nearest authored anchor (the Pressable) is first.
  assert.equal(anchors[0].testID, 'task-row-3');
  assert.equal(anchors[0].provenance, 'authored-testID');
  assert.equal(anchors[0].relation, 'childOf');
  assert.equal(typeof anchors[0].depth, 'number');
  assert.ok(anchors[0].depth >= 1);
});

test('resolveLadder: bundle.anchors[0] is the authored-testID Pressable', () => {
  const root = buildTaskRow();
  const sb = createSandbox({ fiberRoot: root });
  const res = JSON.parse(
    sb.__RN_AGENT.resolveLadder(JSON.stringify({ text: 'Buy milk' }))
  );
  assert.equal(res.found, true);
  assert.ok(Array.isArray(res.bundle.anchors));
  assert.equal(res.bundle.anchors[0].testID, 'task-row-3');
  assert.equal(res.bundle.anchors[0].provenance, 'authored-testID');
  assert.equal(res.bundle.anchors[0].relation, 'childOf');
});

test('__collectAnchors: text-provenance ancestor when no testID/nativeID', () => {
  // Inner host Text "Done" < Pressable (accessibilityLabel, NO testID) < View
  const root = buildFiber({
    name: 'View',
    children: [
      {
        name: 'Pressable',
        props: { accessibilityLabel: 'Complete task' },
        children: [{ hostType: 'Text', children: [{ text: 'Done' }] }],
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const leaf = deepestChild(root);
  const anchors = sb.__RN_AGENT.__collectAnchors(leaf);
  const labelled = anchors.find((a) => a.text === 'Complete task');
  assert.ok(labelled, 'expected a text-provenance anchor for the labelled Pressable');
  assert.equal(labelled.provenance, 'text');
  assert.equal(labelled.testID, undefined);
});

test('__collectAnchors: skips ancestors with neither testID nor accessible name', () => {
  // Plain wrapper Views (no testID, no label, no host text) must not appear.
  const root = buildFiber({
    name: 'View',
    children: [
      {
        name: 'View', // bare wrapper — must be skipped
        children: [
          {
            name: 'Pressable',
            props: { testID: 'row' },
            children: [{ hostType: 'Text', children: [{ text: 'Hi' }] }],
          },
        ],
      },
    ],
  });
  const sb = createSandbox({ fiberRoot: root });
  const leaf = deepestChild(root);
  const anchors = sb.__RN_AGENT.__collectAnchors(leaf);
  // Only the Pressable qualifies; bare Views are absent.
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].testID, 'row');
});

// ── source-drift guard ────────────────────────────────────────────────────
test('source guard: __collectAnchors + anchors wired into bundle', () => {
  assert.match(INJECTED_HELPERS, /function __collectAnchors\(/);
  assert.match(INJECTED_HELPERS, /relation: 'childOf'/);
  assert.match(INJECTED_HELPERS, /provenance: 'authored-testID'/);
  assert.match(INJECTED_HELPERS, /__collectAnchors: __collectAnchors/);
  assert.match(INJECTED_HELPERS, /anchors: __collectAnchors\(/);
});
```

- [ ] **Step 2: Run the test, verify it fails**

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/gh-anchor-capture.test.js
```

Expected failure (before implementation): `__RN_AGENT.__collectAnchors` is `undefined`, so the first test throws `TypeError: sb.__RN_AGENT.__collectAnchors is not a function`, the `resolveLadder` test fails on `res.bundle.anchors` being `undefined` (`Array.isArray(undefined)` is false), and the source guard fails with `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /function __collectAnchors\(/`. TAP summary reports `# fail 5` (or `# fail` > 0).

- [ ] **Step 3: Write the minimal implementation**

3a. Add the `__collectAnchors` helper. Insert it immediately **after** the `readInputValue` closing brace and **before** the `// Public API` comment at `injected-helpers.ts:1900-1902`. Anchor lines for the insertion point:

```js
    if (found.length === 1) return JSON.stringify({ value: found[0], controlled: true });
    return JSON.stringify({ value: null, controlled: false });
  }
```

Insert directly below that closing brace:

```js

  // Task 8 — bounded fiber.return ancestor walk producing the bundle's
  // anchor trail. Mirrors the setFieldValue ancestor walk (cap + .return
  // chain) at the ANCESTOR_DEPTH_CAP loop, but records nearest-first
  // {testID, text, relation, depth, provenance} for any ancestor that
  // carries a testID OR a non-empty accessible name. Provenance is
  // "authored-testID" when the ancestor has an explicit testID/nativeID,
  // else "text" (accessible name or raw host text). Bare wrapper Views
  // (no anchor signal) are skipped so the trail stays meaningful.
  function __rawHostText(fiber) {
    // A host Text fiber's child text node has memoizedProps as a raw string.
    if (__hostKind(fiber) !== 'text') return undefined;
    var c = fiber.child;
    var visits = 0;
    while (c && visits < 8) {
      visits++;
      if (typeof c.memoizedProps === 'string') {
        var t = c.memoizedProps.replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '');
        if (t) return t;
      }
      c = c.child;
    }
    return undefined;
  }

  function __collectAnchors(fiber) {
    var ANCHOR_DEPTH_CAP = 8;
    var anchors = [];
    if (!fiber) return anchors;
    var ancestor = fiber.return;
    var depth = 1;
    while (ancestor && depth <= ANCHOR_DEPTH_CAP) {
      var aProps = ancestor.memoizedProps;
      var testID = aProps && typeof aProps === 'object'
        ? (aProps.testID || aProps.nativeID)
        : undefined;
      var name;
      try { name = __accessibleName(ancestor); } catch (_) { name = undefined; }
      if (!name) name = __rawHostText(ancestor);
      if (testID || (name && name.length > 0)) {
        var entry = { relation: 'childOf', depth: depth };
        if (testID) {
          entry.testID = String(testID);
          entry.provenance = 'authored-testID';
        } else {
          entry.text = String(name);
          entry.provenance = 'text';
        }
        anchors.push(entry);
      }
      ancestor = ancestor.return;
      depth++;
    }
    return anchors;
  }
```

3b. Wire `anchors` into `resolveLadder`'s bundle build. In the Task 7 bundle-construction object (the `bundle = { testID: ..., text: ..., accessibleName: ..., role: ..., placeholder: ..., disabled: ..., bounds: ... }` literal built from the matched fiber `found`), add the `anchors` field as the final key:

```js
        anchors: __collectAnchors(found)
```

so the literal ends `…, bounds: <boundsExpr>, anchors: __collectAnchors(found) }`. (`found` is the matched fiber variable already in scope in Task 7's bundle step.)

3c. Expose both on the `__RN_AGENT` public surface. In the `globalThis.__RN_AGENT = { … }` object at `injected-helpers.ts:1903`, add alongside the other Task helpers (after `interact: interact,` at line 1917):

```js
    __collectAnchors: __collectAnchors,
```

3d. Increment `HELPERS_VERSION`. At `injected-helpers.ts:5`:

```js
export const HELPERS_VERSION = 27;
```

- [ ] **Step 4: Run the test, verify it passes**

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && npm run build && node --test test/unit/gh-anchor-capture.test.js
```

Expected: TAP summary with `# pass 5` and `# fail 0`.

- [ ] **Step 5: Commit**

```
cd /Users/anton_personal/.warp/worktrees/claude-react-native-dev-plugin/cinnabar-switchback/scripts/cdp-bridge && \
git add src/injected-helpers.ts test/unit/gh-anchor-capture.test.js && \
git commit -m "feat(cdp-bridge): capture ancestor anchors into resolveLadder bundle

Add __collectAnchors — a bounded (depth 8) fiber.return ancestor walk
mirroring the setFieldValue ancestor walk — recording nearest-first
{testID, text, relation: childOf, depth, provenance} entries for any
ancestor with a testID or non-empty accessible name. provenance is
authored-testID for testID/nativeID ancestors, else text. Populate
bundle.anchors in resolveLadder. Bump HELPERS_VERSION 26 -> 27.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---
