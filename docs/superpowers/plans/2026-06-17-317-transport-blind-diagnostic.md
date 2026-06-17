# #317 Phase 1 — TRANSPORT_BLIND diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cdp_repair_action` emit a truthful `TRANSPORT_BLIND` diagnostic — instead of the misleading "no confident replacement" — when Maestro/WDA reports a selector "not visible" but rn-fast-runner's own snapshot still contains it (the iOS 26.2 + bridgeless empty-a11y-tree failure in GH #317).

**Architecture:** A pure detector (`detectTransportBlind`) in `repair-engine.ts` checks whether the failed selector is present verbatim in the live rn-fast-runner snapshot. `cdp_repair_action` calls it **before** `attemptRepair` (which would otherwise filter the selector out and mislead/mis-patch) and short-circuits to a `TRANSPORT_BLIND` failResult; the no-confident-match path gains a soft transport-blind hint. `cdp_run_action` maps the new code to a `TRANSPORT_BLIND` refusal reason so telemetry and its own envelope are honest. No new device round-trips — the snapshot repair already takes is reused.

**Tech Stack:** TypeScript (Node ≥ 22), MCP bridge under `scripts/cdp-bridge/`. Tests: `node:test` + `node:assert/strict`, importing from compiled `dist/`.

## Global Constraints

- **Node.js ≥ 22 LTS.**
- **Tests build first:** the `test` npm script is `npm run build && node --test '...'`. Tests import from `dist/`, so always `npm run build` before running tests. Working dir for all commands: `scripts/cdp-bridge`.
- **`dist/` is tracked** — rebuild (`npm run build`) and stage the compiled output in every commit alongside `src`/`test`.
- **Commits:** signed (`git commit -S`), small, one per task. End every commit message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **One changeset** for the whole change (Task 4).
- **Explicit type imports** (`import type { ... }`). **No unnecessary comments** beyond the rationale comments shown.
- **Detection is verbatim + case-sensitive** (`candidates.includes(failedSelector)`); `failedSelector` is a bare testID by contract (`maestro-error-parser` captures `m[2]`).
- **The guard fires BEFORE `attemptRepair`** in `repair-action.ts`.
- **Error/message wording is the verbatim spec text** (Task 2 / Task 3 steps).

Spec: `docs/superpowers/specs/2026-06-17-317-transport-blind-diagnostic-design.md`.

## File Structure

- `src/domain/repair-engine.ts` — **modify**: add pure `detectTransportBlind(failedSelector, candidates)`. (Pure helpers home; no I/O.)
- `src/types.ts` — **modify**: add `'TRANSPORT_BLIND'` to `ToolErrorCode`.
- `src/tools/repair-action.ts` — **modify**: call the guard before `attemptRepair`; append soft hint to the no-match message.
- `src/domain/reusable-action.ts` — **modify**: add `'TRANSPORT_BLIND'` to `AutoRepairRefusedReason`.
- `src/tools/run-action.ts` — **modify**: map the code in `mapRefusedReason`; return code `TRANSPORT_BLIND` on that refusal.
- `test/unit/repair-engine.test.js` — **modify**: pure-helper tests.
- `test/unit/repair-action-handler.test.js` — **modify**: handler tests (verdict + soft hint + unchanged empty-snapshot).
- `test/unit/run-action-handler.test.js` — **modify**: refusal-mapping test.
- `.changeset/*.md` — **create**: changeset.

---

### Task 1: Pure detector `detectTransportBlind`

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/repair-engine.ts` (add after `walkTree`, ~line 133)
- Test: `scripts/cdp-bridge/test/unit/repair-engine.test.js`

**Interfaces:**
- Produces: `detectTransportBlind(failedSelector: string, candidates: string[]): boolean` — `true` iff `failedSelector` appears verbatim in `candidates`.

- [ ] **Step 1: Write the failing tests**

Add `detectTransportBlind` to the existing import block in `test/unit/repair-engine.test.js` (the `import { ... } from '../../dist/domain/repair-engine.js';` at lines 6–16), then append these tests:

```javascript
test('detectTransportBlind: failed selector present in snapshot → true (transport-blind)', () => {
  assert.equal(detectTransportBlind('submit_email_form', ['submit_email_form', 'other-1']), true);
});

test('detectTransportBlind: failed selector absent, other candidates present → false (possible drift)', () => {
  assert.equal(detectTransportBlind('submit_email_form', ['other-1', 'other-2']), false);
});

