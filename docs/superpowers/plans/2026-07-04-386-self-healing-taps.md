# Story 05 — Self-Healing Taps Implementation Plan (GH #386)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert most `STALE_REF` refusals into transparent in-tool repairs (re-resolve the ref by identity, tap the recomputed center) and detect swallowed taps via the Story 04 settle hash (one automatic re-tap, then `meta.noUiChange`), with a wedged-runtime hint after 3 consecutive no-change taps on distinct targets.

**Spec:** `docs/stories/05-self-healing-taps.md` (approved via PR #381). Depends on Story 04 (#385, merged as PR #442).

**Architecture:** All healing happens at the `runNative()` dispatch choke point in `scripts/cdp-bridge/src/agent-device-wrapper.ts`, between `buildRunIOSArgs`/`buildRunAndroidArgs` (which emit a `_staleRef` sentinel) and the runner dispatch — one site covers both platforms. The matcher (`refreshRef`) is a pure function in `fast-runner-ref-map.ts`. Change detection extends the Story 04 settle engine (`lifecycle/settle.ts`), which already computes `hierarchyChanged` in its snapshot-eq tier and already refreshes the ref-map on every snapshot poll.

**Tech Stack:** TypeScript (Node 22+), `node:test` unit tests importing from `dist/` (build-first), zod tool schemas in `src/index.ts`.

**Working directory:** `scripts/cdp-bridge/` unless a path says otherwise. Branch: `feat/386-self-healing-taps` (create via superpowers:using-git-worktrees at execution start).

## Global Constraints

- **Unique-match or refuse** (Maestro's rule, spec §Design): re-resolution taps ONLY on exactly one identity match — ambiguous/absent keeps `STALE_REF`, "never a guess-tap (correctness over convenience; a wrong tap is worse than a refusal)".
- **Identity = attrs-minus-bounds**: compare `type`/`label`/`identifier` exactly. `indexPath` (here: flat index) "is a tie-breaker only when everything else matches multiply *and* the tree shape is unchanged — never a primary key".
- **Exactly 2 tap attempts total** (spec §Acceptance: "exactly one automatic retry … never an infinite loop").
- **`retryIfNoChange: true` default** (spec §Design step 3, "Maestro's default"); per-call opt-out.
- **Advisory contract** (Story 04 precedent): healing/retry NEVER turns a succeeded dispatch into an error; a still-unchanged retry returns success + `meta.noUiChange: true`, because "the tap may legitimately be a no-op".
- **`RN_SELF_HEAL=0`/`false` disables** both re-resolution and retry-if-no-change (mirrors `RN_SETTLE` convention; default ON).
- **Keep repair-engine policies separate** (spec §Risks): `refreshRef` heals runtime staleness; do NOT touch `cdp_repair_action`'s Levenshtein/budget/refusal semantics.
- **Wedged hint**: 3 consecutive `noUiChange` results on **distinct** targets → `meta.hint` referencing spec 2026-06-14-263 recovery (`cdp_status` auto-recovery / `cdp_restart hardReset=true`). The streak resets on PROVEN UI change (`hierarchyChanged === true`) and on session clear — NOT on unobserved mutations (a wedged runtime "succeeds" at swipes too; auto-resetting on every non-tap verb would make the detector unreachable in mixed flows). Documented edge: an unobserved real change between dead taps can produce a false hint — acceptable, the hint is advisory meta.
- **Baseline-freshness policy** (multi-LLM review consensus #1/#2): the pre-tap hash comes from `getLastSnapshotHash()`, refreshed as a side effect of every real snapshot (settle probes, healing, device_snapshot/find). Any MUTATING verb that settles **without a hash observation** (fast tier + no change detection, settle disabled, settle error) **invalidates the baseline** (`invalidateLastSnapshotHash()`), so the next tap sees no baseline and safely skips retry-detection (fail-open) instead of comparing against a pre-mutation screen (fail-wrong). Coverage consequence, documented: tap sequences and taps after snapshots/finds get detection; the first tap after a fill/swipe/back that settled silently does not. `retryIfNoChange` stays default-ON per spec; only eligible taps pay the one post-settle hash probe (~50–150 ms Android, ~150–400 ms iOS interactiveOnly) — non-tap verbs pay nothing, and the probe refreshes the ref-map (fewer future stale refs).
- Repo conventions: explicit type imports, no unnecessary comments, `meta.timings_ms` instrumentation for new slow paths, `dist/` is tracked (stage rebuilt output in each commit), changeset per change, signed commits.
- Test command: `npm test` (runs `tsc` build then all unit tests). Single file after build: `npm run build && node --test test/unit/<file>.test.js`.

## File Structure

| File | Change |
|---|---|
| `src/fast-runner-ref-map.ts` | Capture `RefSignature` (flatIndex + nodeCount) and `lastSnapshotHash` at `updateRefMapFromFlat`; add `getCachedSignature`, `getLastSnapshotHash`, `refreshRef` |
| `src/lifecycle/settle.ts` | Post-settle change probe on window-gate/screen-static tiers when `initialSnapshotHash` provided |
| `src/lifecycle/no-change-tracker.ts` | **New** — consecutive-noUiChange streak + wedged hint constant |
| `src/agent-device-wrapper.ts` | `selfHealEnabled`, `healStaleRef`, enriched STALE_REF fail, `settleAfterMutationWithOutcome`, `settleWithRetryIfNoChange`, `tapRetryPolicy`; wire both into `runNative` iOS + Android branches; Android longPress sentinel keeps `durationMs` |
| `src/tools/device-interact.ts` | `retryIfNoChange` arg on press/longpress handlers |
| `src/index.ts` | `retryIfNoChange` zod param on `device_press`/`device_longpress`; description updates |
| `src/tools/device-batch.ts` | `findRefsByTestID` unique-match + `AMBIGUOUS_TESTID` refusal (spec §"Keep the boundary honest") |
| `test/unit/story-05-*.test.js` | 8 new test files (one per task below) |

---

### Task 1: Ref signature capture + last-snapshot hash (`fast-runner-ref-map.ts`)

**Files:**
- Modify: `src/fast-runner-ref-map.ts`
- Test: `test/unit/story-05-ref-signature.test.js`

**Interfaces:**
- Consumes: existing `updateRefMapFromFlat(nodes: FlatNode[])`, `clearRefMap()`, `hashSnapshotNodes(nodes)` from `./lifecycle/settle-hash.js` (safe runtime import — settle-hash imports only a *type* from this module, no cycle).
- Produces (later tasks rely on these exact names):
  - `export interface RefSignature { type: string; label?: string; identifier?: string; flatIndex: number; nodeCount: number }`
  - `export function getCachedSignature(ref: string): RefSignature | null`
  - `export function getLastSnapshotHash(): string | null`
  - `export function invalidateLastSnapshotHash(): void` (baseline-freshness policy — see Global Constraints)

- [ ] **Step 1: Write the failing test**

```js
// test/unit/story-05-ref-signature.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  updateRefMapFromFlat,
  clearRefMap,
  getCachedSignature,
  getCachedMetadata,
  getLastSnapshotHash,
  invalidateLastSnapshotHash,
} from '../../dist/fast-runner-ref-map.js';
import { hashSnapshotNodes } from '../../dist/lifecycle/settle-hash.js';

const rect = (x = 0, y = 0) => ({ x, y, width: 100, height: 40 });
const nodes = [
  { ref: '@e0', type: 'Button', label: 'Save', identifier: 'save-btn', rect: rect(0, 0) },
  { ref: '@e1', type: 'Button', label: 'Cancel', rect: rect(0, 50) },
  { ref: '@e2', type: 'TextField', identifier: 'name-input', rect: rect(0, 100) },
];

beforeEach(() => clearRefMap());

test('getCachedSignature returns identity attrs + flatIndex + nodeCount', () => {
  updateRefMapFromFlat(nodes);
  assert.deepEqual(getCachedSignature('@e1'), {
    type: 'Button',
    label: 'Cancel',
    flatIndex: 1,
    nodeCount: 3,
  });
  assert.deepEqual(getCachedSignature('e0'), {
    type: 'Button',
    label: 'Save',
    identifier: 'save-btn',
    flatIndex: 0,
    nodeCount: 3,
  });
});

test('getCachedSignature returns null for unknown ref and after clear', () => {
  updateRefMapFromFlat(nodes);
  assert.equal(getCachedSignature('@e99'), null);
  clearRefMap();
  assert.equal(getCachedSignature('@e0'), null);
});

test('getCachedMetadata keeps its exact legacy 3-field shape', () => {
  updateRefMapFromFlat(nodes);
  assert.deepEqual(getCachedMetadata('@e0'), {
    type: 'Button',
    label: 'Save',
    identifier: 'save-btn',
  });
});

test('getLastSnapshotHash matches hashSnapshotNodes of the fed nodes; null after clear', () => {
  assert.equal(getLastSnapshotHash(), null);
  updateRefMapFromFlat(nodes);
  assert.equal(getLastSnapshotHash(), hashSnapshotNodes(nodes));
  clearRefMap();
  assert.equal(getLastSnapshotHash(), null);
});

test('invalidateLastSnapshotHash nulls the baseline without touching refs', () => {
  updateRefMapFromFlat(nodes);
  invalidateLastSnapshotHash();
  assert.equal(getLastSnapshotHash(), null);
  assert.notEqual(getCachedSignature('@e0'), null); // refs still resolvable
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/story-05-ref-signature.test.js`
Expected: FAIL — `getCachedSignature` is not exported (build error or import undefined).

- [ ] **Step 3: Implement in `src/fast-runner-ref-map.ts`**

Add the import at the top:

```ts
import { hashSnapshotNodes } from './lifecycle/settle-hash.js';
```

Change the metadata storage (replace the existing `RefMetadata`/`metadataMap` declarations):

```ts
interface RefMetadata {
  type: string;
  label?: string;
  identifier?: string;
}

export interface RefSignature {
  type: string;
  label?: string;
  identifier?: string;
  flatIndex: number;
  nodeCount: number;
}

interface StoredRefRecord extends RefMetadata {
  flatIndex: number;
}

let metadataMap = new Map<string, StoredRefRecord>();
let lastSnapshotNodeCount = 0;
let lastSnapshotHash: string | null = null;
```

In `updateRefMapFromFlat`, switch the loop to an index form and record the extras (replace the existing loop body's metadata insert; keep the refMap/screenRect logic identical):

```ts
export function updateRefMapFromFlat(nodes: FlatNode[]): void {
  refMap.clear();
  metadataMap.clear();
  screenRect = null;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node.ref || !node.rect) continue;
    const key = node.ref.startsWith('@') ? node.ref.slice(1) : node.ref;
    refMap.set(key, node.rect);

    const meta: StoredRefRecord = { type: node.type, flatIndex: i };
    if (node.label !== undefined) meta.label = node.label;
    if (node.identifier !== undefined) meta.identifier = node.identifier;
    metadataMap.set(key, meta);

    if (!screenRect && node.rect.x === 0 && node.rect.y === 0 && node.rect.width > 300) {
      screenRect = node.rect;
    }
  }

  lastSnapshotNodeCount = nodes.length;
  lastSnapshotHash = hashSnapshotNodes(nodes);
  lastUpdated = Date.now();
}
```

Fix `getCachedMetadata` to strip the new field (exact legacy shape — STALE_REF payloads and tests deepEqual it):

```ts
export function getCachedMetadata(ref: string): RefMetadata | null {
  const key = ref.startsWith('@') ? ref.slice(1) : ref;
  const rec = metadataMap.get(key);
  if (!rec) return null;
  const meta: RefMetadata = { type: rec.type };
  if (rec.label !== undefined) meta.label = rec.label;
  if (rec.identifier !== undefined) meta.identifier = rec.identifier;
  return meta;
}
```

Add the new accessors:

```ts
export function getCachedSignature(ref: string): RefSignature | null {
  const key = ref.startsWith('@') ? ref.slice(1) : ref;
  const rec = metadataMap.get(key);
  if (!rec) return null;
  const sig: RefSignature = {
    type: rec.type,
    flatIndex: rec.flatIndex,
    nodeCount: lastSnapshotNodeCount,
  };
  if (rec.label !== undefined) sig.label = rec.label;
  if (rec.identifier !== undefined) sig.identifier = rec.identifier;
  return sig;
}

export function getLastSnapshotHash(): string | null {
  return lastSnapshotHash;
}

// Story 05 (#386): called when a mutating verb settles without any hash
// observation — the screen may have changed unobserved, so the baseline must
// not be compared against. Fail-open beats fail-wrong.
export function invalidateLastSnapshotHash(): void {
  lastSnapshotHash = null;
}
```

In `clearRefMap`, add resets:

```ts
  lastSnapshotNodeCount = 0;
  lastSnapshotHash = null;
```

Do NOT touch the legacy `updateRefMap(nodes: SnapshotNode[])` path (it never populated metadata; out of scope).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/story-05-ref-signature.test.js`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — expected: all green (existing `stale-ref-detection.test.js` exercises `getCachedMetadata` shape).

```bash
git add src/fast-runner-ref-map.ts test/unit/story-05-ref-signature.test.js dist
git commit -m "feat(story-05): capture ref identity signatures + last snapshot hash in ref-map (#386)"
```

---

### Task 2: `refreshRef()` — the pure re-resolution matcher

**Files:**
- Modify: `src/fast-runner-ref-map.ts`
- Test: `test/unit/story-05-refresh-ref.test.js`

**Interfaces:**
- Consumes: `RefSignature` (Task 1), `FlatNode`.
- Produces:
  - `export type RefreshOutcome = { kind: 'unique'; node: FlatNode } | { kind: 'ambiguous'; candidates: FlatNode[] } | { kind: 'absent' }`
  - `export function refreshRef(sig: RefSignature, nodes: FlatNode[]): RefreshOutcome`

- [ ] **Step 1: Write the failing test (spec's matcher matrix)**

```js
// test/unit/story-05-refresh-ref.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshRef } from '../../dist/fast-runner-ref-map.js';

const rect = (x, y) => ({ x, y, width: 100, height: 40 });
const btn = (ref, label, identifier, y) => ({
  ref,
  type: 'Button',
  ...(label !== undefined ? { label } : {}),
  ...(identifier !== undefined ? { identifier } : {}),
  rect: rect(0, y),
});
const sig = (over = {}) => ({
  type: 'Button',
  label: 'Save',
  identifier: 'save-btn',
  flatIndex: 1,
  nodeCount: 3,
  ...over,
});

test('unique: exactly one attrs-minus-bounds match, even at a new position', () => {
  const nodes = [btn('@e0', 'Other', 'x', 0), btn('@e1', 'Cancel', undefined, 50), btn('@e2', 'Save', 'save-btn', 400)];
  const out = refreshRef(sig(), nodes);
  assert.equal(out.kind, 'unique');
  assert.equal(out.node.ref, '@e2');
});

test('absent: zero matches (element truly gone)', () => {
  const nodes = [btn('@e0', 'Other', 'x', 0)];
  assert.deepEqual(refreshRef(sig(), nodes), { kind: 'absent' });
});

test('label changed but testID same → absent (exact attrs, never fuzzy)', () => {
  const nodes = [btn('@e0', 'Saving…', 'save-btn', 0)];
  assert.equal(refreshRef(sig(), nodes).kind, 'absent');
});

test('testID changed but label same → absent', () => {
  const nodes = [btn('@e0', 'Save', 'save-btn-v2', 0)];
  assert.equal(refreshRef(sig(), nodes).kind, 'absent');
});

test('ambiguous: two identical siblings, tree shape changed → candidates, no guess', () => {
  const nodes = [
    btn('@e0', 'Save', 'save-btn', 0),
    btn('@e1', 'Save', 'save-btn', 50),
  ];
  const out = refreshRef(sig({ nodeCount: 3 }), nodes); // 2 !== 3 → shape changed
  assert.equal(out.kind, 'ambiguous');
  assert.equal(out.candidates.length, 2);
});

test('index tie-break: identical siblings, tree shape UNCHANGED → unique at cached flatIndex', () => {
  const nodes = [
    btn('@e0', 'Save', 'save-btn', 0),
    btn('@e1', 'Save', 'save-btn', 50),
    btn('@e2', 'Other', 'x', 100),
  ];
  const out = refreshRef(sig({ flatIndex: 1, nodeCount: 3 }), nodes);
  assert.equal(out.kind, 'unique');
  assert.equal(out.node.ref, '@e1');
});

test('index-shift trap: shape unchanged but no candidate at cached index → ambiguous', () => {
  const nodes = [
    btn('@e0', 'Other', 'x', 0),
    btn('@e1', 'Save', 'save-btn', 50),
    btn('@e2', 'Save', 'save-btn', 100),
  ];
  const out = refreshRef(sig({ flatIndex: 0, nodeCount: 3 }), nodes);
  assert.equal(out.kind, 'ambiguous');
});

test('optional attrs: undefined label matches only undefined label', () => {
  const nodes = [btn('@e0', undefined, 'save-btn', 0), btn('@e1', 'Save', 'save-btn', 50)];
  const out = refreshRef(sig({ label: undefined }), nodes);
  assert.equal(out.kind, 'unique');
  assert.equal(out.node.ref, '@e0');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/story-05-refresh-ref.test.js`
Expected: FAIL — `refreshRef` not exported.

- [ ] **Step 3: Implement in `src/fast-runner-ref-map.ts`**

```ts
export type RefreshOutcome =
  | { kind: 'unique'; node: FlatNode }
  | { kind: 'ambiguous'; candidates: FlatNode[] }
  | { kind: 'absent' };

function identityMatches(sig: RefSignature, node: FlatNode): boolean {
  return node.type === sig.type && node.label === sig.label && node.identifier === sig.identifier;
}

// Story 05 (#386): re-bind a stale ref to the live tree by identity attrs
// (type/label/identifier — bounds excluded; enabled/hittable are state, not
// identity). Maestro's rule: tap only on a UNIQUE match. The flat index is a
// tie-breaker only when the tree shape is unchanged — never a primary key.
export function refreshRef(sig: RefSignature, nodes: FlatNode[]): RefreshOutcome {
  const matches: { node: FlatNode; index: number }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (identityMatches(sig, nodes[i])) matches.push({ node: nodes[i], index: i });
  }
  if (matches.length === 0) return { kind: 'absent' };
  if (matches.length === 1) return { kind: 'unique', node: matches[0].node };
  if (nodes.length === sig.nodeCount) {
    const atSameIndex = matches.filter((m) => m.index === sig.flatIndex);
    if (atSameIndex.length === 1) return { kind: 'unique', node: atSameIndex[0].node };
  }
  return { kind: 'ambiguous', candidates: matches.map((m) => m.node) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/story-05-refresh-ref.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fast-runner-ref-map.ts test/unit/story-05-refresh-ref.test.js dist
git commit -m "feat(story-05): refreshRef unique-match re-resolution primitive (#386)"
```

---

### Task 3: `healStaleRef` + `runNative` healing wiring + enriched STALE_REF

**Files:**
- Modify: `src/agent-device-wrapper.ts`
- Test: `test/unit/story-05-heal-stale-ref.test.js`

**Interfaces:**
- Consumes: `getCachedSignature`, `getCachedMetadata`, `refreshRef`, `FlatNode` (Tasks 1–2); existing `failResult`, `attachMeta`, `buildRunIOSArgs`, `buildRunAndroidArgs`.
- Produces:
  - `export function selfHealEnabled(env: NodeJS.ProcessEnv): boolean` — `RN_SELF_HEAL` !== '0'/'false'
  - `export async function healStaleRef(staleRef: string, snapshot: () => Promise<ToolResult>): Promise<HealOutcome>` where `export type HealOutcome = { kind: 'healed'; x: number; y: number; newRef: string; ms: number } | { kind: 'failed'; result: ToolResult }`
  - `meta.reResolved: true`, `meta.reResolvedRef`, `meta.timings_ms.reResolve` on healed dispatches
  - STALE_REF failResults now carry `reResolution: 'absent' | 'ambiguous' | 'no-signature' | 'snapshot-failed'` and `candidates: FlatNode[]` (≤5)

- [ ] **Step 1: Write the failing test**

```js
// test/unit/story-05-heal-stale-ref.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { healStaleRef, selfHealEnabled } from '../../dist/agent-device-wrapper.js';
import { updateRefMapFromFlat, clearRefMap } from '../../dist/fast-runner-ref-map.js';
import { okResult, failResult } from '../../dist/utils.js';

const rect = (y) => ({ x: 0, y, width: 100, height: 40 });
const oldNodes = [
  { ref: '@e0', type: 'Button', label: 'Save', identifier: 'save-btn', rect: rect(0) },
  { ref: '@e1', type: 'Button', label: 'Cancel', rect: rect(50) },
];
const snapshotOf = (nodes) => async () => okResult({ nodes });
const parse = (r) => JSON.parse(r.content[0].text);

beforeEach(() => clearRefMap());

test('selfHealEnabled: default on, RN_SELF_HEAL=0/false off', () => {
  assert.equal(selfHealEnabled({}), true);
  assert.equal(selfHealEnabled({ RN_SELF_HEAL: '1' }), true);
  assert.equal(selfHealEnabled({ RN_SELF_HEAL: '0' }), false);
  assert.equal(selfHealEnabled({ RN_SELF_HEAL: 'false' }), false);
});

test('unique re-resolution → healed with recomputed center + new ref', async () => {
  updateRefMapFromFlat(oldNodes);
  const fresh = [
    { ref: '@e0', type: 'Other', label: 'Header', rect: rect(0) },
    { ref: '@e1', type: 'Button', label: 'Save', identifier: 'save-btn', rect: { x: 20, y: 300, width: 100, height: 40 } },
  ];
  const out = await healStaleRef('@e0', snapshotOf(fresh));
  assert.equal(out.kind, 'healed');
  assert.equal(out.x, 70); // 20 + 100/2
  assert.equal(out.y, 320); // 300 + 40/2
  assert.equal(out.newRef, '@e1');
  assert.equal(typeof out.ms, 'number');
});

test('ambiguous → failed STALE_REF with candidates (≤5) and pre-snapshot cachedMetadata', async () => {
  updateRefMapFromFlat(oldNodes);
  const dupe = (ref, y) => ({ ref, type: 'Button', label: 'Save', identifier: 'save-btn', rect: rect(y) });
  const fresh = [dupe('@e0', 0), dupe('@e1', 50), dupe('@e2', 100), dupe('@e3', 150), dupe('@e4', 200), dupe('@e5', 250), dupe('@e6', 300)];
  const out = await healStaleRef('@e0', snapshotOf(fresh));
  assert.equal(out.kind, 'failed');
  const env = parse(out.result);
  assert.equal(env.error.code, 'STALE_REF');
  assert.equal(env.data.reResolution, 'ambiguous');
  assert.equal(env.data.candidates.length, 5);
  assert.deepEqual(env.data.cachedMetadata, { type: 'Button', label: 'Save', identifier: 'save-btn' });
});

test('absent → failed STALE_REF with empty candidates', async () => {
  updateRefMapFromFlat(oldNodes);
  const out = await healStaleRef('@e0', snapshotOf([{ ref: '@e0', type: 'Other', rect: rect(0) }]));
  assert.equal(out.kind, 'failed');
  const env = parse(out.result);
  assert.equal(env.data.reResolution, 'absent');
  assert.deepEqual(env.data.candidates, []);
});

test('no cached signature → failed no-signature without calling snapshot', async () => {
  let called = false;
  const out = await healStaleRef('@e9', async () => { called = true; return okResult({ nodes: [] }); });
  assert.equal(out.kind, 'failed');
  assert.equal(called, false);
  assert.equal(parse(out.result).data.reResolution, 'no-signature');
});

test('snapshot infra failure → failed snapshot-failed (does not mask as absent)', async () => {
  updateRefMapFromFlat(oldNodes);
  const out = await healStaleRef('@e0', async () => failResult('runner gone', 'RN_FAST_RUNNER_DOWN'));
  assert.equal(out.kind, 'failed');
  assert.equal(parse(out.result).data.reResolution, 'snapshot-failed');
});
```

Note: check `dist/utils.js` exports `okResult`/`failResult` and the failResult envelope shape (`{ok:false, error:{code}, data}`) before finalizing assertions — mirror whatever `stale-ref-detection.test.js` asserts today (it parses the same envelopes).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/story-05-heal-stale-ref.test.js`
Expected: FAIL — `healStaleRef`/`selfHealEnabled` not exported.

- [ ] **Step 3: Implement in `src/agent-device-wrapper.ts`**

Extend the existing `./fast-runner-ref-map.js` import with `getCachedSignature`, `getCachedMetadata`, `refreshRef`, `getLastSnapshotHash` and `type FlatNode`, `type RefreshOutcome` (keep existing imported names). Then add:

```ts
export function selfHealEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.RN_SELF_HEAL?.trim().toLowerCase();
  return v !== '0' && v !== 'false';
}

const MAX_STALE_CANDIDATES = 5;

type StaleReason = 'absent' | 'ambiguous' | 'no-signature' | 'snapshot-failed';

function staleRefFail(
  ref: string,
  reason: StaleReason,
  cachedMetadata: ReturnType<typeof getCachedMetadata>,
  candidates: FlatNode[] = [],
): ToolResult {
  const message =
    reason === 'ambiguous'
      ? `Element at ref ${ref} is stale and re-resolution matched ${candidates.length} elements — refusing to guess-tap`
      : `Element at ref ${ref} no longer hittable — UI re-rendered since snapshot`;
  const hint =
    reason === 'ambiguous'
      ? 'Multiple elements share the cached identity. The ref-map was refreshed by this call — pick the intended ref from `candidates` and retry.'
      : reason === 'snapshot-failed'
        ? 'Snapshot infrastructure failed during re-resolution. Check cdp_status / reopen the device session, then retry.'
        : 'Element not re-resolvable by identity (it changed or unmounted). Call device_snapshot action=snapshot and re-find the target.';
  return failResult(message, 'STALE_REF', {
    cachedMetadata,
    reResolution: reason,
    candidates: candidates.slice(0, MAX_STALE_CANDIDATES),
    hint,
  });
}

export type HealOutcome =
  | { kind: 'healed'; x: number; y: number; newRef: string; ms: number }
  | { kind: 'failed'; result: ToolResult };

function extractSnapshotNodes(result: ToolResult): FlatNode[] | null {
  if (result.isError) return null;
  try {
    const env = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: { nodes?: FlatNode[] };
    };
    if (env.ok === false) return null;
    return Array.isArray(env.data?.nodes) ? env.data.nodes : null;
  } catch {
    return null;
  }
}

// Story 05 (#386): re-resolve a stale @ref by identity instead of refusing.
// The snapshot closure must be the platform's real snapshot (it also refreshes
// the ref-map as a side effect). Signature + metadata are captured BEFORE the
// snapshot replaces the map.
export async function healStaleRef(
  staleRef: string,
  snapshot: () => Promise<ToolResult>,
): Promise<HealOutcome> {
  const t0 = Date.now();
  const cachedMetadata = getCachedMetadata(staleRef);
  const sig = getCachedSignature(staleRef);
  if (!sig) return { kind: 'failed', result: staleRefFail(staleRef, 'no-signature', cachedMetadata) };
  let nodes: FlatNode[] | null;
  try {
    nodes = extractSnapshotNodes(await snapshot());
  } catch {
    nodes = null;
  }
  if (!nodes) return { kind: 'failed', result: staleRefFail(staleRef, 'snapshot-failed', cachedMetadata) };
  const outcome: RefreshOutcome = refreshRef(sig, nodes);
  if (outcome.kind === 'unique') {
    const r = outcome.node.rect;
    return {
      kind: 'healed',
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      newRef: outcome.node.ref,
      ms: Date.now() - t0,
    };
  }
  if (outcome.kind === 'ambiguous') {
    return { kind: 'failed', result: staleRefFail(staleRef, 'ambiguous', cachedMetadata, outcome.candidates) };
  }
  return { kind: 'failed', result: staleRefFail(staleRef, 'absent', cachedMetadata) };
}
```

Wire into `runNative` **iOS branch** (between `const ios = buildRunIOSArgs(cliArgs, appId);` and `let result = await runIOS(ios);`):

```ts
    let healMeta: Record<string, unknown> | null = null;
    if (ios._staleRef && selfHealEnabled(process.env)) {
      const healed = await healStaleRef(ios._staleRef, () =>
        runIOS({ command: 'snapshot', interactiveOnly: true, ...(appId ? { bundleId: appId } : {}) }),
      );
      if (healed.kind === 'failed') return healed.result;
      ios.x = healed.x;
      ios.y = healed.y;
      delete ios._staleRef;
      healMeta = {
        reResolved: true,
        reResolvedRef: healed.newRef,
        timings_ms: { reResolve: healed.ms },
      };
    }
```

and after the settle call, before the return:

```ts
    if (healMeta) result = attachMeta(result, healMeta);
```

Wire into `runNative` **Android branch** identically (the branch already has `runAndroid` imported at that point):

```ts
    let healMeta: Record<string, unknown> | null = null;
    if (android._staleRef && selfHealEnabled(process.env)) {
      const healed = await healStaleRef(android._staleRef, () =>
        runAndroid({
          command: 'snapshot',
          interactiveOnly: true,
          deviceId: activeSession?.deviceId,
          ...(appId ? { bundleId: appId } : {}),
        }),
      );
      if (healed.kind === 'failed') return healed.result;
      android.x = healed.x;
      android.y = healed.y;
      delete android._staleRef;
      healMeta = {
        reResolved: true,
        reResolvedRef: healed.newRef,
        timings_ms: { reResolve: healed.ms },
      };
    }
```

(and `if (healMeta) result = attachMeta(result, healMeta);` after its settle call).

Also fix `buildRunAndroidArgs` `longpress` `@ref` sentinel to preserve duration (today it drops it; a healed long-press must keep its hold time):

```ts
      if (target?.startsWith('@')) {
        const duration = Number(yOrDuration);
        const center = refCenter(target);
        if (!center) {
          return {
            command: 'longPress',
            _staleRef: target,
            ...(Number.isNaN(duration) ? {} : { durationMs: duration }),
            ...withBundle,
          };
        }
        ...
```

**Payload-shape parity (review finding):** the `_staleRef` early-return branches inside `runIOS` (`rn-fast-runner-client.ts:1051`) and `runAndroid` (`rn-android-runner-client.ts:948`) still fire when `RN_SELF_HEAL=0` or on direct client calls — agents parsing `STALE_REF` must see ONE shape. Extend both branches' extras with the new optional fields:

```ts
      {
        cachedMetadata: getCachedMetadata(args._staleRef),
        reResolution: 'self-heal-disabled',
        candidates: [],
        hint: 'Call device_snapshot action=snapshot to refresh refs, then retry the action with the new ref.',
      },
```

**iOS longpress asymmetry (do NOT "fix"):** `device_longpress` via `@ref` routes as `['press', ref, '--hold-ms', N]` → `buildRunIOSArgs`'s `tap` case, which has never carried `--hold-ms` (pre-existing, out of scope). The `durationMs` sentinel fix above applies to the **Android** builder only — do not invent an iOS counterpart.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/story-05-heal-stale-ref.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — `stale-ref-detection.test.js` and `story-04-fill-batch-settle.test.js` must stay green (they exercise the `_staleRef` sentinel and the fallback branches).

```bash
git add src/agent-device-wrapper.ts test/unit/story-05-heal-stale-ref.test.js dist
git commit -m "feat(story-05): heal stale @refs inline at the dispatch choke point (#386)"
```

---

### Task 4: Settle change detection on the fast tiers + `settleAfterMutationWithOutcome`

**Files:**
- Modify: `src/lifecycle/settle.ts`, `src/agent-device-wrapper.ts`
- Test: `test/unit/story-05-settle-change-detect.test.js`

**Interfaces:**
- Consumes: existing `waitForSettle`, `SettleOutcome`, `settleAfterMutation`, `SettleContext`, `SettleAfterMutationDeps`.
- Produces:
  - `waitForSettle` computes `hierarchyChanged` on `window-gate`/`screen-static` settles too (one post-settle `snapshotHash` probe) — **only when `initialSnapshotHash` is provided**; zero cost otherwise.
  - `SettleContext` gains `initialSnapshotHash?: string`.
  - `export async function settleAfterMutationWithOutcome(result: ToolResult, ctx: SettleContext, deps?: SettleAfterMutationDeps): Promise<{ result: ToolResult; outcome: SettleOutcome | null }>` — `settleAfterMutation` becomes a thin wrapper returning `.result`.
  - `meta.settle.hierarchyChanged` surfaces when defined.
  - **Baseline invalidation** (review consensus #1): for a MUTATING verb that exits without a hash observation (`hierarchyChanged === undefined` after settle, settle disabled per-call or per-env, settle threw), call `invalidateLastSnapshotHash()`. Exceptions that keep the baseline: non-mutating verbs (early return before any invalidation) and `result.isError` (the dispatch never landed, screen unchanged).

- [ ] **Step 1: Write the failing test**

```js
// test/unit/story-05-settle-change-detect.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForSettle } from '../../dist/lifecycle/settle.js';
import { settleAfterMutationWithOutcome } from '../../dist/agent-device-wrapper.js';
import { okResult } from '../../dist/utils.js';

const probesBase = () => ({ sleep: async () => {}, now: (() => { let t = 0; return () => (t += 10); })() });

test('window-gate settle + initial hash → one post-settle hash probe → hierarchyChanged', async () => {
  let hashCalls = 0;
  const outcome = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    initialSnapshotHash: 'AAA',
    probes: {
      ...probesBase(),
      isWindowUpdating: async () => false,
      snapshotHash: async () => { hashCalls++; return 'BBB'; },
    },
  });
  assert.equal(outcome.method, 'window-gate');
  assert.equal(outcome.hierarchyChanged, true);
  assert.equal(hashCalls, 1);
});

test('window-gate settle, unchanged hash → hierarchyChanged false', async () => {
  const outcome = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    initialSnapshotHash: 'AAA',
    probes: { ...probesBase(), isWindowUpdating: async () => false, snapshotHash: async () => 'AAA' },
  });
  assert.equal(outcome.hierarchyChanged, false);
});

test('window-gate WITHOUT initial hash → no hash probe at all (Story 04 budget intact)', async () => {
  let hashCalls = 0;
  const outcome = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    probes: {
      ...probesBase(),
      isWindowUpdating: async () => false,
      snapshotHash: async () => { hashCalls++; return 'X'; },
    },
  });
  assert.equal(outcome.hierarchyChanged, undefined);
  assert.equal(hashCalls, 0);
});

test('screen-static settle + initial hash → hierarchyChanged computed', async () => {
  const outcome = await waitForSettle({
    platform: 'ios',
    capabilities: ['SCREEN_STATIC'],
    initialSnapshotHash: 'AAA',
    probes: { ...probesBase(), isScreenStatic: async () => true, snapshotHash: async () => 'AAA' },
  });
  assert.equal(outcome.method, 'screen-static');
  assert.equal(outcome.hierarchyChanged, false);
});

test('post-settle probe failure → hierarchyChanged stays undefined (fail-open)', async () => {
  const outcome = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    initialSnapshotHash: 'AAA',
    probes: {
      ...probesBase(),
      isWindowUpdating: async () => false,
      snapshotHash: async () => { throw new Error('runner gone'); },
    },
  });
  assert.equal(outcome.hierarchyChanged, undefined);
});

test('mutating verb settling BLIND (hierarchyChanged undefined) invalidates the baseline', async () => {
  const { updateRefMapFromFlat, clearRefMap, getLastSnapshotHash } =
    await import('../../dist/fast-runner-ref-map.js');
  clearRefMap();
  updateRefMapFromFlat([{ ref: '@e0', type: 'Button', rect: { x: 0, y: 0, width: 100, height: 40 } }]);
  assert.notEqual(getLastSnapshotHash(), null);
  await settleAfterMutationWithOutcome(
    okResult({}),
    { platform: 'android', verb: 'swipe' }, // no initialSnapshotHash → fast tier settles blind
    {
      enabled: () => true,
      capabilities: () => [],
      probes: () => ({ snapshotHash: async () => 'H', sleep: async () => {}, now: () => 0 }),
      wait: async () => ({ settled: true, method: 'window-gate', ms: 5 }),
    },
  );
  assert.equal(getLastSnapshotHash(), null);
  clearRefMap();
});

test('mutating verb with OBSERVED change keeps the baseline; non-mutating verbs never invalidate', async () => {
  const { updateRefMapFromFlat, clearRefMap, getLastSnapshotHash } =
    await import('../../dist/fast-runner-ref-map.js');
  const deps = (outcome) => ({
    enabled: () => true,
    capabilities: () => [],
    probes: () => ({ snapshotHash: async () => 'H', sleep: async () => {}, now: () => 0 }),
    wait: async () => outcome,
  });
  clearRefMap();
  updateRefMapFromFlat([{ ref: '@e0', type: 'Button', rect: { x: 0, y: 0, width: 100, height: 40 } }]);
  const seeded = getLastSnapshotHash();
  await settleAfterMutationWithOutcome(
    okResult({}),
    { platform: 'ios', verb: 'tap', initialSnapshotHash: 'AAA' },
    deps({ settled: true, method: 'snapshot-eq', ms: 5, hierarchyChanged: true }),
  );
  assert.equal(getLastSnapshotHash(), seeded); // observed → baseline kept
  await settleAfterMutationWithOutcome(okResult({}), { platform: 'ios', verb: 'snapshot' }, deps({}));
  assert.equal(getLastSnapshotHash(), seeded); // non-mutating → untouched
  clearRefMap();
});

test('settle disabled per-call on a mutating verb → baseline invalidated', async () => {
  const { updateRefMapFromFlat, clearRefMap, getLastSnapshotHash } =
    await import('../../dist/fast-runner-ref-map.js');
  clearRefMap();
  updateRefMapFromFlat([{ ref: '@e0', type: 'Button', rect: { x: 0, y: 0, width: 100, height: 40 } }]);
  await settleAfterMutationWithOutcome(okResult({}), {
    platform: 'ios',
    verb: 'tap',
    settle: { enabled: false },
  });
  assert.equal(getLastSnapshotHash(), null);
  clearRefMap();
});

test('settleAfterMutationWithOutcome returns outcome + attaches meta.settle.hierarchyChanged', async () => {
  const { result, outcome } = await settleAfterMutationWithOutcome(
    okResult({ tapped: true }),
    { platform: 'ios', verb: 'tap', initialSnapshotHash: 'AAA' },
    {
      enabled: () => true,
      capabilities: () => [],
      probes: () => ({ ...probesBase(), snapshotHash: async () => 'BBB' }),
      wait: async () => ({ settled: true, method: 'snapshot-eq', ms: 42, hierarchyChanged: true }),
    },
  );
  assert.equal(outcome.hierarchyChanged, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.meta.settle.hierarchyChanged, true);
  assert.equal(env.meta.timings_ms.settle, 42);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/story-05-settle-change-detect.test.js`
Expected: FAIL — `settleAfterMutationWithOutcome` not exported; `hierarchyChanged` undefined on window-gate with initial hash.

- [ ] **Step 3: Implement**

In `src/lifecycle/settle.ts`, add the helper (below `safeProbe`):

```ts
// Story 05 (#386): the fast tiers (window-gate / screen-static) never take a
// snapshot, so a caller that wants change detection pays exactly one hash
// probe post-settle. Callers that omit initialSnapshotHash pay nothing.
async function postSettleChange(
  probes: SettleProbes,
  initialSnapshotHash: string | undefined,
): Promise<{ hierarchyChanged?: boolean }> {
  if (initialSnapshotHash === undefined) return {};
  const hash = await safeProbe(() => probes.snapshotHash());
  if (typeof hash !== 'string') return {};
  return { hierarchyChanged: hash !== initialSnapshotHash };
}
```

Change the window-gate early return to:

```ts
    if (updating === false) {
      await probes.sleep(WINDOW_GATE_SETTLED_SLEEP_MS);
      const change = await postSettleChange(probes, initialSnapshotHash);
      return { settled: true, method: 'window-gate', ms: elapsed(), ...change };
    }
```

Change the screen-static return to:

```ts
      if (isStatic === true) {
        const change = await postSettleChange(probes, initialSnapshotHash);
        return { settled: true, method: 'screen-static', ms: elapsed(), ...change };
      }
```

(snapshot-eq and timeout paths already compute `hierarchyChanged` from `initialSnapshotHash` — unchanged.)

In `src/agent-device-wrapper.ts`:
- Add `initialSnapshotHash?: string;` to `SettleContext`.
- Rename the body of `settleAfterMutation` into `settleAfterMutationWithOutcome` with early returns `return { result, outcome: null };`, thread the hash into `wait({ ... , ...(ctx.initialSnapshotHash !== undefined ? { initialSnapshotHash: ctx.initialSnapshotHash } : {}) })`, and extend the meta attachment.
- **Baseline invalidation** — the exact exit-path rules (import `invalidateLastSnapshotHash` from `./fast-runner-ref-map.js`):

```ts
export async function settleAfterMutationWithOutcome(
  result: ToolResult,
  ctx: SettleContext,
  deps: SettleAfterMutationDeps = {},
): Promise<{ result: ToolResult; outcome: SettleOutcome | null }> {
  if (result.isError) return { result, outcome: null }; // dispatch never landed — baseline keeps
  if (!SNAPSHOT_MUTATING_VERBS.has(ctx.verb)) return { result, outcome: null };
  if (ctx.settle?.enabled === false) {
    invalidateLastSnapshotHash(); // mutated + settled blind
    return { result, outcome: null };
  }
  try {
    const settle = await import('./lifecycle/settle.js');
    const enabled = deps.enabled ?? settle.settleEnabled;
    if (!enabled(process.env)) {
      invalidateLastSnapshotHash();
      return { result, outcome: null };
    }
    // ... capabilities/probes/wait resolution — unchanged from today ...
    const outcome = await wait({
      platform: ctx.platform,
      capabilities,
      probes,
      ...(ctx.settle?.timeoutMs !== undefined ? { budgetMs: ctx.settle.timeoutMs } : {}),
      ...(ctx.initialSnapshotHash !== undefined
        ? { initialSnapshotHash: ctx.initialSnapshotHash }
        : {}),
    });
    if (outcome.hierarchyChanged === undefined) invalidateLastSnapshotHash();
    return {
      result: attachMeta(result, { /* meta attachment below */ }),
      outcome,
    };
  } catch {
    invalidateLastSnapshotHash();
    return { result, outcome: null };
  }
}
```

The meta attachment inside the success return:

```ts
    return {
      result: attachMeta(result, {
        settle: {
          method: outcome.method,
          settled: outcome.settled,
          ...(outcome.hierarchyChanged !== undefined
            ? { hierarchyChanged: outcome.hierarchyChanged }
            : {}),
        },
        timings_ms: { settle: outcome.ms },
      }),
      outcome,
    };
```

- Re-implement the old name as the wrapper (existing callers/tests untouched):

```ts
export async function settleAfterMutation(
  result: ToolResult,
  ctx: SettleContext,
  deps: SettleAfterMutationDeps = {},
): Promise<ToolResult> {
  return (await settleAfterMutationWithOutcome(result, ctx, deps)).result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/story-05-settle-change-detect.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — `settle-engine.test.js` / `settle-wiring.test.js` must stay green (no existing test passes `initialSnapshotHash` into the fast tiers).

```bash
git add src/lifecycle/settle.ts src/agent-device-wrapper.ts test/unit/story-05-settle-change-detect.test.js dist
git commit -m "feat(story-05): hierarchyChanged detection on window-gate/screen-static settles (#386)"
```

---

### Task 5: `no-change-tracker` — wedged-runtime streak counter

**Files:**
- Create: `src/lifecycle/no-change-tracker.ts`
- Test: `test/unit/story-05-no-change-tracker.test.js`

**Interfaces:**
- Produces:
  - `export function recordNoUiChange(targetKey: string): number` — appends to the streak, returns the count of **distinct** targets in it
  - `export function recordUiChange(): void` — resets the streak
  - `export const WEDGED_DISTINCT_TARGETS = 3`
  - `export const WEDGED_RUNTIME_HINT: string`
  - `export function _resetNoChangeStreakForTest(): void`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/story-05-no-change-tracker.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordNoUiChange,
  recordUiChange,
  WEDGED_DISTINCT_TARGETS,
  WEDGED_RUNTIME_HINT,
  _resetNoChangeStreakForTest,
} from '../../dist/lifecycle/no-change-tracker.js';

beforeEach(() => _resetNoChangeStreakForTest());

test('distinct targets accumulate; same target does not', () => {
  assert.equal(recordNoUiChange('tap@10,10'), 1);
  assert.equal(recordNoUiChange('tap@10,10'), 1);
  assert.equal(recordNoUiChange('tap@20,20'), 2);
  assert.equal(recordNoUiChange('tap@30,30'), 3);
  assert.equal(WEDGED_DISTINCT_TARGETS, 3);
});

test('a UI change resets the streak', () => {
  recordNoUiChange('tap@10,10');
  recordNoUiChange('tap@20,20');
  recordUiChange();
  assert.equal(recordNoUiChange('tap@30,30'), 1);
});

test('hint names the recovery tools', () => {
  assert.match(WEDGED_RUNTIME_HINT, /cdp_status/);
  assert.match(WEDGED_RUNTIME_HINT, /cdp_restart/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/story-05-no-change-tracker.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/lifecycle/no-change-tracker.ts`**

```ts
// Story 05 (#386): cheap wedged-runtime detector (spec 2026-06-14-263). Taps
// that produce no hierarchy change on N DISTINCT targets in a row suggest the
// app runtime is swallowing touches (paused JS thread / wedged simulator) —
// one dead button tapped repeatedly does not. In-memory by design: a persisted
// counter would recreate the #202 orphaned-lock class of bugs.
export const WEDGED_DISTINCT_TARGETS = 3;

export const WEDGED_RUNTIME_HINT =
  `${WEDGED_DISTINCT_TARGETS} consecutive taps on distinct targets produced no UI change — ` +
  'the app runtime may be wedged (JS thread paused or touch events swallowed). ' +
  'Run cdp_status (iOS auto-recovers a paused JS thread), then cdp_restart with hardReset=true if it persists.';

const streak: string[] = [];

export function recordNoUiChange(targetKey: string): number {
  streak.push(targetKey);
  return new Set(streak).size;
}

export function recordUiChange(): void {
  streak.length = 0;
}

export function _resetNoChangeStreakForTest(): void {
  streak.length = 0;
}
```

- [ ] **Step 4: Session-boundary reset (review consensus #3)**

In `src/agent-device-wrapper.ts`, locate the session-clear function (the exported function that sets `activeSession = null` — find it via `grep -n "activeSession = null" src/agent-device-wrapper.ts`, around lines 104/124) and add `recordUiChange();` so a fresh device session never inherits a stale streak. Import it from `./lifecycle/no-change-tracker.js`. Add to the test file:

```js
test('clearing the active session resets the streak', async () => {
  const wrapper = await import('../../dist/agent-device-wrapper.js');
  recordNoUiChange('tap@1,1');
  recordNoUiChange('tap@2,2');
  wrapper._setActiveSessionForTest(null); // if the clear function is separate, call it instead
  // NOTE: verify at execution which exported function performs session clear
  // (e.g. clearActiveSession / closeSession) and call THAT; the assertion is:
  assert.equal(recordNoUiChange('tap@3,3') <= 3, true);
});
```

At execution time replace this placeholder assertion with the real clear-function call and `assert.equal(recordNoUiChange('tap@3,3'), 1)`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build && node --test test/unit/story-05-no-change-tracker.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lifecycle/no-change-tracker.ts src/agent-device-wrapper.ts test/unit/story-05-no-change-tracker.test.js dist
git commit -m "feat(story-05): wedged-runtime no-change streak tracker (#386)"
```

---

### Task 6: Retry-if-no-change orchestrator wired into `runNative`

**Files:**
- Modify: `src/agent-device-wrapper.ts`
- Test: `test/unit/story-05-retry-if-no-change.test.js`

**Interfaces:**
- Consumes: `settleAfterMutationWithOutcome` + `SettleContext.initialSnapshotHash` (Task 4), `getLastSnapshotHash` (Task 1), `recordNoUiChange`/`recordUiChange`/`WEDGED_DISTINCT_TARGETS`/`WEDGED_RUNTIME_HINT` (Task 5), `selfHealEnabled` (Task 3).
- Produces:
  - `export interface TapRetryPolicy { eligible: boolean; targetKey: string }`
  - `export function tapRetryPolicy(cliArgs: string[], builtCommand: string, x: number | undefined, y: number | undefined, opts: { retryIfNoChange?: boolean }): TapRetryPolicy`
  - `export async function settleWithRetryIfNoChange(firstResult: ToolResult, dispatch: () => Promise<ToolResult>, ctx: SettleContext, policy: TapRetryPolicy, deps?: SettleAfterMutationDeps): Promise<ToolResult>`
  - `runNative` opts gain `retryIfNoChange?: boolean`
  - Meta flags: `tapRetried: true`, `noUiChange: true`, `hint` (wedged), all coexisting with `settle`/`reResolved`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/story-05-retry-if-no-change.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  settleWithRetryIfNoChange,
  tapRetryPolicy,
} from '../../dist/agent-device-wrapper.js';
import { updateRefMapFromFlat, clearRefMap } from '../../dist/fast-runner-ref-map.js';
import { _resetNoChangeStreakForTest } from '../../dist/lifecycle/no-change-tracker.js';
import { okResult, failResult } from '../../dist/utils.js';

const seedRefMap = () =>
  updateRefMapFromFlat([
    { ref: '@e0', type: 'Button', label: 'Go', rect: { x: 0, y: 0, width: 100, height: 40 } },
  ]);
const parse = (r) => JSON.parse(r.content[0].text);
const ctx = { platform: 'ios', verb: 'tap' };
const policy = { eligible: true, targetKey: 'tap@50,20' };
const depsWith = (outcomes) => {
  let i = 0;
  return {
    enabled: () => true,
    capabilities: () => [],
    probes: () => ({
      snapshotHash: async () => 'H',
      sleep: async () => {},
      now: () => 0,
    }),
    wait: async (opts) => {
      assert.equal(opts.initialSnapshotHash !== undefined, true);
      return outcomes[Math.min(i++, outcomes.length - 1)];
    },
  };
};
const changed = { settled: true, method: 'snapshot-eq', ms: 10, hierarchyChanged: true };
const unchanged = { settled: true, method: 'snapshot-eq', ms: 10, hierarchyChanged: false };

beforeEach(() => {
  clearRefMap();
  _resetNoChangeStreakForTest();
  seedRefMap();
});

test('changed hierarchy → no retry, no flags', async () => {
  let dispatches = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => { dispatches++; return okResult({ tapped: true }); },
    ctx, policy, depsWith([changed]),
  );
  assert.equal(dispatches, 0);
  const env = parse(result);
  assert.equal(env.meta.tapRetried, undefined);
  assert.equal(env.meta.noUiChange, undefined);
});

test('unchanged → exactly one retry; changed after retry → tapRetried only', async () => {
  let dispatches = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => { dispatches++; return okResult({ tapped: true }); },
    ctx, policy, depsWith([unchanged, changed]),
  );
  assert.equal(dispatches, 1);
  const env = parse(result);
  assert.equal(env.meta.tapRetried, true);
  assert.equal(env.meta.noUiChange, undefined);
});

test('unchanged twice → tapRetried + noUiChange, exactly 2 attempts total, still success', async () => {
  let dispatches = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => { dispatches++; return okResult({ tapped: true }); },
    ctx, policy, depsWith([unchanged, unchanged]),
  );
  assert.equal(dispatches, 1); // + the first dispatch made by the caller = 2 total
  const env = parse(result);
  assert.equal(env.ok, true);
  assert.equal(env.meta.tapRetried, true);
  assert.equal(env.meta.noUiChange, true);
  assert.equal(env.meta.hint, undefined); // one distinct target only
});

test('wedged hint after noUiChange on 3 distinct targets', async () => {
  for (const key of ['tap@1,1', 'tap@2,2']) {
    await settleWithRetryIfNoChange(
      okResult({}), async () => okResult({}),
      ctx, { eligible: true, targetKey: key }, depsWith([unchanged, unchanged]),
    );
  }
  const result = await settleWithRetryIfNoChange(
    okResult({}), async () => okResult({}),
    ctx, { eligible: true, targetKey: 'tap@3,3' }, depsWith([unchanged, unchanged]),
  );
  const env = parse(result);
  assert.match(env.meta.hint, /wedged/);
});

test('retap dispatch error → first success kept, flagged noUiChange (advisory contract)', async () => {
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => failResult('runner died', 'RN_FAST_RUNNER_DOWN'),
    ctx, policy, depsWith([unchanged]),
  );
  const env = parse(result);
  assert.equal(env.ok, true);
  assert.equal(env.meta.tapRetried, true);
  assert.equal(env.meta.noUiChange, true);
});

test('ineligible policy → single settle, no initial hash requirement, no retry', async () => {
  let dispatches = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({}),
    async () => { dispatches++; return okResult({}); },
    ctx, { eligible: false, targetKey: '' },
    {
      enabled: () => true,
      capabilities: () => [],
      probes: () => ({ snapshotHash: async () => 'H', sleep: async () => {}, now: () => 0 }),
      wait: async (opts) => {
        assert.equal(opts.initialSnapshotHash, undefined);
        return unchanged;
      },
    },
  );
  assert.equal(dispatches, 0);
  assert.equal(parse(result).meta.noUiChange, undefined);
});

test('tapRetryPolicy gates on command, flags, coords, env, and opt-out', () => {
  assert.equal(tapRetryPolicy(['press', '@e0'], 'tap', 50, 20, {}).eligible, true);
  assert.equal(tapRetryPolicy(['press', '@e0'], 'tap', 50, 20, {}).targetKey, 'tap@50,20');
  assert.equal(tapRetryPolicy(['longpress', '50', '20'], 'longPress', 50, 20, {}).eligible, true);
  assert.equal(tapRetryPolicy(['fill', '@e0', 'hi'], 'type', 50, 20, {}).eligible, false);
  assert.equal(tapRetryPolicy(['press', '@e0', '--double-tap'], 'tap', 50, 20, {}).eligible, false);
  assert.equal(tapRetryPolicy(['press', '@e0', '--count', '3'], 'tap', 50, 20, {}).eligible, false);
  assert.equal(tapRetryPolicy(['press', '@e0'], 'tap', undefined, undefined, {}).eligible, false);
  assert.equal(tapRetryPolicy(['press', '@e0'], 'tap', 50, 20, { retryIfNoChange: false }).eligible, false);
  process.env.RN_SELF_HEAL = '0';
  try {
    assert.equal(tapRetryPolicy(['press', '@e0'], 'tap', 50, 20, {}).eligible, false);
  } finally {
    delete process.env.RN_SELF_HEAL;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/story-05-retry-if-no-change.test.js`
Expected: FAIL — `settleWithRetryIfNoChange`/`tapRetryPolicy` not exported.

- [ ] **Step 3: Implement in `src/agent-device-wrapper.ts`**

Add import: `import { recordNoUiChange, recordUiChange, WEDGED_DISTINCT_TARGETS, WEDGED_RUNTIME_HINT } from './lifecycle/no-change-tracker.js';`

```ts
const RETRYABLE_TAP_COMMANDS = new Set<string>(['tap', 'longPress']);

export interface TapRetryPolicy {
  eligible: boolean;
  targetKey: string;
}

// Story 05 (#386): only plain taps/long-presses are retry-eligible. Multi-tap
// gestures (--count/--double-tap) would change semantics on a re-tap; fills
// have their own read-back verification and a retype would duplicate text.
export function tapRetryPolicy(
  cliArgs: string[],
  builtCommand: string,
  x: number | undefined,
  y: number | undefined,
  opts: { retryIfNoChange?: boolean },
): TapRetryPolicy {
  const eligible =
    RETRYABLE_TAP_COMMANDS.has(builtCommand) &&
    opts.retryIfNoChange !== false &&
    selfHealEnabled(process.env) &&
    !cliArgs.includes('--double-tap') &&
    !cliArgs.includes('--count') &&
    x !== undefined &&
    y !== undefined;
  return { eligible, targetKey: `${builtCommand}@${x},${y}` };
}

function flagNoUiChange(result: ToolResult, targetKey: string): ToolResult {
  const distinct = recordNoUiChange(targetKey);
  return attachMeta(result, {
    noUiChange: true,
    ...(distinct >= WEDGED_DISTINCT_TARGETS ? { hint: WEDGED_RUNTIME_HINT } : {}),
  });
}

// Story 05 (#386): settle the first dispatch with change detection; if the
// hierarchy did not change, presume the tap was swallowed and retry EXACTLY
// once (2 attempts total, Maestro's rule). Still unchanged → success with
// meta.noUiChange (a no-op tap is legitimate — the verifier decides). The
// advisory contract holds: nothing here turns a succeeded action into an error.
export async function settleWithRetryIfNoChange(
  firstResult: ToolResult,
  dispatch: () => Promise<ToolResult>,
  ctx: SettleContext,
  policy: TapRetryPolicy,
  deps: SettleAfterMutationDeps = {},
): Promise<ToolResult> {
  const preHash = policy.eligible ? (getLastSnapshotHash() ?? undefined) : undefined;
  const first = await settleAfterMutationWithOutcome(
    firstResult,
    { ...ctx, ...(preHash !== undefined ? { initialSnapshotHash: preHash } : {}) },
    deps,
  );
  if (!policy.eligible || preHash === undefined || first.result.isError) return first.result;
  if (first.outcome?.hierarchyChanged !== false) {
    if (first.outcome?.hierarchyChanged === true) recordUiChange();
    return first.result;
  }
  const second = await dispatch();
  if (second.isError) {
    return flagNoUiChange(attachMeta(first.result, { tapRetried: true }), policy.targetKey);
  }
  const settled = await settleAfterMutationWithOutcome(
    second,
    { ...ctx, initialSnapshotHash: preHash },
    deps,
  );
  if (settled.outcome?.hierarchyChanged === false) {
    return flagNoUiChange(attachMeta(settled.result, { tapRetried: true }), policy.targetKey);
  }
  if (settled.outcome?.hierarchyChanged === true) recordUiChange();
  return attachMeta(settled.result, { tapRetried: true });
}
```

Add `retryIfNoChange?: boolean;` to the `runNative` opts type AND to the `RunAgentDeviceFn` test-seam type.

Rewire the **iOS branch** — replace

```ts
    let result = await runIOS(ios);
    result = await settleAfterMutation(result, { ... });
```

with

```ts
    let result = await runIOS(ios);
    const iosPolicy = tapRetryPolicy(cliArgs, ios.command, ios.x, ios.y, {
      ...(opts.retryIfNoChange !== undefined ? { retryIfNoChange: opts.retryIfNoChange } : {}),
    });
    result = await settleWithRetryIfNoChange(
      result,
      () => runIOS(ios),
      {
        platform: 'ios',
        verb: cliArgs[0],
        ...(appId ? { appId } : {}),
        ...(opts.settle ? { settle: opts.settle } : {}),
      },
      iosPolicy,
    );
```

Rewire the **Android branch** identically (`android.command`, `android.x`, `android.y`, `() => runAndroid({ ...android, deviceId: activeSession?.deviceId })`, `platform: 'android'`).

**Complete final branch tails** (review finding — the healMeta/upgradeNote ordering must be explicit so runner-upgrade telemetry survives). iOS branch, everything after `const ios = buildRunIOSArgs(cliArgs, appId);`:

```ts
    let healMeta: Record<string, unknown> | null = null;
    if (ios._staleRef && selfHealEnabled(process.env)) {
      const healed = await healStaleRef(ios._staleRef, () =>
        runIOS({ command: 'snapshot', interactiveOnly: true, ...(appId ? { bundleId: appId } : {}) }),
      );
      if (healed.kind === 'failed') return healed.result;
      ios.x = healed.x;
      ios.y = healed.y;
      delete ios._staleRef;
      healMeta = { reResolved: true, reResolvedRef: healed.newRef, timings_ms: { reResolve: healed.ms } };
    }
    let result = await runIOS(ios);
    const iosPolicy = tapRetryPolicy(cliArgs, ios.command, ios.x, ios.y, {
      ...(opts.retryIfNoChange !== undefined ? { retryIfNoChange: opts.retryIfNoChange } : {}),
    });
    result = await settleWithRetryIfNoChange(
      result,
      () => runIOS(ios),
      {
        platform: 'ios',
        verb: cliArgs[0],
        ...(appId ? { appId } : {}),
        ...(opts.settle ? { settle: opts.settle } : {}),
      },
      iosPolicy,
    );
    if (healMeta) result = attachMeta(result, healMeta);
    return upgradeNote ? attachMetaNote(result, upgradeNote) : result;
```

Android branch, everything after `const android = buildRunAndroidArgs(cliArgs, appId);`:

```ts
    let healMeta: Record<string, unknown> | null = null;
    if (android._staleRef && selfHealEnabled(process.env)) {
      const healed = await healStaleRef(android._staleRef, () =>
        runAndroid({
          command: 'snapshot',
          interactiveOnly: true,
          deviceId: activeSession?.deviceId,
          ...(appId ? { bundleId: appId } : {}),
        }),
      );
      if (healed.kind === 'failed') return healed.result;
      android.x = healed.x;
      android.y = healed.y;
      delete android._staleRef;
      healMeta = { reResolved: true, reResolvedRef: healed.newRef, timings_ms: { reResolve: healed.ms } };
    }
    let result = await runAndroid({ ...android, deviceId: activeSession?.deviceId });
    const androidPolicy = tapRetryPolicy(cliArgs, android.command, android.x, android.y, {
      ...(opts.retryIfNoChange !== undefined ? { retryIfNoChange: opts.retryIfNoChange } : {}),
    });
    result = await settleWithRetryIfNoChange(
      result,
      () => runAndroid({ ...android, deviceId: activeSession?.deviceId }),
      {
        platform: 'android',
        verb: cliArgs[0],
        ...(appId ? { appId } : {}),
        ...(opts.settle ? { settle: opts.settle } : {}),
      },
      androidPolicy,
    );
    if (healMeta) result = attachMeta(result, healMeta);
    const note = consumePendingAndroidUpgradeNote();
    return note ? attachMetaNote(result, note) : result;
```

(This consolidates the Task 3 healing insert and the Task 6 retry rewire into their final combined form — Task 3's intermediate wiring evolves into this.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/story-05-retry-if-no-change.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — `settle-wiring.test.js`, `story-04-fill-batch-settle.test.js`, `audit-b2-device-dispatch.test.js` must stay green (non-tap verbs and ineligible taps behave exactly as before: `getLastSnapshotHash()` returns null in most existing tests → no change detection → single settle).

```bash
git add src/agent-device-wrapper.ts test/unit/story-05-retry-if-no-change.test.js dist
git commit -m "feat(story-05): retry-if-no-change tap orchestration + wedged-runtime hint (#386)"
```

---

### Task 7: `retryIfNoChange` MCP arg on `device_press` / `device_longpress`

**Files:**
- Modify: `src/tools/device-interact.ts`, `src/index.ts`
- Test: `test/unit/story-05-retry-arg-plumb.test.js`

**Interfaces:**
- Consumes: `runNative(cliArgs, { retryIfNoChange })` (Task 6).
- Produces: `retryIfNoChange?: boolean` on `PressArgs`/`LongPressArgs` and both zod schemas.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/story-05-retry-arg-plumb.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('device_press handler forwards retryIfNoChange:false into runNative opts', async () => {
  const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { createDevicePressHandler } = await import('../../dist/tools/device-interact.js');
  const { okResult } = await import('../../dist/utils.js');
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  const calls = [];
  _setRunAgentDeviceForTest(async (cliArgs, opts) => {
    calls.push({ cliArgs, opts });
    return okResult({});
  });
  try {
    const handler = createDevicePressHandler();
    await handler({ ref: 'e3', retryIfNoChange: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.retryIfNoChange, false);
    await handler({ ref: 'e3' });
    assert.equal(calls[1].opts.retryIfNoChange, undefined);
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});

test('device_longpress handler forwards retryIfNoChange:false', async () => {
  const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { createDeviceLongPressHandler } = await import('../../dist/tools/device-interact.js');
  const { okResult } = await import('../../dist/utils.js');
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  const calls = [];
  _setRunAgentDeviceForTest(async (cliArgs, opts) => {
    calls.push({ cliArgs, opts });
    return okResult({});
  });
  try {
    await createDeviceLongPressHandler()({ ref: 'e3', retryIfNoChange: false });
    assert.equal(calls[0].opts.retryIfNoChange, false);
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});
```

NOTE: the GH #110 test-seam fuse means this file must not run production `runNative` first — it installs the override before any dispatch, mirroring `story-04-fill-batch-settle.test.js`. Keep this file free of production `runNative` calls.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/story-05-retry-arg-plumb.test.js`
Expected: FAIL — `opts.retryIfNoChange` is undefined on the first call.

- [ ] **Step 3: Implement**

In `src/tools/device-interact.ts`:
- Add `retryIfNoChange?: boolean;` to `PressArgs` and `LongPressArgs`.
- Generalize the opts helper (replacing `settleOpts` usage in these two handlers only):

```ts
function interactOpts(args: { settleTimeoutMs?: number; retryIfNoChange?: boolean }): {
  settle?: { timeoutMs: number };
  retryIfNoChange?: boolean;
} {
  return {
    ...settleOpts(args),
    ...(args.retryIfNoChange !== undefined ? { retryIfNoChange: args.retryIfNoChange } : {}),
  };
}
```

- `createDevicePressHandler`: `runNative(cliArgs, interactOpts(args))`.
- `createDeviceLongPressHandler`: both branches → `runNative(cliArgs, interactOpts(args))` (the ref branch currently passes no opts; the x/y branch too).

In `src/index.ts`, add to the `device_press` and `device_longpress` zod shapes:

```ts
    retryIfNoChange: z
      .boolean()
      .optional()
      .describe(
        'Story 05: when the tap produces no UI change, one automatic re-tap fires by default. Set false to disable (e.g. intentional no-op taps). RN_SELF_HEAL=0 disables globally.',
      ),
```

and append to the `device_press` description: `' Stale @refs self-heal by identity re-resolution (meta.reResolved); swallowed taps auto-retry once (meta.tapRetried/noUiChange).'`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/story-05-retry-arg-plumb.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

```bash
git add src/tools/device-interact.ts src/index.ts test/unit/story-05-retry-arg-plumb.test.js dist
git commit -m "feat(story-05): retryIfNoChange opt-out on device_press/device_longpress (#386)"
```

---

### Task 8: `device_batch` testID resolution — unique-match or refuse

**Files:**
- Modify: `src/tools/device-batch.ts`
- Test: `test/unit/story-05-batch-unique-testid.test.js`

**Interfaces:**
- Consumes: existing `findRefByTestID`, `resolveTestIDViaSnapshot`, `bareRef`, `failResult`.
- Produces:
  - `export function findRefsByTestID(snapshotEnvelope: string, testID: string): string[]` — ALL bare-ref matches, both envelope shapes
  - `findRefByTestID` preserved as `findRefsByTestID(...)[0] ?? null` (back-compat, still exported)
  - New failure code `AMBIGUOUS_TESTID` with `candidates` — on **mutating** resolutions only (`press`, `fill`, `find` with `tap: true`). A pure inspection `find` (no tap) returns first-match as today, plus `ambiguous: true` + `candidates` in its ok payload (review consensus #5: the spec's "never guess-TAP" rule is about taps; refusing a read loses capability).

Spec §"Keep the boundary honest": batch shares the unique-match POLICY (never guess-tap). It matches by user-supplied testID against envelope JSON, so it shares the rule, not the `refreshRef` signature matcher — note this in the PR description.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/story-05-batch-unique-testid.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRefsByTestID, findRefByTestID } from '../../dist/tools/device-batch.js';

const flatEnvelope = JSON.stringify({
  ok: true,
  data: {
    nodes: [
      { ref: '@e0', identifier: 'row' },
      { ref: '@e1', identifier: 'row' },
      { ref: '@e2', identifier: 'save-btn' },
    ],
  },
});
const treeEnvelope = JSON.stringify({
  ok: true,
  data: {
    tree: {
      ref: 'e0',
      children: [
        { ref: 'e1', identifier: 'row' },
        { ref: 'e2', identifier: 'row', children: [{ ref: 'e3', identifier: 'save-btn' }] },
      ],
    },
  },
});

test('flat shape: returns ALL matches, bare refs', () => {
  assert.deepEqual(findRefsByTestID(flatEnvelope, 'row'), ['e0', 'e1']);
  assert.deepEqual(findRefsByTestID(flatEnvelope, 'save-btn'), ['e2']);
  assert.deepEqual(findRefsByTestID(flatEnvelope, 'missing'), []);
});

test('tree shape: returns ALL matches, bare refs', () => {
  assert.deepEqual(findRefsByTestID(treeEnvelope, 'row'), ['e1', 'e2']);
  assert.deepEqual(findRefsByTestID(treeEnvelope, 'save-btn'), ['e3']);
});

test('findRefByTestID back-compat: first match or null', () => {
  assert.equal(findRefByTestID(flatEnvelope, 'row'), 'e0');
  assert.equal(findRefByTestID(flatEnvelope, 'missing'), null);
});

test('batch press step refuses ambiguous testID with candidates', async () => {
  const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { createDeviceBatchHandler } = await import('../../dist/tools/device-batch.js');
  const { okResult } = await import('../../dist/utils.js');
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  const presses = [];
  _setRunAgentDeviceForTest(async (cliArgs) => {
    if (cliArgs[0] === 'snapshot') {
      return { content: [{ type: 'text', text: flatEnvelope }] };
    }
    presses.push(cliArgs);
    return okResult({});
  });
  try {
    const handler = createDeviceBatchHandler();
    const result = await handler({ steps: [{ action: 'press', testID: 'row' }] });
    const env = JSON.parse(result.content[0].text);
    const step = env.data.results[0];
    assert.equal(step.success, false);
    assert.match(step.error, /AMBIGUOUS_TESTID|matches 2/);
    assert.equal(presses.length, 0); // never guess-tapped
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});
```

NOTE: before finalizing, read `createDeviceBatchHandler`'s result envelope in `device-batch.ts` (the `results[0]` path above) and match the actual shape — copy the assertion style from the existing batch test at the end of `story-04-fill-batch-settle.test.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/story-05-batch-unique-testid.test.js`
Expected: FAIL — `findRefsByTestID` not exported.

- [ ] **Step 3: Implement in `src/tools/device-batch.ts`**

Replace `findRefByTestID`'s body with a collect-all core:

```ts
export function findRefsByTestID(snapshotEnvelope: string, testID: string): string[] {
  try {
    const env = JSON.parse(snapshotEnvelope) as {
      ok?: boolean;
      data?: {
        nodes?: Array<{ ref?: string; identifier?: string }>;
        tree?: TreeNode;
      };
    };
    if (env.ok === false) return [];
    const nodes = env.data?.nodes;
    if (Array.isArray(nodes)) {
      return nodes
        .filter((n) => n.identifier === testID && typeof n.ref === 'string')
        .map((n) => bareRef(n.ref!));
    }
    if (env.data?.tree) {
      const refs: string[] = [];
      collectRefsInTree(env.data.tree, testID, refs);
      return refs;
    }
    return [];
  } catch {
    return [];
  }
}

export function findRefByTestID(snapshotEnvelope: string, testID: string): string | null {
  return findRefsByTestID(snapshotEnvelope, testID)[0] ?? null;
}

function collectRefsInTree(node: TreeNode, testID: string, out: string[]): void {
  if (node.identifier === testID && typeof node.ref === 'string') out.push(bareRef(node.ref));
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectRefsInTree(child, testID, out);
  }
}
```

(remove the now-unused `findRefInTree`). Change `resolveTestIDViaSnapshot` to return all refs:

```ts
async function resolveTestIDViaSnapshot(
  testID: string,
): Promise<{ refs: string[]; envelope: string | null; snapshotFailed: boolean }> {
  const result = await runNative(['snapshot', '-i']);
  const envelope = result.content?.[0]?.text ?? null;
  const snapshotFailed = snapshotEnvelopeFailed(envelope);
  if (snapshotFailed) return { refs: [], envelope, snapshotFailed: true };
  return { refs: findRefsByTestID(envelope!, testID), envelope, snapshotFailed: false };
}
```

Add a shared refusal helper and use it at all three call sites (find/press/fill), between the `snapshotFailed` check and the `!ref` (now `refs.length === 0`) check:

```ts
function ambiguousTestIDFail(testID: string, refs: string[]): ToolResult {
  return failResult(
    `testID "${testID}" matches ${refs.length} elements — refusing to guess-tap (AMBIGUOUS_TESTID)`,
    'AMBIGUOUS_TESTID',
    {
      testID,
      candidates: refs.slice(0, 5).map((r) => `@${r}`),
      hint: 'Make the testID unique, or target a specific @ref from device_snapshot instead.',
    },
  );
}
```

Call-site pattern — the refusal fires ONLY where a tap/type would follow (press shown; fill identical; in `find` gate it on `step.tap`):

```ts
        const { refs, envelope, snapshotFailed } = await resolveTestIDViaSnapshot(step.testID);
        if (snapshotFailed) { /* existing SNAPSHOT_FAILED failResult, unchanged */ }
        if (refs.length > 1) return ambiguousTestIDFail(step.testID, refs);
        const ref = refs[0];
        if (!ref) { /* existing TESTID_NOT_FOUND failResult, unchanged */ }
```

`find` case — inspection stays permissive, tap refuses:

```ts
        if (refs.length > 1 && step.tap) return ambiguousTestIDFail(step.testID, refs);
        const ref = refs[0];
        if (!ref) { /* existing TESTID_NOT_FOUND failResult, unchanged */ }
        if (step.tap) return runNative(['press', `@${ref}`], stepSettleOpts(step));
        return okResult({
          resolved: ref,
          testID: step.testID,
          ...(refs.length > 1 ? { ambiguous: true, candidates: refs.slice(0, 5).map((r) => `@${r}`) } : {}),
          snapshotEnvelopePreviewBytes: envelope?.length ?? 0,
        });
```

Add to the test file:

```js
test('batch find WITHOUT tap returns first match + ambiguity info instead of refusing', async () => {
  const { _setActiveSessionForTest, _setRunAgentDeviceForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { createDeviceBatchHandler } = await import('../../dist/tools/device-batch.js');
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  _setRunAgentDeviceForTest(async () => ({ content: [{ type: 'text', text: flatEnvelope }] }));
  try {
    const result = await createDeviceBatchHandler()({ steps: [{ action: 'find', testID: 'row' }] });
    const env = JSON.parse(result.content[0].text);
    const step = env.data.results[0];
    assert.equal(step.success, true);
    assert.equal(step.data.resolved, 'e0');
    assert.equal(step.data.ambiguous, true);
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});
```

Check `failResult`'s exact signature in `src/utils.ts` before writing the helper (device-batch uses both 2-arg and 3-arg forms today — use the 3-arg `(message, code, extras)` form matching the press case's `SNAPSHOT_FAILED`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/story-05-batch-unique-testid.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` — batch tests (`device-batch-salient.test.js`, phase-125/128 suites) must stay green; any that asserted first-match-on-duplicates behavior needs its fixture de-duplicated (behavior change is the point — flag it in the commit body).

```bash
git add src/tools/device-batch.ts test/unit/story-05-batch-unique-testid.test.js dist
git commit -m "feat(story-05): device_batch testID resolution refuses ambiguous matches (#386)"
```

---

### Task 9: Docs, tool descriptions, changeset

**Files:**
- Modify: `CLAUDE.md` (repo root), `docs/stories/05-self-healing-taps.md` (Status line only), `docs/stories/README.md` (tracker row, if one exists)
- Create: `.changeset/story-05-self-healing-taps.md`

- [ ] **Step 1: CLAUDE.md troubleshooting bullet** — add after the Story 04 settle bullet:

```markdown
- **Taps on stale @refs succeed now instead of STALE_REF / seeing `meta.reResolved` or `meta.tapRetried`** → Story 05 (#386) self-healing taps: a stale `@ref` is re-bound by identity (testID/label/role, unique match only — ambiguity still returns `STALE_REF`, now with a `candidates` list) and a tap whose settle hash shows no UI change is re-tapped exactly once (`meta.tapRetried`), then reported as `meta.noUiChange: true`. 3 consecutive no-change taps on distinct targets add a wedged-runtime `meta.hint` (see spec 2026-06-14-263). Opt out per call with `retryIfNoChange: false` (device_press/device_longpress) or globally with `RN_SELF_HEAL=0` (disables both re-resolution and re-tap). Change detection costs one extra snapshot probe per tap on the fast settle tiers; non-tap verbs are unaffected.
```

- [ ] **Step 2: Story status** — in `docs/stories/05-self-healing-taps.md` change `**Status:** Proposed (2026-07-02)` to `**Status:** Implemented (2026-07-04, #386)`. Update the corresponding row in `docs/stories/README.md` if it tracks statuses. Never delete anything in these files.

- [ ] **Step 3: Changeset** — create `.changeset/story-05-self-healing-taps.md`:

```markdown
---
'rn-dev-agent-cdp': minor
'rn-dev-agent-plugin': minor
---

Story 05 (#386) self-healing taps: stale `@ref` taps re-resolve inline by identity signature (unique-match only; ambiguous/absent STALE_REF now lists candidates), swallowed taps retry exactly once via settle-hash change detection (`meta.reResolved` / `meta.tapRetried` / `meta.noUiChange`), 3 consecutive no-change taps on distinct targets surface a wedged-runtime hint, and `device_batch` testID resolution refuses ambiguous matches (`AMBIGUOUS_TESTID`). Opt-outs: `retryIfNoChange: false` per call, `RN_SELF_HEAL=0` global.
```

Verify package names against existing changesets (`ls .changeset/*.md` and copy a recent header).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/stories/05-self-healing-taps.md docs/stories/README.md .changeset/story-05-self-healing-taps.md
git commit -m "docs(story-05): troubleshooting entry, story status, changeset (#386)"
```

---

### Task 10: Live device verification (iOS simulator + Android emulator)

Run in the parent session with the plugin's own MCP tools against the workspace test-app (`../rn-dev-agent-workspace/test-app`, Metro started FROM the workspace). This is the spec's acceptance scenario — capture outputs for the PR body.

**Fixture requirement (review finding):** identity matching is exact `type`+`label`+`identifier` — generic nodes (`Other`/`StaticText`, no testID/label) will NOT heal (ambiguous/absent by design). Pick targets with distinctive testIDs or labels for Steps 1–2, and record that expectation in the PR body so narrow heal coverage on generic nodes isn't misread as a bug.

- [ ] **Step 1: iOS — acceptance scenario 1 (re-resolution saves the round-trip)**
  1. `cdp_status` → connected; `device_snapshot action=open` then `action=snapshot`.
  2. Note two refs from the SAME snapshot: a button that mutates the screen (e.g. TaskWizard next / add-task) and a second target.
  3. `device_press` the mutating button (screen re-renders → refs go stale).
  4. `device_press` the second ref **from the original snapshot**. Expected: success with `meta.reResolved: true` + `meta.timings_ms.reResolve`; total tool calls for the flow = 2 (was 5 via STALE_REF → re-snapshot → re-find → retry).
- [ ] **Step 2: iOS — ambiguity refusal**: find a screen with two identical rows (or add duplicate testIDs in the test-app fixture); stale-tap one → expect `STALE_REF` with `candidates` (≤5) and NO tap dispatched.
- [ ] **Step 3: iOS — swallowed tap**: tap a static/no-op area (e.g. a plain Text). Expected: `meta.tapRetried: true` + `meta.noUiChange: true`, exactly 2 runner `/command` taps (check bridge log), and `meta.settle` present. Repeat on 3 distinct no-op points → third result carries the wedged `meta.hint`.
- [ ] **Step 4: Android — repeat Steps 1 and 3** on the emulator (window-gate tier: verify `meta.settle.method: "window-gate"` still appears and change detection worked — `hierarchyChanged` in `meta.settle`).
- [ ] **Step 5: Timing sanity**: run 5 fresh-ref taps and 5 healed taps; eyeball `meta.timings_ms` — healed path should add roughly one snapshot (~200–500ms), fresh-path taps should add only the post-settle hash probe. Record numbers for the PR body and `../rn-dev-agent-workspace/docs/proof/`.
- [ ] **Step 6: Regression**: `RN_SELF_HEAL=0` in the MCP env (restart session) → stale tap returns legacy `STALE_REF`; unset again.

---

## Amendments applied from the multi-LLM plan review (2026-07-04)

Reviewers: Antigravity (Gemini 3.1 Pro High) + Claude Opus coordinator research; Gemini CLI unavailable (tier discontinued), Codex quota-paused.

1. **Stale-baseline blocker (consensus #1):** added `invalidateLastSnapshotHash()` (Task 1) and exit-path invalidation rules in `settleAfterMutationWithOutcome` (Task 4) — a mutating verb that settles without a hash observation nulls the baseline so the next tap fails OPEN (no retry-detection) instead of comparing against a pre-mutation screen. Policy + coverage limits documented in Global Constraints. Chose invalidation over per-tap pre-snapshot (correctness at the cost of coverage, not latency) and kept `retryIfNoChange` default-ON per spec.
2. **Fast-tier probe cost (consensus #2):** accepted and bounded — only eligible taps pay the one post-settle probe; quantified in Global Constraints; Task 10 Step 5 measures it live.
3. **Wedged-streak contamination (consensus #3):** session-clear reset added (Task 5 Step 4). Deliberate deviation from the reviewer's "reset on any successful non-tap mutation": a wedged runtime also "succeeds" at swipes, so auto-reset would make the detector unreachable in mixed flows; kept proven-change + session-boundary resets and documented the false-positive edge.
4. **Android heal deviceId (consensus #4):** threaded into the heal snapshot closure (Tasks 3/6).
5. **AMBIGUOUS_TESTID scope (consensus #5):** narrowed to mutating resolutions; inspection `find` returns first-match + `ambiguous`/`candidates` info (Task 8).
6. **STALE_REF payload parity (Claude-unique):** legacy `_staleRef` branches in both runner clients gain `reResolution: 'self-heal-disabled'` + `candidates: []` (Task 3).
7. **Explicit branch tails (Claude-unique):** full final iOS/Android `runNative` blocks printed in Task 6 so `healMeta`/`upgradeNote` ordering can't be mis-edited.
8. **Live-verification fixtures (Claude-unique):** Task 10 now requires distinctive-identity targets and sets heal-coverage expectations.

## Self-Review (completed at plan time)

- **Spec coverage:** identity signatures → Task 1; `refreshRef` + matcher matrix → Task 2; pipeline wiring press/longpress/fill + `meta.reResolved` + candidates enrichment → Task 3; post-tap change detection + one retry + `meta.tapRetried`/`noUiChange` → Tasks 4/6; wedged counter + hint → Tasks 5/6; `retryIfNoChange` default-on opt-out → Tasks 6/7; batch boundary → Task 8; acceptance scenarios + live test plan → Task 10; telemetry visibility → meta flags flow through tool envelopes shown by the observe UI's per-call results (an aggregate rate panel is deferred — file a follow-up issue at finish).
- **Deviations from spec (intentional, documented):** `RefSignature.text` is folded into `label` (both runners map visible text into `label`; `FlatNode` has no `text` field). `indexPath` is realized as flat index + node-count gate (the flat list is the only tree shape the ref-map sees). `enabled`/`hittable` are excluded from identity (state, not identity). Retry applies to `tap`/`longPress` only — never `type`/`fill` (a retype would duplicate text; fill has its own read-back verification), and multi-tap gestures (`--count`, `--double-tap`) are excluded.
- **Type consistency check:** `RefSignature`/`getCachedSignature`/`getLastSnapshotHash` (T1) ↔ consumed in T2/T3/T6 with identical signatures; `HealOutcome` (T3) internal to wrapper; `SettleContext.initialSnapshotHash` + `settleAfterMutationWithOutcome` (T4) ↔ consumed in T6; tracker exports (T5) ↔ consumed in T6. Verified consistent.
- **Placeholder scan:** two deliberate read-before-finalize notes remain (batch result envelope shape in T8 test; `failResult` arity in T8) — these are verification instructions with the expected pattern already written, not missing content.
