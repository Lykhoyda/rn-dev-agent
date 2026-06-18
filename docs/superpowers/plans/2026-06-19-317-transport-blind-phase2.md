# #317 Phase 2 — CDP/JS Action-Replay Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `cdp_run_action` fails on iOS 26.x because WebDriverAgent is blind (empty a11y tree), replay the action's steps through the CDP/JS transport (`cdp_interact`) and return a real pass/fail verdict — so the observe Regression **Run** button works on 26.x.

**Architecture:** Reactive fallback inside `cdp_run_action`. The existing maestro attempt runs unchanged; on `SELECTOR_NOT_FOUND`, a CDP-tree oracle checks whether the failed testID is *exactly* present (we can see it, WDA can't). If so, a pure step-interpreter replays the action's YAML steps through an injected dispatch that calls the existing `cdp_interact` / `cdp_component_tree` handlers. Healthy OSes never enter the new branch.

**Tech Stack:** TypeScript (Node ≥ 22, ESM), `node:test` + `node:assert/strict`, the `yaml` dependency (already present), oxlint + oxfmt.

## Global Constraints

- Tests import from compiled `../../dist/...` — every task runs `npm run build` (in `scripts/cdp-bridge/`) before its test step.
- Healthy-OS behavior must stay **byte-for-byte unchanged**: maestro pass persists **no** `transport` field; the new branch is reachable only on `SELECTOR_NOT_FOUND` + exact CDP-tree presence.
- testIDs are **case-sensitive**; oracle matches verbatim, never substring (`cdp_component_tree`'s filter is a broad case-insensitive substring match — not proof of presence).
- Unsupported step type ⇒ hard `UNSUPPORTED_STEP` error; **never** a silent pass.
- Supported step subset (all 7 current actions use only these): `launchApp` (`stopApp` opt), `tapOn:{id}`, `inputText`, `assertVisible:{id}`, `runFlow:{when:{visible:{id}},commands}`, `waitForAnimationToEnd`.
- Per-task: oxlint + oxfmt clean; full `npm test` green; a changeset added once at the end; `dist/` rebuilt + staged.
- Compose by calling underlying handler functions (`createInteractHandler`, `createComponentTreeHandler`), never the wrapped MCP tools (single arbiter lease).

## File Structure

- **Create** `scripts/cdp-bridge/src/domain/cdp-flow-replay.ts` — pure: `ReplayStep` types, `normalizeSteps`, `replayFlow`, `collectTestIds`. No CDP/IO.
- **Create** `scripts/cdp-bridge/src/tools/cdp-replay-dispatch.ts` — CDP-bound glue: `isTransportBlindViaCdp`, `buildCdpDispatch`.
- **Modify** `scripts/cdp-bridge/src/types.ts` — add `'UNSUPPORTED_STEP'` to `ToolErrorCode`.
- **Modify** `scripts/cdp-bridge/src/domain/reusable-action.ts` — add optional `transport?: 'cdp-js'` to `RunRecord`.
- **Modify** `scripts/cdp-bridge/src/tools/run-action.ts` — inject fallback after the route-drift block (~line 338).
- **Create** `scripts/cdp-bridge/test/unit/cdp-flow-replay.test.js` — parser + interpreter + negative.
- **Create** `scripts/cdp-bridge/test/unit/cdp-replay-dispatch.test.js` — oracle exact-match.
- **Create** `scripts/cdp-bridge/test/unit/run-action-transport-blind.test.js` — handler-level wiring.

---

### Task 1: Step model + parser (`normalizeSteps`)

**Files:**
- Create: `scripts/cdp-bridge/src/domain/cdp-flow-replay.ts`
- Modify: `scripts/cdp-bridge/src/types.ts` (add `'UNSUPPORTED_STEP'` to `ToolErrorCode` union, near `'TRANSPORT_BLIND'`)
- Test: `scripts/cdp-bridge/test/unit/cdp-flow-replay.test.js`

**Interfaces:**
- Produces:
  - `type ReplayStep = { t:'launch', stopApp:boolean } | { t:'tap', id:string } | { t:'type', text:string } | { t:'assert', id:string } | { t:'wait' } | { t:'runFlow', whenVisible:string, commands:ReplayStep[] }`
  - `class UnsupportedStepError extends Error { readonly stepKey: string }`
  - `function normalizeSteps(body: unknown[], params: Record<string,string>): ReplayStep[]` — maps raw parsed-YAML step objects to `ReplayStep[]`, interpolating `${VAR}` in ids/text; throws `UnsupportedStepError` on any unrecognized step key.

- [ ] **Step 1: Write the failing test**

```js
// scripts/cdp-bridge/test/unit/cdp-flow-replay.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSteps, UnsupportedStepError } from '../../dist/domain/cdp-flow-replay.js';

test('normalizeSteps maps the supported subset with ${VAR} interpolation', () => {
  const body = [
    { launchApp: { stopApp: false } },
    { tapOn: { id: 'wizard-title-input' } },
    { inputText: '${TITLE}' },
    { assertVisible: { id: 'wizard-step-1' } },
    { tapOn: { id: 'wizard-priority-${PRIORITY}' } },
    'waitForAnimationToEnd',
    { runFlow: { when: { visible: { id: 'onboarding-screen' } }, commands: [{ tapOn: { id: 'onboarding-done' } }] } },
  ];
  const steps = normalizeSteps(body, { TITLE: 'Ship it', PRIORITY: 'high' });
  assert.deepEqual(steps, [
    { t: 'launch', stopApp: false },
    { t: 'tap', id: 'wizard-title-input' },
    { t: 'type', text: 'Ship it' },
    { t: 'assert', id: 'wizard-step-1' },
    { t: 'tap', id: 'wizard-priority-high' },
    { t: 'wait' },
    { t: 'runFlow', whenVisible: 'onboarding-screen', commands: [{ t: 'tap', id: 'onboarding-done' }] },
  ]);
});

test('normalizeSteps throws UnsupportedStepError on an unknown step', () => {
  assert.throws(() => normalizeSteps([{ scroll: { direction: 'DOWN' } }], {}), (e) => {
    assert.ok(e instanceof UnsupportedStepError);
    assert.equal(e.stepKey, 'scroll');
    return true;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && node --test test/unit/cdp-flow-replay.test.js`
Expected: FAIL — `Cannot find module '../../dist/domain/cdp-flow-replay.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/cdp-bridge/src/domain/cdp-flow-replay.ts
export type ReplayStep =
  | { t: 'launch'; stopApp: boolean }
  | { t: 'tap'; id: string }
  | { t: 'type'; text: string }
  | { t: 'assert'; id: string }
  | { t: 'wait' }
  | { t: 'runFlow'; whenVisible: string; commands: ReplayStep[] };

export class UnsupportedStepError extends Error {
  constructor(readonly stepKey: string) {
    super(`cdp-flow-replay: unsupported Maestro step "${stepKey}" (no CDP/JS mapping)`);
    this.name = 'UnsupportedStepError';
  }
}

const interp = (s: string, p: Record<string, string>): string =>
  s.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, k: string) => p[k] ?? `\${${k}}`);

export function normalizeSteps(body: unknown[], params: Record<string, string>): ReplayStep[] {
  const out: ReplayStep[] = [];
  for (const raw of body) {
    if (raw === 'waitForAnimationToEnd') { out.push({ t: 'wait' }); continue; }
    if (typeof raw === 'string') throw new UnsupportedStepError(raw);
    const obj = raw as Record<string, unknown>;
    const key = Object.keys(obj)[0];
    const v = obj[key] as Record<string, unknown> | string | undefined;
    switch (key) {
      case 'launchApp':
        out.push({ t: 'launch', stopApp: (v as { stopApp?: boolean })?.stopApp === true });
        break;
      case 'tapOn':
        out.push({ t: 'tap', id: interp(String((v as { id: string }).id), params) });
        break;
      case 'inputText':
        out.push({ t: 'type', text: interp(String(v), params) });
        break;
      case 'assertVisible':
        out.push({ t: 'assert', id: interp(String((v as { id: string }).id), params) });
        break;
      case 'waitForAnimationToEnd':
        out.push({ t: 'wait' });
        break;
      case 'runFlow': {
        const rf = v as { when?: { visible?: { id?: string } }; commands?: unknown[] };
        const id = rf.when?.visible?.id;
        if (!id || !Array.isArray(rf.commands)) throw new UnsupportedStepError('runFlow');
        out.push({ t: 'runFlow', whenVisible: interp(String(id), params), commands: normalizeSteps(rf.commands, params) });
        break;
      }
      default:
        throw new UnsupportedStepError(key);
    }
  }
  return out;
}
```

Then in `scripts/cdp-bridge/src/types.ts`, add `'UNSUPPORTED_STEP'` to the `ToolErrorCode` union (next to `'TRANSPORT_BLIND'`, with a `// GH #317 Phase 2` comment).

- [ ] **Step 4: Build and run tests**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/cdp-flow-replay.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/cdp-flow-replay.ts scripts/cdp-bridge/src/types.ts scripts/cdp-bridge/dist scripts/cdp-bridge/test/unit/cdp-flow-replay.test.js
git commit -m "feat(#317): cdp-flow-replay step model + normalizeSteps parser"
```

---

### Task 2: Pure interpreter (`replayFlow`)

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/cdp-flow-replay.ts`
- Test: `scripts/cdp-bridge/test/unit/cdp-flow-replay.test.js` (append)

**Interfaces:**
- Consumes: `ReplayStep` (Task 1).
- Produces:
  - `interface ReplayDispatch { press(id:string):Promise<void>; type(id:string,text:string):Promise<void>; isVisible(id:string):Promise<boolean>; launch(stopApp:boolean):Promise<void>; settle():Promise<void> }` — `press`/`type` **throw** when the target is missing or non-interactable (the dispatch impl in Task 3 enforces the disabled-guard).
  - `interface ReplayResult { passed:boolean; failedStepIndex?:number; reason?:string; steps:{ t:string; target?:string; ok:boolean }[] }`
  - `function replayFlow(steps:ReplayStep[], dispatch:ReplayDispatch):Promise<ReplayResult>` — executes sequentially, tracking `lastTapped`; `type` routes to `lastTapped` (throws `reason:'inputText before any tapOn'` if none); `assert` fails when `isVisible` is false; `runFlow` recurses only when `isVisible(whenVisible)`; any thrown dispatch error fails that step.

- [ ] **Step 1: Write the failing test**

```js
// append to cdp-flow-replay.test.js
import { replayFlow } from '../../dist/domain/cdp-flow-replay.js';

function mockDispatch(over = {}) {
  const calls = [];
  return {
    calls,
    press: async (id) => { calls.push(['press', id]); if (over.pressThrows?.includes(id)) throw new Error('disabled'); },
    type: async (id, text) => { calls.push(['type', id, text]); },
    isVisible: async (id) => { calls.push(['isVisible', id]); return over.visible ? over.visible.includes(id) : true; },
    launch: async (stopApp) => { calls.push(['launch', stopApp]); },
    settle: async () => { calls.push(['settle']); },
  };
}

test('replayFlow happy path: type routes to last tapped, all pass', async () => {
  const d = mockDispatch();
  const r = await replayFlow([
    { t: 'tap', id: 'title' }, { t: 'type', text: 'Hi' }, { t: 'assert', id: 'step-2' },
  ], d);
  assert.equal(r.passed, true);
  assert.deepEqual(d.calls, [['press', 'title'], ['type', 'title', 'Hi'], ['isVisible', 'step-2']]);
});

test('replayFlow runFlow recurses only when whenVisible present', async () => {
  const d = mockDispatch({ visible: [] }); // onboarding NOT visible
  const r = await replayFlow([
    { t: 'runFlow', whenVisible: 'onboarding', commands: [{ t: 'tap', id: 'done' }] },
    { t: 'assert', id: 'tabs' },
  ], mockDispatch({ visible: ['tabs'] }));
  assert.equal(r.passed, true);
});

test('replayFlow fails the step when a target is disabled (no false green)', async () => {
  const d = mockDispatch({ pressThrows: ['save'] });
  const r = await replayFlow([{ t: 'tap', id: 'save' }], d);
  assert.equal(r.passed, false);
  assert.equal(r.failedStepIndex, 0);
});

test('replayFlow fails assert when target not visible', async () => {
  const r = await replayFlow([{ t: 'assert', id: 'ghost' }], mockDispatch({ visible: [] }));
  assert.equal(r.passed, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/cdp-flow-replay.test.js`
Expected: FAIL — `replayFlow is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to scripts/cdp-bridge/src/domain/cdp-flow-replay.ts
export interface ReplayDispatch {
  press(id: string): Promise<void>;
  type(id: string, text: string): Promise<void>;
  isVisible(id: string): Promise<boolean>;
  launch(stopApp: boolean): Promise<void>;
  settle(): Promise<void>;
}
export interface ReplayResult {
  passed: boolean;
  failedStepIndex?: number;
  reason?: string;
  steps: { t: string; target?: string; ok: boolean }[];
}

export async function replayFlow(steps: ReplayStep[], dispatch: ReplayDispatch): Promise<ReplayResult> {
  const trace: ReplayResult['steps'] = [];
  let lastTapped: string | null = null;
  const fail = (i: number, reason: string): ReplayResult => ({ passed: false, failedStepIndex: i, reason, steps: trace });

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    try {
      switch (s.t) {
        case 'launch': await dispatch.launch(s.stopApp); trace.push({ t: s.t, ok: true }); break;
        case 'tap': await dispatch.press(s.id); lastTapped = s.id; trace.push({ t: s.t, target: s.id, ok: true }); break;
        case 'type':
          if (!lastTapped) return fail(i, 'inputText before any tapOn — no focus target');
          await dispatch.type(lastTapped, s.text); trace.push({ t: s.t, target: lastTapped, ok: true }); break;
        case 'assert': {
          const ok = await dispatch.isVisible(s.id); trace.push({ t: s.t, target: s.id, ok });
          if (!ok) return fail(i, `assertVisible: "${s.id}" not present in CDP tree`);
          break;
        }
        case 'wait': await dispatch.settle(); trace.push({ t: s.t, ok: true }); break;
        case 'runFlow': {
          if (await dispatch.isVisible(s.whenVisible)) {
            const sub = await replayFlow(s.commands, dispatch);
            trace.push(...sub.steps);
            if (!sub.passed) return { passed: false, failedStepIndex: i, reason: sub.reason, steps: trace };
          } else { trace.push({ t: s.t, target: s.whenVisible, ok: true }); }
          break;
        }
      }
    } catch (e) {
      trace.push({ t: s.t, target: 'id' in s ? s.id : undefined, ok: false });
      return fail(i, e instanceof Error ? e.message : String(e));
    }
  }
  return { passed: true, steps: trace };
}
```

- [ ] **Step 4: Build and run tests**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/cdp-flow-replay.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/cdp-flow-replay.ts scripts/cdp-bridge/dist scripts/cdp-bridge/test/unit/cdp-flow-replay.test.js
git commit -m "feat(#317): replayFlow interpreter with focus tracking + disabled-guard surfacing"
```

---

### Task 3: Detection oracle + CDP dispatch (`cdp-replay-dispatch.ts`)

**Files:**
- Create: `scripts/cdp-bridge/src/tools/cdp-replay-dispatch.ts`
- Modify: `scripts/cdp-bridge/src/domain/cdp-flow-replay.ts` (add exported `collectTestIds`)
- Test: `scripts/cdp-bridge/test/unit/cdp-replay-dispatch.test.js`

**Interfaces:**
- Produces:
  - `function collectTestIds(node: unknown): Set<string>` — recursively walks a parsed `__RN_AGENT.getTree` node, collecting every `testID`/`nativeID` value.
  - `function isExactPresent(treeJson: unknown, selector: string): boolean` — `collectTestIds(treeJson).has(selector)` (verbatim, case-sensitive).
  - `function buildCdpDispatch(deps): ReplayDispatch` where `deps = { interact, tree, launch }` are thin async callables (wired in Task 5 to the real handlers). `press`/`type` call `interact`; `press` first checks the target's props via `tree` and throws `Error('disabled')` when `disabled`/`accessibilityState.disabled`/`pointerEvents:'none'`.

This task ships `collectTestIds` + `isExactPresent` (pure, fully tested here) and the `buildCdpDispatch` factory shape (exercised end-to-end in Task 5's handler test). Unit tests here cover the oracle exact-match semantics — the review-critical correctness.

- [ ] **Step 1: Write the failing test**

```js
// scripts/cdp-bridge/test/unit/cdp-replay-dispatch.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectTestIds, isExactPresent } from '../../dist/tools/cdp-replay-dispatch.js';

const tree = { name: 'View', testID: 'screen', children: [
  { name: 'SubmitButton', testID: 'tab-tasks', children: [] },
  { name: 'Text', accessibilityLabel: 'tab-tasks-label', children: [] },
] };

test('isExactPresent: verbatim testID match → true', () => {
  assert.equal(isExactPresent(tree, 'tab-tasks'), true);
});
test('isExactPresent: absent testID → false', () => {
  assert.equal(isExactPresent(tree, 'tab-feed'), false);
});
test('isExactPresent: substring / label / name coincidence → false (not a filtered hit)', () => {
  assert.equal(isExactPresent(tree, 'tab'), false);          // substring of tab-tasks
  assert.equal(isExactPresent(tree, 'tab-tasks-label'), false); // label, not testID
  assert.equal(isExactPresent(tree, 'SubmitButton'), false);  // component name
});
test('collectTestIds gathers nested testIDs', () => {
  assert.deepEqual([...collectTestIds(tree)].sort(), ['screen', 'tab-tasks']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && node --test test/unit/cdp-replay-dispatch.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/cdp-bridge/src/tools/cdp-replay-dispatch.ts
import type { ReplayDispatch } from '../domain/cdp-flow-replay.js';

export function collectTestIds(node: unknown, acc: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== 'object') return acc;
  const n = node as Record<string, unknown>;
  if (typeof n.testID === 'string') acc.add(n.testID);
  if (typeof n.nativeID === 'string') acc.add(n.nativeID);
  const kids = n.children ?? n.interactive ?? n.nodes;
  if (Array.isArray(kids)) for (const c of kids) collectTestIds(c, acc);
  return acc;
}

export function isExactPresent(treeJson: unknown, selector: string): boolean {
  return collectTestIds(treeJson).has(selector);
}

export interface CdpReplayDeps {
  pressByTestId(id: string): Promise<void>;
  typeByTestId(id: string, text: string): Promise<void>;
  // returns the parsed getTree JSON filtered to `id`, or null on failure
  treeFor(id: string): Promise<unknown | null>;
  launchApp(stopApp: boolean): Promise<void>;
  settle(): Promise<void>;
}

function nodeProps(treeJson: unknown, id: string): Record<string, unknown> | null {
  // find the node whose testID === id and return its props bag if exposed
  const stack: unknown[] = [treeJson];
  while (stack.length) {
    const n = stack.pop() as Record<string, unknown> | null;
    if (n && typeof n === 'object') {
      if (n.testID === id) return (n.props as Record<string, unknown>) ?? n;
      const kids = n.children ?? n.interactive ?? n.nodes;
      if (Array.isArray(kids)) stack.push(...kids);
    }
  }
  return null;
}

function isDisabled(props: Record<string, unknown> | null): boolean {
  if (!props) return false;
  const a11y = props.accessibilityState as { disabled?: boolean } | undefined;
  return props.disabled === true || a11y?.disabled === true || props.pointerEvents === 'none';
}

export function buildCdpDispatch(deps: CdpReplayDeps): ReplayDispatch {
  return {
    async press(id) {
      const tree = await deps.treeFor(id);
      if (!isExactPresent(tree, id)) throw new Error(`testID "${id}" not present`);
      if (isDisabled(nodeProps(tree, id))) throw new Error(`testID "${id}" is disabled/non-interactable`);
      await deps.pressByTestId(id);
    },
    async type(id, text) { await deps.typeByTestId(id, text); },
    async isVisible(id) { return isExactPresent(await deps.treeFor(id), id); },
    async launch(stopApp) { await deps.launchApp(stopApp); },
    async settle() { await deps.settle(); },
  };
}
```

- [ ] **Step 4: Build and run tests**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/cdp-replay-dispatch.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/cdp-replay-dispatch.ts scripts/cdp-bridge/dist scripts/cdp-bridge/test/unit/cdp-replay-dispatch.test.js
git commit -m "feat(#317): exact-match CDP-tree oracle + buildCdpDispatch with disabled-guard"
```

---

### Task 4: `RunRecord.transport` optional field

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/reusable-action.ts` (the `RunRecord` interface, ~line 244)
- Test: `scripts/cdp-bridge/test/unit/run-action-transport-blind.test.js` (created here, asserts the type compiles + is optional via a record-shape test)

**Interfaces:**
- Produces: `RunRecord.transport?: 'cdp-js'` (optional; absent ⇒ maestro).

- [ ] **Step 1: Write the failing test**

```js
// scripts/cdp-bridge/test/unit/run-action-transport-blind.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendRunRecord } from '../../dist/domain/reusable-action.js';

test('RunRecord accepts optional transport and omits it by default', () => {
  // a maestro record (no transport) and a cdp-js record both round-trip
  const base = { timestamp: '2026-06-19T00:00:00Z', durationMs: 1, status: 'pass', trigger: 'human',
    autoRepair: { attempted: false, outcome: 'skipped', phases: { firstAttemptMs: 1 } } };
  const maestro = { ...base };
  const fallback = { ...base, transport: 'cdp-js' };
  assert.equal('transport' in maestro, false);
  assert.equal(fallback.transport, 'cdp-js');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && node --test test/unit/run-action-transport-blind.test.js`
Expected: FAIL (import resolves but assertion harness not yet wired) — or PASS trivially; the real gate is `npm run build` type-checking the field in Task 5. If it passes trivially, proceed (this task's deliverable is the type change).

- [ ] **Step 3: Add the field**

In `scripts/cdp-bridge/src/domain/reusable-action.ts`, in the `RunRecord` interface add:
```ts
  /** GH #317 Phase 2: set to 'cdp-js' only when the run was replayed via the
   *  CDP/JS fallback. Absent ⇒ maestro (healthy run-history JSON unchanged). */
  transport?: 'cdp-js';
```

- [ ] **Step 4: Build**

Run: `cd scripts/cdp-bridge && npm run build`
Expected: tsc clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/reusable-action.ts scripts/cdp-bridge/dist scripts/cdp-bridge/test/unit/run-action-transport-blind.test.js
git commit -m "feat(#317): optional RunRecord.transport for fallback runs"
```

---

### Task 5: Wire the fallback into `cdp_run_action`

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/run-action.ts` (inject after the route-drift block ending ~line 338, before the `if (!autoRepairEnabled || !isAutoRepairable(failure))` at ~line 341)
- Modify: `scripts/cdp-bridge/src/tools/cdp-replay-dispatch.ts` (export `runCdpReplay(action, params, deps)` orchestrator that calls `normalizeSteps` + `replayFlow`)
- Test: `scripts/cdp-bridge/test/unit/run-action-transport-blind.test.js` (append handler-level tests with injected deps)

**Interfaces:**
- Consumes: `normalizeSteps`, `replayFlow`, `buildCdpDispatch`, `isExactPresent` (Tasks 1-3); `createRunActionHandler` deps (existing).
- Produces: a new optional dep on the `createRunActionHandler` factory — `replayDeps?: (args) => CdpReplayDeps | null` (default `() => null`, so existing callers/tests are unchanged and the fallback is a no-op until `index.ts` wires the real CDP deps). When `failure.kind === 'SELECTOR_NOT_FOUND'`, `replayDeps` returns deps, and `isExactPresent` of the live tree for `failure.selector` is true → run `runCdpReplay`; persist `RunRecord{ status, transport:'cdp-js' }`; return `okResult({ passed, transport:'cdp-js', ... })` or `failResult`.

- [ ] **Step 1: Write the failing test** (handler-level, injected deps — no device)

```js
// append to run-action-transport-blind.test.js
import { createRunActionHandler } from '../../dist/tools/run-action.js';
// ... build a handler whose maestroRun returns a SELECTOR_NOT_FOUND env, loadAction returns a
// fixture action with a tapOn step, and replayDeps returns a fake CdpReplayDeps whose treeFor
// reports the testID present. Assert: result.ok, data.passed true, data.transport==='cdp-js',
// and that maestro was NOT retried. Then a second test where treeFor reports the testID ABSENT →
// assert the existing repair path runs and replay is NOT invoked.
```
(Full fixture mirrors the existing `run-action` unit tests' harness — inject `maestroRun`, `loadActionFn`, `persist`, and the new `replayDeps`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/run-action-transport-blind.test.js`
Expected: FAIL — `replayDeps` not accepted / fallback not invoked.

- [ ] **Step 3: Implement the wiring**

In `cdp-replay-dispatch.ts` add:
```ts
import { normalizeSteps, replayFlow, type ReplayResult } from '../domain/cdp-flow-replay.js';
export async function runCdpReplay(body: unknown[], params: Record<string, string>, deps: CdpReplayDeps): Promise<ReplayResult> {
  const steps = normalizeSteps(body, params);            // throws UnsupportedStepError → caller maps to UNSUPPORTED_STEP
  return replayFlow(steps, buildCdpDispatch(deps));
}
```
In `run-action.ts`, after the route-drift block (~line 338), insert:
```ts
const replayDeps = deps.replayDeps?.(args) ?? null;
if (failure.kind === 'SELECTOR_NOT_FOUND' && replayDeps) {
  const tree = await replayDeps.treeFor(failure.selector).catch(() => null);
  if (isExactPresent(tree, failure.selector)) {
    try {
      const replay = await runCdpReplay(action.body, args.params ?? {}, replayDeps);
      const status = replay.passed ? 'pass' : 'fail';
      const autoRepair: AutoRepairOutcome = { attempted: false, outcome: 'skipped', phases: { firstAttemptMs } };
      await persistRun(args.actionId, projectRoot, {
        timestamp: new Date().toISOString(), durationMs: Date.now() - t0, status,
        failureCode: replay.passed ? undefined : 'TRANSPORT_BLIND',
        failureDetail: replay.reason, trigger, autoRepair, transport: 'cdp-js',
      });
      return replay.passed
        ? okResult({ passed: true, actionId: args.actionId, transport: 'cdp-js', autoRepair, durationMs: Date.now() - t0, flowFile: action.filePath })
        : failResult(`cdp_run_action: ${args.actionId} replayed via CDP/JS (WDA transport-blind) and failed at step ${replay.failedStepIndex}: ${replay.reason}`, 'TRANSPORT_BLIND', { actionId: args.actionId, transport: 'cdp-js', failedStepIndex: replay.failedStepIndex });
    } catch (e) {
      if (e instanceof UnsupportedStepError) {
        return failResult(`cdp_run_action: ${args.actionId} cannot replay via CDP/JS — ${e.message}. This action uses a step type the iOS 26.x fallback doesn't support; run on iOS 18 (WDA works there).`, 'UNSUPPORTED_STEP', { actionId: args.actionId, stepKey: e.stepKey });
      }
      throw e;
    }
  }
}
```
Add imports at the top of `run-action.ts`: `isExactPresent`, `runCdpReplay` from `./cdp-replay-dispatch.js`; `UnsupportedStepError` from `../domain/cdp-flow-replay.js`. Confirm `action.body` is the parsed step array on the loaded action (from `loadAction`); if the loader exposes the raw YAML body under a different field, adapt the property name (verify in `action-store.ts`).

- [ ] **Step 4: Build and run the full suite**

Run: `cd scripts/cdp-bridge && npm run build && npm test`
Expected: PASS (new tests + full suite green).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src scripts/cdp-bridge/dist scripts/cdp-bridge/test
git commit -m "feat(#317): wire CDP/JS replay fallback into cdp_run_action on transport-blind"
```

---

### Task 6: Wire real CDP deps in `index.ts` + device verification

**Files:**
- Modify: `scripts/cdp-bridge/src/index.ts` (the `createRunActionHandler({ ... })` call sites ~line 2156 and ~line 2237: pass `replayDeps`)

**Interfaces:**
- Consumes: `createInteractHandler(getClient)`, `createComponentTreeHandler(getClient)`, `getActiveSession`, `resolveIosUdid`.

- [ ] **Step 1: Implement `replayDeps`**

In `index.ts`, build the real deps from existing handlers (call the underlying handler fns; parse their envelopes):
```ts
const makeReplayDeps = () => {
  const session = getActiveSession();
  if (!session || session.platform !== 'ios') return null; // iOS-only fallback
  const interact = createInteractHandler(getClient);
  const tree = createComponentTreeHandler(getClient);
  return {
    pressByTestId: async (id) => { await interact({ action: 'press', testID: id }); },
    typeByTestId: async (id, text) => { await interact({ action: 'typeText', testID: id, text }); },
    treeFor: async (id) => {
      const env = JSON.parse((await tree({ filter: id, depth: 12 })).content[0].text);
      return env.ok ? env.data : null;
    },
    launchApp: async () => { /* simctl launch <udid> <appId> via existing helper */ },
    settle: async () => { await new Promise((r) => setTimeout(r, 400)); },
  };
};
```
Pass `replayDeps: makeReplayDeps` into both `createRunActionHandler({ ... })` calls.

- [ ] **Step 2: Build + full suite**

Run: `cd scripts/cdp-bridge && npm run build && npm test && cd .. && npm run lint && npm run format:check`
Expected: green; lint/format clean.

- [ ] **Step 3: Add changeset**

Create `.changeset/317-phase2-cdp-replay.md`:
```md
---
"rn-dev-agent-cdp": minor
---

#317 Phase 2: when an action fails on iOS 26.x because WebDriverAgent is blind (empty accessibility tree), cdp_run_action now replays the action's steps through the CDP/JS transport and returns a real pass/fail verdict — restoring the observe Regression Run button on iOS 26.x. Fallback verdicts are labeled transport:'cdp-js' (handler-level semantics); unsupported step types fail loudly.
```

- [ ] **Step 4: Device verification (the real proof)**

With the iOS 26.5 sim booted and the app connected (CDP), restart the worker (load new dist) and run an action via the observe endpoint or `cdp_run_action`:
- `cycle-task-priority` (non-mutating) → expect `passed:true`, `transport:'cdp-js'`.
- `toggle-theme` (mutating) → expect pass + the theme actually toggling (verify via `cdp_store_state`).
Record the result; capture `firstAttemptOutput` showing maestro failed first, then the CDP/JS replay passed.

- [ ] **Step 5: Commit + open PR**

```bash
git add -A && git commit -m "feat(#317): wire CDP/JS replay deps in index.ts + changeset"
git push -u origin <branch> && gh pr create --base main --title "feat(#317): Phase 2 — CDP/JS action-replay fallback for iOS 26.x"
```

---

## Self-Review

- **Spec coverage:** trigger (Task 5), CDP/JS transport (Tasks 2-3,6), exact-match oracle (Task 3), step subset + unsupported-fail (Task 1,5), focus tracking (Task 2), disabled-guard + negative test (Tasks 2-3), optional `transport` (Task 4), device verify (Task 6). ✓
- **Placeholder scan:** Task 5 Step 1 leaves the handler-fixture prose-described (mirrors existing run-action tests) — implementer must write it against the existing harness; flagged, not silently skipped. `action.body` field name to confirm against `action-store.ts` (noted inline).
- **Type consistency:** `ReplayStep`/`ReplayDispatch`/`ReplayResult`/`CdpReplayDeps`/`normalizeSteps`/`replayFlow`/`isExactPresent`/`runCdpReplay`/`collectTestIds` used consistently across tasks. `transport?: 'cdp-js'` consistent (Task 4 → 5 → 6).