test('detectTransportBlind: empty candidate list → false', () => {
  assert.equal(detectTransportBlind('submit_email_form', []), false);
});

test('detectTransportBlind: verbatim match is case-sensitive', () => {
  assert.equal(detectTransportBlind('Submit', ['submit']), false);
});

test('detectTransportBlind: empty selector → false', () => {
  assert.equal(detectTransportBlind('', ['submit_email_form']), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/repair-engine.test.js`
Expected: build fails (`detectTransportBlind` not exported) or tests fail with "detectTransportBlind is not a function".

- [ ] **Step 3: Implement the detector**

In `src/domain/repair-engine.ts`, after `walkTree` (the `}` at ~line 133), add:

```typescript
/**
 * GH #317 — transport-blindness detector. Returns true when the
 * Maestro-reported failed selector is present VERBATIM in the live
 * rn-fast-runner snapshot's testID list: the element IS rendered and our
 * transport sees it, yet Maestro/WDA reported it "not visible" — i.e. WDA
 * read an empty/partial a11y tree (e.g. iOS 26.2 + bridgeless), not a
 * testID drift. A genuinely-renamed selector is absent from the snapshot,
 * so this stays false and real drift still flows to attemptRepair.
 *
 * Pure function — exported for unit tests.
 */
export function detectTransportBlind(failedSelector: string, candidates: string[]): boolean {
  if (!failedSelector) return false;
  return candidates.includes(failedSelector);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/repair-engine.test.js`
Expected: PASS (all `detectTransportBlind:` tests green; existing tests unaffected).

- [ ] **Step 5: Commit**

```bash
cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin
git add scripts/cdp-bridge/src/domain/repair-engine.ts \
        scripts/cdp-bridge/dist/domain/repair-engine.js \
        scripts/cdp-bridge/test/unit/repair-engine.test.js
git commit -S -m "feat(#317): detectTransportBlind pure helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `TRANSPORT_BLIND` guard + soft hint in `cdp_repair_action`

**Files:**
- Modify: `scripts/cdp-bridge/src/types.ts` (add code to `ToolErrorCode`, ~line 245 after `RUNNER_LEAK`)
- Modify: `scripts/cdp-bridge/src/tools/repair-action.ts` (guard before `attemptRepair` ~line 296; soft hint on no-match ~line 319)
- Test: `scripts/cdp-bridge/test/unit/repair-action-handler.test.js`

**Interfaces:**
- Consumes: `detectTransportBlind` (Task 1).
- Produces: `cdp_repair_action` failResult with code `'TRANSPORT_BLIND'` and `meta = { actionId, failedSelector, snapshotTestIdCount, candidatesSample, hint }`.

- [ ] **Step 1: Write the failing handler tests**

Append to `test/unit/repair-action-handler.test.js` (helpers `fakeSnapshot`, `_setRunAgentDeviceForTest`, `project.seedAction`, `fixtureYaml`, `FAKE_SESSION` already exist in this file):

```javascript
// ─────────────────────────────────────────────────────────────────────────────
// GH #317 — transport-blindness: rn-fast-runner sees the selector Maestro/WDA missed
// ─────────────────────────────────────────────────────────────────────────────

test('GH #317: failed selector present in snapshot → TRANSPORT_BLIND, not no-match', async () => {
  project.seedAction(
    'register-new-user',
    fixtureYaml({ id: 'register-new-user', selectors: ['submit_email_form'] }),
  );
  // The snapshot DOES contain the failed selector — rn-fast-runner sees it.
  _setRunAgentDeviceForTest(async () => ({
    content: [{ type: 'text', text: fakeSnapshot(['submit_email_form', 'header-home', 'btn-cancel']) }],
  }));

  const handler = createRepairActionHandler();
  const result = await handler({
    actionId: 'register-new-user',
    failedSelector: 'submit_email_form',
    projectRoot: project.root,
  });

  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'TRANSPORT_BLIND');
  assert.equal(env.meta.snapshotTestIdCount, 3);
  assert.equal(env.meta.failedSelector, 'submit_email_form');
  assert.match(env.error, /transport-blindness/i);
  assert.match(env.error, /rn-fast-runner sees it/i);
});

test('GH #317: selector absent + no confident match → TESTID_NOT_FOUND with transport-blind soft hint', async () => {
  project.seedAction(
    'register-new-user-2',
    fixtureYaml({ id: 'register-new-user-2', selectors: ['submit_email_form'] }),
  );
  // Snapshot has unrelated testIDs, none similar enough to clear 0.6.
  _setRunAgentDeviceForTest(async () => ({
    content: [{ type: 'text', text: fakeSnapshot(['totally-unrelated-aaa', 'zzz-different-bbb']) }],
  }));

  const handler = createRepairActionHandler();
  const result = await handler({
    actionId: 'register-new-user-2',
    failedSelector: 'submit_email_form',
    projectRoot: project.root,
  });

  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'TESTID_NOT_FOUND');
  assert.match(env.error, /no confident replacement/i);
  assert.match(env.error, /transport-blind/i);
  assert.match(env.error, /GH #317/);
});

test('GH #317: empty snapshot (0 testIDs) stays TESTID_NOT_FOUND, not TRANSPORT_BLIND', async () => {
  project.seedAction(
    'register-new-user-3',
    fixtureYaml({ id: 'register-new-user-3', selectors: ['submit_email_form'] }),
  );
  _setRunAgentDeviceForTest(async () => ({
    content: [{ type: 'text', text: fakeSnapshot([]) }],
  }));

  const handler = createRepairActionHandler();
  const result = await handler({
    actionId: 'register-new-user-3',
    failedSelector: 'submit_email_form',
    projectRoot: project.root,
  });

  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'TESTID_NOT_FOUND');
  assert.match(env.error, /0 testIDs/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/repair-action-handler.test.js`
Expected: the two new `TRANSPORT_BLIND`/soft-hint tests FAIL (first returns `TESTID_NOT_FOUND` not `TRANSPORT_BLIND`; second lacks the hint). The empty-snapshot test passes already.

- [ ] **Step 3a: Add the ToolErrorCode**

In `src/types.ts`, in the `ToolErrorCode` union, add after the `| 'RUNNER_LEAK'` line (~245):

```typescript
  | 'TRANSPORT_BLIND'          // GH #317: rn-fast-runner sees the selector but Maestro/WDA reported it not visible (empty a11y tree)
```

- [ ] **Step 3b: Add the import in repair-action.ts**

In `src/tools/repair-action.ts`, find the import from `'../domain/repair-engine.js'` (it already imports `extractAllTestIDs`, `attemptRepair`, `applyRepair`, `DEFAULT_REPAIR_THRESHOLD`) and add `detectTransportBlind` to that named-import list.

- [ ] **Step 3c: Insert the guard before `attemptRepair`**

In `src/tools/repair-action.ts`, between the end of the `if (candidates.length === 0) { ... }` block (~line 294) and `const result = attemptRepair(...)` (~line 296), insert:

```typescript
    // GH #317: transport-blindness guard. If the failed selector is present
    // verbatim in OUR snapshot, the element is rendered and rn-fast-runner can
    // see it — Maestro/WDA reported "not visible" because it read an empty a11y
    // tree (e.g. iOS 26.2 + bridgeless), NOT because the testID drifted. Fire
    // BEFORE attemptRepair, which filters the selector out of candidates and
    // would otherwise mislead ("no confident replacement") or mis-patch it.
    if (detectTransportBlind(args.failedSelector, candidates)) {
      return failResult(
        `cdp_repair_action: Maestro/WDA reported "${args.failedSelector}" not visible, but rn-fast-runner sees it (${candidates.length} testIDs in the live snapshot). This is transport-blindness, not testID drift — WDA reads an empty/partial accessibility tree on this runtime (e.g. iOS 26.2 + bridgeless, GH #317). Maestro-based replay is blocked here; drive the screen with device_* primitives (device_find/press/fill), which go through rn-fast-runner and work. rn-fast-runner-native action replay is tracked in #317 Phase 2.`,
        'TRANSPORT_BLIND',
        {
          actionId: args.actionId,
          failedSelector: args.failedSelector,
          snapshotTestIdCount: candidates.length,
          candidatesSample: candidates.slice(0, 50),
          hint: 'Verify with device_snapshot — it uses rn-fast-runner. If the element is present there, this is a WDA transport limitation, not your testID.',
        },
      );
    }
```

- [ ] **Step 3d: Append the soft hint to the no-match message**

In `src/tools/repair-action.ts`, in the `if (result.kind === 'no-match')` block (~line 318), replace the first `failResult` argument string:

```typescript
        `cdp_repair_action: no confident replacement for "${args.failedSelector}". ${result.reason}`,
```

with:

```typescript
        `cdp_repair_action: no confident replacement for "${args.failedSelector}". ${result.reason} If "${args.failedSelector}" is in fact correct and the screen renders, WDA may be transport-blind on this runtime (empty a11y tree; see GH #317) — confirm with device_snapshot, which uses rn-fast-runner.`,
```

(Leave the `'TESTID_NOT_FOUND'` code and `meta` unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/repair-action-handler.test.js`
Expected: PASS (all three GH #317 tests green; existing repair-action tests unaffected).

- [ ] **Step 5: Commit**

```bash
cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin
git add scripts/cdp-bridge/src/types.ts \
        scripts/cdp-bridge/src/tools/repair-action.ts \
        scripts/cdp-bridge/dist/types.js \
        scripts/cdp-bridge/dist/tools/repair-action.js \
        scripts/cdp-bridge/test/unit/repair-action-handler.test.js
git commit -S -m "feat(#317): TRANSPORT_BLIND guard + soft hint in cdp_repair_action

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Map `TRANSPORT_BLIND` refusal in `cdp_run_action`

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/reusable-action.ts` (add to `AutoRepairRefusedReason`, ~line 155)
- Modify: `scripts/cdp-bridge/src/tools/run-action.ts` (`mapRefusedReason` ~line 166; refusal-return code ~line 397)
- Test: `scripts/cdp-bridge/test/unit/run-action-handler.test.js`

**Interfaces:**
- Consumes: `cdp_repair_action` returning code `'TRANSPORT_BLIND'` (Task 2).
- Produces: `cdp_run_action` returns code `'TRANSPORT_BLIND'` with `meta.autoRepair.refusedReason === 'TRANSPORT_BLIND'`, no retry.

- [ ] **Step 1: Write the failing test**

In `test/unit/run-action-handler.test.js`, add a transport-blind repair envelope near the other `REPAIR_*_ENV` consts (~line 79):

```javascript
const REPAIR_TRANSPORT_BLIND_ENV = {
  ok: false,
  error: 'cdp_repair_action: Maestro/WDA reported "fab-create-task" not visible, but rn-fast-runner sees it (3 testIDs in the live snapshot). This is transport-blindness, not testID drift (GH #317).',
  code: 'TRANSPORT_BLIND',
};
```

Then append this test (mirror the existing refusal tests; seed an action whose body has the selector the `FAIL_SELECTOR_ENV` references — `fab-create-task`):

```javascript
test('run-action: repair returns TRANSPORT_BLIND → refused, no retry, honest code', async () => {
  project.seedAction(
    'demo',
    fixtureYaml({ id: 'demo', selectors: ['fab-create-task'] }),
  );
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun([FAIL_SELECTOR_ENV]),
    repairAction: fakeRepairAction(REPAIR_TRANSPORT_BLIND_ENV),
  });

  const result = await handler({ actionId: 'demo', projectRoot: project.root });

  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'TRANSPORT_BLIND');
  assert.equal(env.meta.autoRepair.outcome, 'refused');
  assert.equal(env.meta.autoRepair.refusedReason, 'TRANSPORT_BLIND');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/run-action-handler.test.js`
Expected: FAIL — `env.code` is `TESTID_NOT_FOUND` (hardcoded) and `refusedReason` is `INTERNAL_ERROR` (unmapped `TRANSPORT_BLIND` falls through).

- [ ] **Step 3a: Add the refusal reason to the union**

In `src/domain/reusable-action.ts`, in the `AutoRepairRefusedReason` union (~line 155), add a member:

```typescript
  | 'TRANSPORT_BLIND'
```

- [ ] **Step 3b: Map the code in `mapRefusedReason`**

In `src/tools/run-action.ts`, in `mapRefusedReason` (~line 166), add immediately after the `RUNNER_LEAK` mapping (line 173):

```typescript
  if (repairCode === 'TRANSPORT_BLIND') return 'TRANSPORT_BLIND';
```

- [ ] **Step 3c: Return the honest code on the refusal**

In `src/tools/run-action.ts`, in the `if (!repairPatched) { ... }` block, the `return failResult(...)` (~line 397) currently passes the literal `'TESTID_NOT_FOUND'`. Change that code argument to:

```typescript
        refusedReason === 'TRANSPORT_BLIND' ? 'TRANSPORT_BLIND' : 'TESTID_NOT_FOUND',
```

(`refusedReason` is already in scope from line 378. The message and `meta` stay as-is — the detailed transport-blind text flows through `repairEnv.error`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/run-action-handler.test.js`
Expected: PASS (the new test green; existing run-action tests, including the `REPAIR_NO_MATCH_ENV → NO_MATCH` refusal, unaffected).

- [ ] **Step 5: Commit**

```bash
cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin
git add scripts/cdp-bridge/src/domain/reusable-action.ts \
        scripts/cdp-bridge/src/tools/run-action.ts \
        scripts/cdp-bridge/dist/domain/reusable-action.js \
        scripts/cdp-bridge/dist/tools/run-action.js \
        scripts/cdp-bridge/test/unit/run-action-handler.test.js
git commit -S -m "feat(#317): map TRANSPORT_BLIND refusal in cdp_run_action

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Changeset + full-suite verification

**Files:**
- Create: `.changeset/<descriptive-slug>.md`

- [ ] **Step 1: Run the full test suite**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS — the entire `test/unit/**` suite green (prior baseline 2216 + the new tests).

- [ ] **Step 2: Create the changeset**

Inspect an existing changeset for the package name and bump convention:

Run: `cat /Users/anton_personal/GitHub/claude-react-native-dev-plugin/.changeset/*.md | head -20`

Create `.changeset/transport-blind-317.md` with the package-name key from that example (the cdp-bridge package), e.g.:

```markdown
---
"<cdp-bridge-package-name>": patch
---

cdp_repair_action now reports TRANSPORT_BLIND when the failed Maestro selector is present in the live rn-fast-runner snapshot — the iOS 26.2 + bridgeless empty-a11y-tree case (GH #317) — instead of the misleading "no confident replacement". cdp_run_action surfaces it as a terminal refusal with refusedReason TRANSPORT_BLIND. Diagnostic-only; restoring replay on that runtime is Phase 2.
```

(Use the exact package name(s) the repo's existing changesets reference. If the CI changeset-name validator from #316/B215 is present, double-check the key matches a real workspace package.)

- [ ] **Step 3: Verify nothing else references the old behavior**

Run: `cd scripts/cdp-bridge && grep -rn "TRANSPORT_BLIND" src/ test/`
Expected: references only in `repair-engine.ts`, `types.ts`, `repair-action.ts`, `reusable-action.ts`, `run-action.ts`, and the three test files — no stragglers, no typos.

- [ ] **Step 4: Commit**

```bash
cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin
git add .changeset/transport-blind-317.md
git commit -S -m "chore(#317): changeset for TRANSPORT_BLIND diagnostic

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Detection rule (verbatim exact-present) → Task 1 (`detectTransportBlind`).
- Guard placed before `attemptRepair` → Task 2 Step 3c.
- Hard verdict `TRANSPORT_BLIND` with `snapshotTestIdCount` + message → Task 2 Step 3a/3c + tests.
- Soft hint on no-match → Task 2 Step 3d + test.
- Empty snapshot stays `TESTID_NOT_FOUND` → Task 2 test 3.
- `AutoRepairRefusedReason` gains `TRANSPORT_BLIND` → Task 3 Step 3a.
- `mapRefusedReason` mapping (avoid `INTERNAL_ERROR`) → Task 3 Step 3b.
- `cdp_run_action` honest code + no retry → Task 3 Step 3c + test.
- Changeset + full suite green + no new device round-trips → Task 4 (round-trips: the guard reuses the existing snapshot; no new device calls added — verified by reading repair-action.ts, no new `runNative`).
- "Tests build first / dist tracked / signed commits / one changeset" → Global Constraints + every Step 5 / Task 4.

**2. Placeholder scan:** The only `<...>` is the changeset package-name key, which Task 4 Step 2 resolves by reading an existing changeset — deliberate, not a TODO. All code steps show full code.

**3. Type consistency:** `detectTransportBlind(failedSelector: string, candidates: string[]): boolean` is defined in Task 1 and consumed verbatim in Task 2. `'TRANSPORT_BLIND'` is added to `ToolErrorCode` (Task 2) before being passed to `failResult`, and to `AutoRepairRefusedReason` (Task 3) before `mapRefusedReason` returns it — no use-before-definition. `env.meta.*` (not `env.data.*`) matches `failResult(error, code, meta)`'s envelope shape.
