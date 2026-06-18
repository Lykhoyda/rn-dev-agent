# E2E Regression Runner — Engine (Plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the headless engine for E2E regression testing: promote a verified action into a frozen **locked e2e test**, then run all locked tests **strict** (no auto-repair) on the booted simulator and persist a suite-run report — all driven by two new MCP tools (`cdp_lock_e2e_test`, `cdp_run_e2e_suite`).

**Architecture:** Approach C from the spec — a thin orchestrator that reuses the hardened `maestro_run` handler as its inner loop. New `domain/e2e-*.ts` types/persistence mirror the existing `reusable-action`/`action-store` conventions. The two tools are added to `FLOW_TOOLS` so the arbiter grants exactly one exclusive `flow` lease per call; all orchestration lives in lease-free *core* functions (so Plan 2's HTTP endpoint can reuse them). v1 runs on the already-booted dev sim (no isolation) and reloads JS from Metro via `cdp_reload` instead of rebuilding natively.

**Tech Stack:** TypeScript (ESM, Node16 module resolution, strict), `node:test` + `node:assert/strict`, `node:crypto`, `node:child_process`. Reuses `maestro_run`, `device-arbiter`, `reusable-action`, `action-store`, `maestro-error-parser`.

**Spec:** `docs/superpowers/specs/2026-06-18-e2e-regression-runner-design.md`

## Amendments applied from the multi-LLM plan review (Codex + Claude, 2026-06-18)

The first plan draft was reviewed before any code (per the repo's "review the plan with other LLMs" step). Gemini failed to respond this run; Codex + Claude converged with source-verified findings. Six blockers + should-fixes are folded in below:

1. **Frozen lock was non-executable (BLOCKER).** `loadAction().body` returns only the step lines — `splitYaml` (`action-store.ts:67`) excludes the pre-`---` `appId:` top section. Fix: **freeze the raw action file verbatim** (`readFileSync(action.filePath)`), not `action.body`, and separate lock metadata from the flow with an explicit sentinel line. The Task 7 fixture is now a realistic `appId:`/`---`/`#header`/steps action.
2. **Locked-test parser fragility (BLOCKER).** `lastIndexOf('\n#')` mis-splits when the flow body contains `#` comments. Fix: split on the sentinel `# e2e-locked-flow-below`.
3. **Parser test fixtures classified as UNKNOWN (BLOCKER).** Real `parseMaestroFailure` (`maestro-error-parser.ts:52-95`) requires **quoted** selectors (`id='X'`). Fixtures now use real Maestro output strings.
4. **Production wiring gap (BLOCKER).** The shipped tool never probed Metro/app/UDID nor reloaded. Fix: Task 9 registers the handler with **real `preflightCheck` + `runReload` defaults built in `index.ts`** (where the module-private `getClient`/`setClient`/`createClient` live).
5. **TypeScript blockers.** New error codes weren't in `ToolErrorCode`; `SessionState` was imported from the wrong module. Fix: extend `ToolErrorCode` (Task 7 step 1); import `SessionState` from `../types.js`.
6. **Params (BLOCKER vs spec).** v1 has no params source, so **lock refuses param-needing actions** (`PARAMS_UNSUPPORTED`) and the suite **skips** any it encounters — never sends empty `-e KEY=`, never counts a param-gap as a regression.
7. **Should-fixes folded in:** empty suite → `warnResult` (no false-green record); single-slot request written **before** the preflight `await` + `updatedAt`-staleness in `isRunActive` (PID-reuse can't wedge it); discover `.yaml` only; reload failure → warn, not crash; honor `requested → running` + per-test progress; startup recovery runs in `main()` (worker), not the supervisor; `/lock-e2e` frontmatter mirrors `run-action.md`.

## Global Constraints

- **Node >= 22 LTS.** TypeScript `strict`. ESM with explicit `.js` import extensions. `import type { ... }` for type-only imports. No unnecessary comments. Single-quote style (oxfmt).
- **Tests live at `scripts/cdp-bridge/test/unit/<name>.test.js`** (top-level only — CI glob `test/unit/*.test.js` is non-recursive, B217). Framework: `node:test` + `node:assert/strict`. Import code-under-test from **`../../dist/<path>.js`** (compiled), never `src/`.
- **Build before test:** `npm run build` (tsc) compiles `src/ → dist/`. `dist/` is tracked and must be rebuilt + committed.
- **Commands** (from `scripts/cdp-bridge/`): full = `npm test`; single = `npm run build && node --test 'test/unit/<name>.test.js'`.
- **Changeset:** package `rn-dev-agent-cdp`; `.changeset/<slug>.md` (`minor`).
- **Path safety:** any id → path passes `assertValidActionId(id, ctx)` + `assertWithinDir(file, baseDir)` (`domain/path-safety.js`).
- **projectRoot** threaded explicitly; fallback `findProjectRoot()` (`nav-graph/storage.js`) then `process.cwd()`.
- **Lease rule:** flow-running tools go in `FLOW_TOOLS`; *core* functions never lease and call `createMaestroRunHandler()` directly.
- **MCP results** use `okResult`/`failResult`/`warnResult` from `utils.js`. `failResult`'s code arg is typed `ToolErrorCode` — new codes must be added to that union (Task 7).
- **v1 scope:** strict-on-booted, no isolation, no native rebuild, no HTTP endpoint/web page (Plan 2), param-free locked tests only.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/domain/e2e-test.ts` | `LockedE2eTest`; serialize/parse the frozen file (sentinel split); path helpers; freeze (raw flow) / load / discover |
| `src/domain/e2e-run.ts` | `E2eRunRecord` + result types; `classifyFlowResult`; `computeVerdict`; `diffNewlyFailing`; record + index persistence; `lastGreenRunId` |
| `src/domain/e2e-run-request.ts` | Durable run-request + status state machine; `recoverInterruptedRequests` |
| `src/e2e/git-info.ts` | `getGitInfo()` (injectable exec) |
| `src/e2e/preflight.ts` | `preflight()` gate + `probeMetro()` |
| `src/tools/lock-e2e-test.ts` | `lockE2eTestCore` + `createLockE2eTestHandler` |
| `src/tools/run-e2e-suite.ts` | `runE2eSuiteCore` + `createRunE2eSuiteHandler` |
| `src/index.ts` (modify) | extend `ToolErrorCode` callers; register both tools with real preflight/reload deps; startup interrupted-recovery |
| `src/types.ts` (modify) | extend `ToolErrorCode` union |
| `src/lifecycle/device-arbiter.ts` (modify) | add both tool names to `FLOW_TOOLS` |
| `commands/lock-e2e.md` | `/lock-e2e <action>` command |
| `.gitignore` (modify) | ignore `.rn-agent/state/e2e-runs/`; keep `.rn-agent/e2e/` tracked |

---

## Task 1: Locked-test serialization + path helpers (pure)

**Files:**
- Create: `scripts/cdp-bridge/src/domain/e2e-test.ts`
- Test: `scripts/cdp-bridge/test/unit/e2e-test-serialize.test.js`

**Interfaces:**
- Produces: `interface LockedE2eTest { id: string; intent: string; sourceActionId: string; lockedAt: string; lockedGitSha: string | null; sourceContentHash: string; status: 'locked'; params?: string[]; appId?: string; flow: string; filePath: string }`
- Produces: `serializeLockedTest(meta: Omit<LockedE2eTest,'filePath'>): string` (lock-comment header + `# e2e-locked-flow-below` sentinel + `flow`); `parseLockedTest(text: string, filePath: string): LockedE2eTest | null` (split on sentinel); `e2eDirFor(projectRoot): string`; `e2ePathFor(projectRoot, id): string`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/e2e-test-serialize.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeLockedTest, parseLockedTest, e2ePathFor } from '../../dist/domain/e2e-test.js';

const META = {
  id: 'add-to-cart',
  intent: 'Add a product to the cart',
  sourceActionId: 'add-to-cart',
  lockedAt: '2026-06-18T10:00:00.000Z',
  lockedGitSha: 'abc1234',
  sourceContentHash: 'deadbeef',
  status: 'locked',
  params: undefined,
  appId: 'com.example.shop',
  // a realistic flow: appId top section, separator, M7 comments, AND a '#' comment in the body
  flow: 'appId: com.example.shop\n---\n# id: add-to-cart\n- launchApp\n# tap the add button\n- tapOn: "Add"\n',
};

test('serialize → parse round-trips lock fields and preserves the full executable flow', () => {
  const text = serializeLockedTest(META);
  const parsed = parseLockedTest(text, '/x/.rn-agent/e2e/add-to-cart.yaml');
  assert.equal(parsed.id, 'add-to-cart');
  assert.equal(parsed.sourceActionId, 'add-to-cart');
  assert.equal(parsed.lockedGitSha, 'abc1234');
  assert.equal(parsed.sourceContentHash, 'deadbeef');
  assert.equal(parsed.appId, 'com.example.shop');
  assert.equal(parsed.filePath, '/x/.rn-agent/e2e/add-to-cart.yaml');
  // BLOCKER-1: flow must still contain the executable appId header + separator
  assert.match(parsed.flow, /^appId: com\.example\.shop$/m);
  assert.match(parsed.flow, /^---$/m);
  // BLOCKER-4: a '#' comment INSIDE the body must not corrupt the split
  assert.match(parsed.flow, /# tap the add button/);
  assert.match(parsed.flow, /tapOn: "Add"/);
});

test('parseLockedTest returns null when the lock header is missing', () => {
  assert.equal(parseLockedTest('appId: com.x\n---\n- launchApp\n', '/x/y.yaml'), null);
});

test('e2ePathFor rejects path traversal', () => {
  assert.throws(() => e2ePathFor('/proj', '../escape'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/e2e-test-serialize.test.js'`
Expected: FAIL — `Cannot find module '../../dist/domain/e2e-test.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/domain/e2e-test.ts
import { join } from 'node:path';
import { assertValidActionId, assertWithinDir } from './path-safety.js';

export interface LockedE2eTest {
  id: string;
  intent: string;
  sourceActionId: string;
  lockedAt: string;
  lockedGitSha: string | null;
  sourceContentHash: string;
  status: 'locked';
  params?: string[];
  appId?: string;
  flow: string;
  filePath: string;
}

const FLOW_SENTINEL = '# e2e-locked-flow-below';

export function e2eDirFor(projectRoot: string): string {
  return join(projectRoot, '.rn-agent', 'e2e');
}

export function e2ePathFor(projectRoot: string, id: string): string {
  assertValidActionId(id, 'e2ePathFor');
  const dir = e2eDirFor(projectRoot);
  const file = join(dir, `${id}.yaml`);
  assertWithinDir(file, dir);
  return file;
}

export function serializeLockedTest(meta: Omit<LockedE2eTest, 'filePath'>): string {
  const header = [
    '# e2e-locked-test: true',
    `# id: ${meta.id}`,
    `# intent: ${meta.intent}`,
    `# sourceActionId: ${meta.sourceActionId}`,
    `# lockedAt: ${meta.lockedAt}`,
    `# lockedGitSha: ${meta.lockedGitSha ?? ''}`,
    `# sourceContentHash: ${meta.sourceContentHash}`,
    '# status: locked',
  ];
  if (meta.appId) header.push(`# appId: ${meta.appId}`);
  if (meta.params?.length) header.push(`# params: ${meta.params.join(', ')}`);
  header.push(FLOW_SENTINEL);
  return `${header.join('\n')}\n${meta.flow}`;
}

export function parseLockedTest(text: string, filePath: string): LockedE2eTest | null {
  if (!/^#\s*e2e-locked-test:\s*true\s*$/m.test(text)) return null;
  const sentinelIdx = text.indexOf(FLOW_SENTINEL);
  if (sentinelIdx < 0) return null;
  const headerText = text.slice(0, sentinelIdx);
  const flowStart = text.indexOf('\n', sentinelIdx);
  const flow = flowStart >= 0 ? text.slice(flowStart + 1) : '';
  const field = (k: string): string | undefined => {
    const m = headerText.match(new RegExp(`^#\\s*${k}:\\s*(.*)$`, 'm'));
    const v = m?.[1]?.trim();
    return v ? v : undefined;
  };
  const id = field('id');
  const intent = field('intent');
  if (!id || !intent) return null;
  const paramsRaw = field('params');
  return {
    id,
    intent,
    sourceActionId: field('sourceActionId') ?? id,
    lockedAt: field('lockedAt') ?? '',
    lockedGitSha: field('lockedGitSha') ?? null,
    sourceContentHash: field('sourceContentHash') ?? '',
    status: 'locked',
    params: paramsRaw ? paramsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    appId: field('appId'),
    flow,
    filePath,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/e2e-test-serialize.test.js'`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/e2e-test.ts scripts/cdp-bridge/dist/domain/e2e-test.js scripts/cdp-bridge/test/unit/e2e-test-serialize.test.js
git commit -m "feat(e2e): locked-test serialize/parse (sentinel split) + path helpers"
```

---

## Task 2: Locked-test freeze (raw flow) / load / discover IO

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/e2e-test.ts`
- Test: `scripts/cdp-bridge/test/unit/e2e-test-io.test.js`

**Interfaces:**
- Consumes: `LockedE2eTest`, `serializeLockedTest`, `parseLockedTest`, `e2ePathFor`, `e2eDirFor` (Task 1); `createHash` (node:crypto)
- Produces: `LockSource = { id; intent; sourceActionId; flow: string; params?: string[]; appId?: string }`; `freezeLockedTest(projectRoot, source: LockSource, ctx: { gitSha: string | null; now: () => Date }): LockedE2eTest`; `loadLockedTest(projectRoot, id): LockedE2eTest | null`; `discoverLockedTests(projectRoot): string[]` (ids, sorted, `.yaml` only); `hashBody(s: string): string`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/e2e-test-io.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  freezeLockedTest,
  loadLockedTest,
  discoverLockedTests,
  hashBody,
} from '../../dist/domain/e2e-test.js';

const FLOW = 'appId: com.x\n---\n# id: login\n- launchApp\n';
const SRC = { id: 'login', intent: 'Log in', sourceActionId: 'login', flow: FLOW, appId: 'com.x' };
const CTX = { gitSha: 'sha123', now: () => new Date('2026-06-18T00:00:00Z') };

test('freeze writes an executable, parseable file and returns metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-io-'));
  try {
    const locked = freezeLockedTest(root, SRC, CTX);
    assert.equal(locked.id, 'login');
    assert.equal(locked.sourceContentHash, hashBody(FLOW));
    const onDisk = readFileSync(join(root, '.rn-agent', 'e2e', 'login.yaml'), 'utf8');
    assert.match(onDisk, /# e2e-locked-test: true/);
    assert.match(onDisk, /^appId: com\.x$/m); // executable header preserved
    const reloaded = loadLockedTest(root, 'login');
    assert.equal(reloaded.lockedGitSha, 'sha123');
    assert.match(reloaded.flow, /- launchApp/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverLockedTests lists .yaml ids sorted, ignores .yml; load null for missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-io-'));
  try {
    freezeLockedTest(root, { ...SRC, id: 'bbb' }, CTX);
    freezeLockedTest(root, { ...SRC, id: 'aaa' }, CTX);
    // a stray .yml must NOT be discovered (freeze only writes .yaml)
    mkdirSync(join(root, '.rn-agent', 'e2e'), { recursive: true });
    writeFileSync(join(root, '.rn-agent', 'e2e', 'ccc.yml'), '# e2e-locked-test: true\n', 'utf8');
    assert.deepEqual(discoverLockedTests(root), ['aaa', 'bbb']);
    assert.equal(loadLockedTest(root, 'missing'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/e2e-test-io.test.js'`
Expected: FAIL — `freezeLockedTest is not a function`

- [ ] **Step 3: Write minimal implementation** (append to `src/domain/e2e-test.ts`)

```typescript
import { dirname } from 'node:path';
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function hashBody(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export interface LockSource {
  id: string;
  intent: string;
  sourceActionId: string;
  flow: string;
  params?: string[];
  appId?: string;
}

export function freezeLockedTest(
  projectRoot: string,
  source: LockSource,
  ctx: { gitSha: string | null; now: () => Date },
): LockedE2eTest {
  const filePath = e2ePathFor(projectRoot, source.id);
  mkdirSync(dirname(filePath), { recursive: true });
  const meta: Omit<LockedE2eTest, 'filePath'> = {
    id: source.id,
    intent: source.intent,
    sourceActionId: source.sourceActionId,
    lockedAt: ctx.now().toISOString(),
    lockedGitSha: ctx.gitSha,
    sourceContentHash: hashBody(source.flow),
    status: 'locked',
    params: source.params,
    appId: source.appId,
    flow: source.flow,
  };
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, serializeLockedTest(meta), 'utf8');
  renameSync(tmp, filePath);
  return { ...meta, filePath };
}

export function loadLockedTest(projectRoot: string, id: string): LockedE2eTest | null {
  const filePath = e2ePathFor(projectRoot, id);
  if (!existsSync(filePath)) return null;
  return parseLockedTest(readFileSync(filePath, 'utf8'), filePath);
}

export function discoverLockedTests(projectRoot: string): string[] {
  const dir = e2eDirFor(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/e2e-test-io.test.js'`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/e2e-test.ts scripts/cdp-bridge/dist/domain/e2e-test.js scripts/cdp-bridge/test/unit/e2e-test-io.test.js
git commit -m "feat(e2e): freeze raw flow / load / discover locked tests"
```

---

## Task 3: Run-record classification + verdict + diff (pure)

**Files:**
- Create: `scripts/cdp-bridge/src/domain/e2e-run.ts`
- Test: `scripts/cdp-bridge/test/unit/e2e-run-classify.test.js`

**Interfaces:**
- Consumes: `parseMaestroFailure` from `domain/maestro-error-parser.js`
- Produces: `E2eVerdict = 'green' | 'red' | 'setup_error'`; `E2eResultClassification = 'pass' | 'regression' | 'infra' | 'skipped'`; `E2eFlowResult`; `E2eRunRecord` (with `totals: { total; passed; failed; skipped }`)
- Produces fns: `classifyFlowResult(input): E2eFlowResult`; `skippedResult(testId, intent, reason): E2eFlowResult`; `computeVerdict(results): E2eVerdict` (red iff a non-skipped result failed); `diffNewlyFailing(current, previousGreen): string[]` (excludes skipped)

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/e2e-run-classify.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFlowResult,
  skippedResult,
  computeVerdict,
  diffNewlyFailing,
} from '../../dist/domain/e2e-run.js';

test('passed flow → pass', () => {
  const r = classifyFlowResult({ testId: 'a', intent: 'A', passed: true, durationMs: 10, output: 'Flow PASSED' });
  assert.equal(r.classification, 'pass');
});

test('real maestro selector-not-found output → regression', () => {
  const r = classifyFlowResult({
    testId: 'a', intent: 'A', passed: false, durationMs: 10,
    output: "Element not found: id='submitButton'",
  });
  assert.equal(r.classification, 'regression');
  assert.equal(r.failureKind, 'SELECTOR_NOT_FOUND');
});

test('real maestro timeout output → still red, annotated infra', () => {
  const r = classifyFlowResult({
    testId: 'a', intent: 'A', passed: false, durationMs: 99,
    output: "Timed out waiting for element with id 'spinner'",
  });
  assert.equal(r.passed, false);
  assert.equal(r.failureKind, 'TIMEOUT');
  assert.equal(r.infraAnnotation, 'likely-infrastructure (timeout)');
});

test('skippedResult is neither pass nor fail for the verdict', () => {
  const s = skippedResult('p', 'P', 'needs params');
  assert.equal(s.classification, 'skipped');
  assert.equal(computeVerdict([{ classification: 'pass', passed: true }, s]), 'green');
});

test('computeVerdict: any non-skipped failure → red', () => {
  assert.equal(computeVerdict([{ classification: 'pass', passed: true }]), 'green');
  assert.equal(computeVerdict([{ classification: 'infra', passed: false }]), 'red');
});

test('diffNewlyFailing ignores skipped + finds newly-broken', () => {
  const prev = { results: [{ testId: 'a', passed: true, classification: 'pass' }, { testId: 'b', passed: true, classification: 'pass' }] };
  const cur = { results: [
    { testId: 'a', passed: false, classification: 'regression' },
    { testId: 'b', passed: true, classification: 'pass' },
    { testId: 'c', passed: false, classification: 'skipped' },
  ] };
  assert.deepEqual(diffNewlyFailing(cur, prev), ['a']);
  assert.deepEqual(diffNewlyFailing(cur, null), ['a']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/e2e-run-classify.test.js'`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/domain/e2e-run.ts
import { parseMaestroFailure } from './maestro-error-parser.js';

export type E2eVerdict = 'green' | 'red' | 'setup_error';
export type E2eResultClassification = 'pass' | 'regression' | 'infra' | 'skipped';

export interface E2eFlowResult {
  testId: string;
  intent: string;
  passed: boolean;
  durationMs: number;
  classification: E2eResultClassification;
  failureKind?: string;
  infraAnnotation?: string | null;
  errorExcerpt?: string | null;
}

export interface E2eRunRecord {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  gitSha: string | null;
  gitDirty: boolean;
  platform: string;
  deviceId: string | null;
  metroReloaded: boolean;
  totals: { total: number; passed: number; failed: number; skipped: number };
  verdict: E2eVerdict;
  results: E2eFlowResult[];
  previousGreenRunId: string | null;
}

export function classifyFlowResult(input: {
  testId: string;
  intent: string;
  passed: boolean;
  durationMs: number;
  output: string;
}): E2eFlowResult {
  if (input.passed) {
    return {
      testId: input.testId,
      intent: input.intent,
      passed: true,
      durationMs: input.durationMs,
      classification: 'pass',
    };
  }
  const failure = parseMaestroFailure(input.output);
  const isRegression = failure.kind === 'SELECTOR_NOT_FOUND' || failure.kind === 'ASSERTION_FAILED';
  return {
    testId: input.testId,
    intent: input.intent,
    passed: false,
    durationMs: input.durationMs,
    classification: isRegression ? 'regression' : 'infra',
    failureKind: failure.kind,
    infraAnnotation: failure.kind === 'TIMEOUT' ? 'likely-infrastructure (timeout)' : null,
    errorExcerpt: input.output.slice(0, 500),
  };
}

export function skippedResult(testId: string, intent: string, reason: string): E2eFlowResult {
  return {
    testId,
    intent,
    passed: false,
    durationMs: 0,
    classification: 'skipped',
    infraAnnotation: reason,
  };
}

export function computeVerdict(results: Array<{ passed: boolean; classification: E2eResultClassification }>): E2eVerdict {
  return results.some((r) => !r.passed && r.classification !== 'skipped') ? 'red' : 'green';
}

export function diffNewlyFailing(
  current: { results: Array<{ testId: string; passed: boolean; classification: E2eResultClassification }> },
  previousGreen: { results: Array<{ testId: string; passed: boolean }> } | null,
): string[] {
  const wasPassing = new Set((previousGreen?.results ?? []).filter((r) => r.passed).map((r) => r.testId));
  return current.results
    .filter((r) => !r.passed && r.classification !== 'skipped' && (previousGreen === null || wasPassing.has(r.testId)))
    .map((r) => r.testId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/e2e-run-classify.test.js'`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/e2e-run.ts scripts/cdp-bridge/dist/domain/e2e-run.js scripts/cdp-bridge/test/unit/e2e-run-classify.test.js
git commit -m "feat(e2e): result classification (real maestro patterns), verdict, diff"
```

---

## Task 4: Run-record + index persistence

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/e2e-run.ts`
- Test: `scripts/cdp-bridge/test/unit/e2e-run-store.test.js`

**Interfaces:**
- Consumes: `E2eRunRecord` (Task 3)
- Produces: `e2eRunsDirFor(projectRoot): string`; `writeRunRecord(projectRoot, rec): void` (writes `<runId>.json` + updates `index.json`, bounded 100 newest-first); `loadIndex(projectRoot): E2eRunIndexEntry[]`; `loadRunRecord(projectRoot, runId): E2eRunRecord | null`; `lastGreenRunId(projectRoot): string | null`; `E2eRunIndexEntry = { runId; finishedAt; verdict; totals }`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/e2e-run-store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRunRecord, loadIndex, loadRunRecord, lastGreenRunId } from '../../dist/domain/e2e-run.js';

function rec(runId, verdict) {
  const failed = verdict === 'green' ? 0 : 1;
  return {
    runId, startedAt: '2026-06-18T00:00:00Z', finishedAt: '2026-06-18T00:01:00Z', durationMs: 60000,
    gitSha: 'x', gitDirty: false, platform: 'ios', deviceId: 'udid', metroReloaded: true,
    totals: { total: 1, passed: 1 - failed, failed, skipped: 0 },
    verdict, results: [], previousGreenRunId: null,
  };
}

test('writeRunRecord persists record + index; lastGreenRunId finds newest green', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-store-'));
  try {
    writeRunRecord(root, rec('run-1', 'green'));
    writeRunRecord(root, rec('run-2', 'red'));
    writeRunRecord(root, rec('run-3', 'green'));
    const idx = loadIndex(root);
    assert.equal(idx.length, 3);
    assert.equal(idx[0].runId, 'run-3');
    assert.equal(loadRunRecord(root, 'run-2').verdict, 'red');
    assert.equal(lastGreenRunId(root), 'run-3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/e2e-run-store.test.js'`
Expected: FAIL — `writeRunRecord is not a function`

- [ ] **Step 3: Write minimal implementation** (append to `src/domain/e2e-run.ts`)

```typescript
import { join } from 'node:path';
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { assertValidActionId } from './path-safety.js';

export interface E2eRunIndexEntry {
  runId: string;
  finishedAt: string;
  verdict: E2eVerdict;
  totals: { total: number; passed: number; failed: number; skipped: number };
}

const INDEX_MAX = 100;

export function e2eRunsDirFor(projectRoot: string): string {
  return join(projectRoot, '.rn-agent', 'state', 'e2e-runs');
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function loadIndex(projectRoot: string): E2eRunIndexEntry[] {
  const file = join(e2eRunsDirFor(projectRoot), 'index.json');
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeRunRecord(projectRoot: string, rec: E2eRunRecord): void {
  assertValidActionId(rec.runId, 'writeRunRecord');
  const dir = e2eRunsDirFor(projectRoot);
  writeJsonAtomic(join(dir, `${rec.runId}.json`), rec);
  const entry: E2eRunIndexEntry = {
    runId: rec.runId,
    finishedAt: rec.finishedAt,
    verdict: rec.verdict,
    totals: rec.totals,
  };
  const next = [entry, ...loadIndex(projectRoot).filter((e) => e.runId !== rec.runId)].slice(0, INDEX_MAX);
  writeJsonAtomic(join(dir, 'index.json'), next);
}

export function loadRunRecord(projectRoot: string, runId: string): E2eRunRecord | null {
  assertValidActionId(runId, 'loadRunRecord');
  const file = join(e2eRunsDirFor(projectRoot), `${runId}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as E2eRunRecord;
  } catch {
    return null;
  }
}

export function lastGreenRunId(projectRoot: string): string | null {
  return loadIndex(projectRoot).find((e) => e.verdict === 'green')?.runId ?? null;
}
```

Note: `runId` must satisfy `assertValidActionId` (`^[A-Za-z0-9][A-Za-z0-9_.-]*$`). Task 8 `makeRunId` emits only those chars. The index read-modify-write is serialized in practice by the exclusive flow lease (see NITs).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/e2e-run-store.test.js'`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/e2e-run.ts scripts/cdp-bridge/dist/domain/e2e-run.js scripts/cdp-bridge/test/unit/e2e-run-store.test.js
git commit -m "feat(e2e): suite-run record + index persistence"
```

---

## Task 5: Durable run-request state machine + interrupted recovery

**Files:**
- Create: `scripts/cdp-bridge/src/domain/e2e-run-request.ts`
- Test: `scripts/cdp-bridge/test/unit/e2e-run-request.test.js`

**Interfaces:**
- Produces: `E2eRunStatus = 'requested' | 'reloading' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'`; `E2eRunRequest`; `writeRequest`/`updateRequest`/`loadRequest`/`listRequests`; `recoverInterruptedRequests(projectRoot, isPidAlive, now): string[]`; `TERMINAL_STATUSES: ReadonlySet<E2eRunStatus>` (exported — reused by the guard in Task 9)

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/e2e-run-request.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeRequest,
  updateRequest,
  loadRequest,
  recoverInterruptedRequests,
} from '../../dist/domain/e2e-run-request.js';

const NOW = () => new Date('2026-06-18T00:00:00Z');
function req(runId, status, pid) {
  return { runId, status, pid, createdAt: '2026-06-18T00:00:00Z', updatedAt: '2026-06-18T00:00:00Z' };
}

test('write → update → load reflects status + progress transitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-req-'));
  try {
    writeRequest(root, req('run-1', 'requested', process.pid));
    updateRequest(root, 'run-1', { status: 'running', progress: { total: 3, completed: 1 } });
    const loaded = loadRequest(root, 'run-1');
    assert.equal(loaded.status, 'running');
    assert.equal(loaded.progress.completed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recover marks running-with-dead-pid interrupted; leaves live + terminal alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-req-'));
  try {
    writeRequest(root, req('dead', 'running', 99999));
    writeRequest(root, req('live', 'running', process.pid));
    writeRequest(root, req('done', 'done', 99999));
    const affected = recoverInterruptedRequests(root, (pid) => pid === process.pid, NOW);
    assert.deepEqual(affected, ['dead']);
    assert.equal(loadRequest(root, 'dead').status, 'interrupted');
    assert.equal(loadRequest(root, 'live').status, 'running');
    assert.equal(loadRequest(root, 'done').status, 'done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/e2e-run-request.test.js'`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/domain/e2e-run-request.ts
import { join } from 'node:path';
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { assertValidActionId } from './path-safety.js';
import { e2eRunsDirFor } from './e2e-run.js';

export type E2eRunStatus =
  | 'requested'
  | 'reloading'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface E2eRunRequest {
  runId: string;
  status: E2eRunStatus;
  pid: number;
  createdAt: string;
  updatedAt: string;
  pattern?: string;
  progress?: { total: number; completed: number; lastTestId?: string };
}

export const TERMINAL_STATUSES: ReadonlySet<E2eRunStatus> = new Set([
  'done',
  'failed',
  'cancelled',
  'interrupted',
]);

function requestsDir(projectRoot: string): string {
  return join(e2eRunsDirFor(projectRoot), 'requests');
}

function requestPath(projectRoot: string, runId: string): string {
  assertValidActionId(runId, 'e2e-run-request');
  return join(requestsDir(projectRoot), `${runId}.json`);
}

export function writeRequest(projectRoot: string, req: E2eRunRequest): void {
  const file = requestPath(projectRoot, req.runId);
  mkdirSync(requestsDir(projectRoot), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(req, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function loadRequest(projectRoot: string, runId: string): E2eRunRequest | null {
  const file = requestPath(projectRoot, runId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as E2eRunRequest;
  } catch {
    return null;
  }
}

export function updateRequest(
  projectRoot: string,
  runId: string,
  patch: Partial<Omit<E2eRunRequest, 'runId'>>,
): E2eRunRequest | null {
  const cur = loadRequest(projectRoot, runId);
  if (!cur) return null;
  const next: E2eRunRequest = { ...cur, ...patch, runId };
  writeRequest(projectRoot, next);
  return next;
}

export function listRequests(projectRoot: string): E2eRunRequest[] {
  const dir = requestsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const out: E2eRunRequest[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const r = loadRequest(projectRoot, f.replace(/\.json$/, ''));
    if (r) out.push(r);
  }
  return out;
}

export function recoverInterruptedRequests(
  projectRoot: string,
  isPidAlive: (pid: number) => boolean,
  now: () => Date,
): string[] {
  const affected: string[] = [];
  for (const r of listRequests(projectRoot)) {
    if (TERMINAL_STATUSES.has(r.status)) continue;
    if (isPidAlive(r.pid)) continue;
    writeRequest(projectRoot, { ...r, status: 'interrupted', updatedAt: now().toISOString() });
    affected.push(r.runId);
  }
  return affected.sort();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/e2e-run-request.test.js'`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/e2e-run-request.ts scripts/cdp-bridge/dist/domain/e2e-run-request.js scripts/cdp-bridge/test/unit/e2e-run-request.test.js
git commit -m "feat(e2e): durable run-request + interrupted recovery"
```

---

## Task 6: git-info + pre-flight gate building blocks

**Files:**
- Create: `scripts/cdp-bridge/src/e2e/git-info.ts`
- Create: `scripts/cdp-bridge/src/e2e/preflight.ts`
- Test: `scripts/cdp-bridge/test/unit/e2e-preflight.test.js`

**Interfaces:**
- Produces: `getGitInfo(projectRoot, exec?): { sha: string | null; dirty: boolean }`
- Produces: `preflight(input): { ok: true } | { ok: false; code: 'SETUP_ERROR'; detail: string }` where `input = { platform; udid: string | null; appId?: string; metroReachable: boolean; appInstalled: boolean | null }`; `probeMetro(port, timeoutMs?): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/e2e-preflight.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGitInfo } from '../../dist/e2e/git-info.js';
import { preflight } from '../../dist/e2e/preflight.js';

test('getGitInfo parses sha + dirty from injected exec', () => {
  const exec = (_cmd, args) => (args.includes('rev-parse') ? 'abc1234\n' : ' M file.ts\n');
  assert.deepEqual(getGitInfo('/x', exec), { sha: 'abc1234', dirty: true });
});

test('getGitInfo: clean → dirty false; failure → sha null', () => {
  const clean = (_c, args) => (args.includes('rev-parse') ? 'def5678\n' : '');
  assert.deepEqual(getGitInfo('/x', clean), { sha: 'def5678', dirty: false });
  const boom = () => { throw new Error('not a git repo'); };
  assert.deepEqual(getGitInfo('/x', boom), { sha: null, dirty: false });
});

test('preflight ok when metro up + app installed', () => {
  assert.deepEqual(
    preflight({ platform: 'ios', udid: 'u', appId: 'com.x', metroReachable: true, appInstalled: true }),
    { ok: true },
  );
});

test('preflight SETUP_ERROR for metro down / no device / app missing; null app tolerated', () => {
  assert.equal(preflight({ platform: 'ios', udid: 'u', metroReachable: false, appInstalled: true }).code, 'SETUP_ERROR');
  assert.equal(preflight({ platform: 'ios', udid: null, metroReachable: true, appInstalled: true }).code, 'SETUP_ERROR');
  assert.equal(preflight({ platform: 'ios', udid: 'u', metroReachable: true, appInstalled: false }).code, 'SETUP_ERROR');
  assert.equal(preflight({ platform: 'ios', udid: 'u', metroReachable: true, appInstalled: null }).ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/e2e-preflight.test.js'`
Expected: FAIL — modules not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/e2e/git-info.ts
import { execFileSync } from 'node:child_process';

export type GitExec = (cmd: string, args: string[]) => string;

const defaultExec: GitExec = (cmd, args) =>
  execFileSync(cmd, args, { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

export function getGitInfo(
  projectRoot: string,
  exec: GitExec = (cmd, args) => defaultExec(cmd, ['-C', projectRoot, ...args]),
): { sha: string | null; dirty: boolean } {
  try {
    const sha = exec('git', ['rev-parse', '--short', 'HEAD']).trim() || null;
    const status = exec('git', ['status', '--porcelain']).trim();
    return { sha, dirty: status.length > 0 };
  } catch {
    return { sha: null, dirty: false };
  }
}
```

```typescript
// src/e2e/preflight.ts
import { request } from 'node:http';

export interface PreflightInput {
  platform: string;
  udid: string | null;
  appId?: string;
  metroReachable: boolean;
  appInstalled: boolean | null;
}

export type PreflightResult = { ok: true } | { ok: false; code: 'SETUP_ERROR'; detail: string };

export function preflight(input: PreflightInput): PreflightResult {
  if (!input.metroReachable) {
    return { ok: false, code: 'SETUP_ERROR', detail: 'Metro is not reachable — start it (npx expo start).' };
  }
  if (!input.udid) {
    return { ok: false, code: 'SETUP_ERROR', detail: 'No single booted device resolved — boot exactly one simulator/emulator.' };
  }
  if (input.appInstalled === false) {
    return { ok: false, code: 'SETUP_ERROR', detail: `App ${input.appId ?? ''} is not installed on ${input.udid}.` };
  }
  return { ok: true };
}

export function probeMetro(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/status', method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 500);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/e2e-preflight.test.js'`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/e2e/ scripts/cdp-bridge/dist/e2e/ scripts/cdp-bridge/test/unit/e2e-preflight.test.js
git commit -m "feat(e2e): git-info + pre-flight gate building blocks"
```

---

## Task 7: Lock tool (`cdp_lock_e2e_test`) + ToolErrorCode + FLOW_TOOLS + registration

**Files:**
- Modify: `scripts/cdp-bridge/src/types.ts` (extend `ToolErrorCode`)
- Create: `scripts/cdp-bridge/src/tools/lock-e2e-test.ts`
- Modify: `scripts/cdp-bridge/src/lifecycle/device-arbiter.ts` (`FLOW_TOOLS`)
- Modify: `scripts/cdp-bridge/src/index.ts` (register)
- Test: `scripts/cdp-bridge/test/unit/lock-e2e-test.test.js`

**Interfaces:**
- Consumes: `loadAction` (`domain/action-store.js`); `freezeLockedTest`, `loadLockedTest` (`domain/e2e-test.js`); `getGitInfo` (`e2e/git-info.js`); `getActiveSession` (`agent-device-wrapper.js`); `SessionState` (`types.js`); `createMaestroRunHandler` (`tools/maestro-run.js`); `okResult`/`failResult`/`ToolResult` (`utils.js`)
- Produces: `lockE2eTestCore(args, deps): Promise<ToolResult>`; `createLockE2eTestHandler(deps?)`. `args = { actionId; relock?; projectRoot? }`. `deps = { maestroRun?; loadAction?; readActionFile?; getGitInfo?; getSession?; now? }`

- [ ] **Step 1: Extend `ToolErrorCode`** — add the E2E codes to the union in `src/types.ts` (after the existing entries, before the union closes):

```typescript
  // E2E regression runner (2026-06-18)
  | 'NOT_FOUND'
  | 'ALREADY_LOCKED'
  | 'STRICT_RUN_FAILED'
  | 'PARAMS_UNSUPPORTED'
  | 'SETUP_ERROR'
  | 'NO_E2E_TESTS'
  | 'E2E_RUN_ACTIVE'
  | 'E2E_RUN_CRASHED'
```

Build to confirm the union still compiles: `cd scripts/cdp-bridge && npm run build` → expect success.

- [ ] **Step 2: Write the failing test**

```javascript
// test/unit/lock-e2e-test.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockE2eTestCore } from '../../dist/tools/lock-e2e-test.js';

function parse(r) { return JSON.parse(r.content[0].text); }

// REALISTIC action format: appId top section, '---', M7 header comments, steps.
function seedAction(root, id, params = '') {
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(dir, { recursive: true });
  const header = [`# id: ${id}`, '# intent: do a thing', '# status: active', '# appId: com.x'];
  if (params) header.push(`# params: ${params}`);
  writeFileSync(
    join(dir, `${id}.yaml`),
    `appId: com.x\n---\n${header.join('\n')}\n- launchApp\n`,
    'utf8',
  );
}
const okMaestro = async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { passed: true, output: 'Flow PASSED' } }) }] });
const failMaestro = async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: "Element not found: id='x'", meta: { output: "Element not found: id='x'" } }) }], isError: true });
const deps = (maestroRun) => ({
  maestroRun,
  getGitInfo: () => ({ sha: 'sha1', dirty: false }),
  getSession: () => ({ name: 's', platform: 'ios', deviceId: 'udid', appId: 'com.x', openedAt: '' }),
  now: () => new Date('2026-06-18T00:00:00Z'),
});

test('strict pass → freezes an EXECUTABLE locked test (appId preserved)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-'));
  try {
    seedAction(root, 'login');
    const res = parse(await lockE2eTestCore({ actionId: 'login', projectRoot: root }, deps(okMaestro)));
    assert.equal(res.ok, true);
    assert.equal(res.data.locked, true);
    const frozen = readFileSync(join(root, '.rn-agent', 'e2e', 'login.yaml'), 'utf8');
    assert.match(frozen, /^appId: com\.x$/m); // BLOCKER-1: executable
    assert.match(frozen, /^---$/m);
    assert.match(frozen, /- launchApp/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('strict fail → refuses, no file written', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-'));
  try {
    seedAction(root, 'login');
    const res = parse(await lockE2eTestCore({ actionId: 'login', projectRoot: root }, deps(failMaestro)));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'STRICT_RUN_FAILED');
    assert.equal(existsSync(join(root, '.rn-agent', 'e2e', 'login.yaml')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('param-needing action → refused PARAMS_UNSUPPORTED (no maestro run)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-'));
  try {
    seedAction(root, 'login', 'EMAIL');
    let called = false;
    const res = parse(await lockE2eTestCore({ actionId: 'login', projectRoot: root }, deps(async () => { called = true; return okMaestro(); })));
    assert.equal(res.code, 'PARAMS_UNSUPPORTED');
    assert.equal(called, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('already locked → refused unless relock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-'));
  try {
    seedAction(root, 'login');
    await lockE2eTestCore({ actionId: 'login', projectRoot: root }, deps(okMaestro));
    const dup = parse(await lockE2eTestCore({ actionId: 'login', projectRoot: root }, deps(okMaestro)));
    assert.equal(dup.code, 'ALREADY_LOCKED');
    const re = parse(await lockE2eTestCore({ actionId: 'login', projectRoot: root, relock: true }, deps(okMaestro)));
    assert.equal(re.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing action → NOT_FOUND', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-'));
  try {
    const res = parse(await lockE2eTestCore({ actionId: 'nope', projectRoot: root }, deps(okMaestro)));
    assert.equal(res.code, 'NOT_FOUND');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/lock-e2e-test.test.js'`
Expected: FAIL — module not found

- [ ] **Step 4: Write minimal implementation**

```typescript
// src/tools/lock-e2e-test.ts
import { readFileSync } from 'node:fs';
import { loadAction } from '../domain/action-store.js';
import { freezeLockedTest, loadLockedTest } from '../domain/e2e-test.js';
import { getGitInfo as realGetGitInfo } from '../e2e/git-info.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { createMaestroRunHandler } from './maestro-run.js';
import { findProjectRoot } from '../nav-graph/storage.js';
import { okResult, failResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import type { SessionState } from '../types.js';

export interface LockE2eTestArgs {
  actionId: string;
  relock?: boolean;
  projectRoot?: string;
}

export interface LockE2eTestDeps {
  maestroRun?: (args: Record<string, unknown>) => Promise<ToolResult>;
  loadAction?: typeof loadAction;
  readActionFile?: (path: string) => string;
  getGitInfo?: (projectRoot: string) => { sha: string | null; dirty: boolean };
  getSession?: () => SessionState | null;
  now?: () => Date;
}

function readPassed(result: ToolResult): { passed: boolean; output: string } {
  try {
    const env = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: { passed?: boolean; output?: string };
      error?: string;
      meta?: { output?: string };
    };
    return {
      passed: env.ok === true && env.data?.passed === true,
      output: env.data?.output ?? env.meta?.output ?? env.error ?? '',
    };
  } catch {
    return { passed: false, output: 'unparseable maestro result' };
  }
}

export async function lockE2eTestCore(args: LockE2eTestArgs, deps: LockE2eTestDeps = {}): Promise<ToolResult> {
  const projectRoot = args.projectRoot ?? findProjectRoot() ?? process.cwd();
  const load = deps.loadAction ?? loadAction;
  const readFile = deps.readActionFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const getGit = deps.getGitInfo ?? realGetGitInfo;
  const getSession = deps.getSession ?? getActiveSession;
  const now = deps.now ?? (() => new Date());
  const maestroRun = deps.maestroRun ?? createMaestroRunHandler();

  const action = load(projectRoot, args.actionId);
  if (!action) return failResult(`Action '${args.actionId}' not found`, 'NOT_FOUND');

  if (action.metadata.params?.length) {
    return failResult(
      `'${args.actionId}' needs params (${action.metadata.params.join(', ')}). Param-needing tests are not supported in v1 — a params source (.rn-agent/e2e.config.json) lands in a later phase.`,
      'PARAMS_UNSUPPORTED',
    );
  }

  if (!args.relock && loadLockedTest(projectRoot, args.actionId)) {
    return failResult(`'${args.actionId}' is already locked — pass relock:true to re-lock`, 'ALREADY_LOCKED');
  }

  const session = getSession();
  const platform = (session?.platform as 'ios' | 'android' | undefined) ?? undefined;

  const result = await maestroRun({ flowPath: action.filePath, platform });
  const { passed, output } = readPassed(result);
  if (!passed) {
    return failResult(
      `'${args.actionId}' did not pass a strict run — repair it until it passes, then lock`,
      'STRICT_RUN_FAILED',
      { output: output.slice(0, 500) },
    );
  }

  const git = getGit(projectRoot);
  const locked = freezeLockedTest(
    projectRoot,
    {
      id: action.metadata.id,
      intent: action.metadata.intent,
      sourceActionId: action.metadata.id,
      flow: readFile(action.filePath),
      appId: action.metadata.appId,
    },
    { gitSha: git.sha, now },
  );

  return okResult({
    locked: true,
    id: locked.id,
    filePath: locked.filePath,
    lockedAt: locked.lockedAt,
    relocked: Boolean(args.relock),
  });
}

export function createLockE2eTestHandler(deps: LockE2eTestDeps = {}) {
  return (args: LockE2eTestArgs): Promise<ToolResult> => lockE2eTestCore(args, deps);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/lock-e2e-test.test.js'`
Expected: PASS (5 tests)

- [ ] **Step 6: Register + mark flow tool**

In `src/lifecycle/device-arbiter.ts`, add the two names to the `FLOW_TOOLS` set literal:

```typescript
const FLOW_TOOLS = new Set<string>([
  'maestro_run',
  'maestro_test_all',
  'cdp_run_action',
  'cdp_auto_login',
  'cdp_reload',
  'cdp_restart',
  'cdp_lock_e2e_test',
  'cdp_run_e2e_suite',
]);
```

In `src/index.ts`, add the import + `trackedTool` registration (mirror the existing call shape; `z` is already in scope):

```typescript
import { createLockE2eTestHandler } from './tools/lock-e2e-test.js';
// ...
trackedTool(
  'cdp_lock_e2e_test',
  'Promote a verified action into a frozen, locked e2e regression test. Runs the action once strict (no repair); freezes it only if it passes. v1 supports param-free actions only.',
  {
    actionId: z.string().describe('The action id under .rn-agent/actions to lock'),
    relock: z.boolean().optional().describe('Overwrite an existing locked test'),
    projectRoot: z.string().optional(),
  },
  createLockE2eTestHandler(),
);
```

- [ ] **Step 7: Full suite, then commit**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS (whole suite)

```bash
git add scripts/cdp-bridge/src/types.ts scripts/cdp-bridge/src/tools/lock-e2e-test.ts scripts/cdp-bridge/src/index.ts scripts/cdp-bridge/src/lifecycle/device-arbiter.ts scripts/cdp-bridge/dist scripts/cdp-bridge/test/unit/lock-e2e-test.test.js
git commit -m "feat(e2e): cdp_lock_e2e_test — strict gate, freeze executable flow, param-free guard"
```

---

## Task 8: Suite orchestrator core (discover → reload → run → classify → record)

**Files:**
- Create: `scripts/cdp-bridge/src/tools/run-e2e-suite.ts`
- Test: `scripts/cdp-bridge/test/unit/run-e2e-suite-core.test.js`

**Interfaces:**
- Consumes: `discoverLockedTests`, `loadLockedTest` (`domain/e2e-test.js`); `classifyFlowResult`, `skippedResult`, `computeVerdict`, `diffNewlyFailing`, `writeRunRecord`, `loadRunRecord`, `lastGreenRunId` (`domain/e2e-run.js`); `getGitInfo`; `getActiveSession`; `createMaestroRunHandler`
- Produces: `runE2eSuiteCore(args, deps): Promise<ToolResult>`; `makeRunId(now, rand): string`. `deps` injects: `discover, load, maestroRun, getGitInfo, getSession, now, makeRunId, runReload?, onProgress?`. No preflight here (handler owns it — Task 9). `runReload` is wrapped so a throw degrades to `metroReloaded:false`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/run-e2e-suite-core.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runE2eSuiteCore, makeRunId } from '../../dist/tools/run-e2e-suite.js';
import { loadIndex } from '../../dist/domain/e2e-run.js';

function parse(r) { return JSON.parse(r.content[0].text); }
const passEnv = () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { passed: true, output: 'Flow PASSED' } }) }] });
const failEnv = (out) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: out, meta: { output: out } }) }], isError: true });

function lockedFixture(id, params) {
  return { id, intent: `do ${id}`, flow: 'appId: com.x\n---\n- launchApp\n', params, appId: 'com.x', filePath: `/x/${id}.yaml`, status: 'locked', sourceActionId: id, lockedAt: '', lockedGitSha: null, sourceContentHash: '' };
}
function baseDeps(ids, maestroByPath, loadOverride) {
  return {
    discover: () => ids,
    load: loadOverride ?? ((_root, id) => lockedFixture(id)),
    maestroRun: async (a) => maestroByPath(a.flowPath),
    getGitInfo: () => ({ sha: 's', dirty: false }),
    getSession: () => ({ name: 's', platform: 'ios', deviceId: 'udid', appId: 'com.x', openedAt: '' }),
    now: () => new Date('2026-06-18T00:00:00Z'),
    makeRunId: () => 'run-test-1',
    runReload: async () => false,
  };
}

test('all pass → verdict green, record persisted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-'));
  try {
    const res = parse(await runE2eSuiteCore({ projectRoot: root }, baseDeps(['login', 'checkout'], () => passEnv())));
    assert.equal(res.data.verdict, 'green');
    assert.equal(res.data.totals.passed, 2);
    assert.equal(loadIndex(root)[0].verdict, 'green');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selector failure (real maestro string) → red + regression', async () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-'));
  try {
    const byPath = (fp) => (fp.includes('checkout') ? failEnv("Element not found: id='payBtn'") : passEnv());
    const res = parse(await runE2eSuiteCore({ projectRoot: root }, baseDeps(['login', 'checkout'], byPath)));
    assert.equal(res.data.verdict, 'red');
    assert.equal(res.data.results.find((r) => r.testId === 'checkout').classification, 'regression');
    assert.deepEqual(res.data.newlyFailing, ['checkout']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('param-needing locked test → skipped, not counted as failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-'));
  try {
    const load = (_root, id) => lockedFixture(id, id === 'paid' ? ['EMAIL'] : undefined);
    const res = parse(await runE2eSuiteCore({ projectRoot: root }, baseDeps(['free', 'paid'], () => passEnv(), load)));
    assert.equal(res.data.verdict, 'green');
    assert.equal(res.data.totals.skipped, 1);
    assert.equal(res.data.results.find((r) => r.testId === 'paid').classification, 'skipped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty suite → warn, NO record written', async () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-'));
  try {
    const res = parse(await runE2eSuiteCore({ projectRoot: root }, baseDeps([], () => passEnv())));
    assert.equal(res.ok, true);
    assert.equal(res.data.totals.total, 0);
    assert.equal(loadIndex(root).length, 0); // no false-green record
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('makeRunId is a path-safe slug', () => {
  assert.match(makeRunId(() => new Date('2026-06-18T12:34:56Z'), () => 'ab12'), /^run-[0-9TZ-]+-ab12$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/run-e2e-suite-core.test.js'`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tools/run-e2e-suite.ts
import { discoverLockedTests, loadLockedTest } from '../domain/e2e-test.js';
import {
  classifyFlowResult,
  skippedResult,
  computeVerdict,
  diffNewlyFailing,
  writeRunRecord,
  loadRunRecord,
  lastGreenRunId,
} from '../domain/e2e-run.js';
import type { E2eFlowResult, E2eRunRecord } from '../domain/e2e-run.js';
import type { LockedE2eTest } from '../domain/e2e-test.js';
import { getGitInfo as realGetGitInfo } from '../e2e/git-info.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { createMaestroRunHandler } from './maestro-run.js';
import { findProjectRoot } from '../nav-graph/storage.js';
import { okResult, warnResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import type { SessionState } from '../types.js';

export interface RunE2eSuiteArgs {
  pattern?: string;
  projectRoot?: string;
  deviceId?: string;
}

export interface RunE2eSuiteDeps {
  discover?: (projectRoot: string) => string[];
  load?: (projectRoot: string, id: string) => LockedE2eTest | null;
  maestroRun?: (args: Record<string, unknown>) => Promise<ToolResult>;
  getGitInfo?: (projectRoot: string) => { sha: string | null; dirty: boolean };
  getSession?: () => SessionState | null;
  now?: () => Date;
  makeRunId?: (now: () => Date, rand: () => string) => string;
  runReload?: () => Promise<boolean>;
  onProgress?: (completed: number, total: number, lastTestId: string) => void;
}

export function makeRunId(now: () => Date, rand: () => string): string {
  return `run-${now().toISOString().replace(/[:.]/g, '-')}-${rand()}`;
}

function readMaestro(result: ToolResult): { passed: boolean; output: string } {
  try {
    const env = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: { passed?: boolean; output?: string };
      error?: string;
      meta?: { output?: string };
    };
    return {
      passed: env.ok === true && env.data?.passed === true,
      output: env.data?.output ?? env.meta?.output ?? env.error ?? '',
    };
  } catch {
    return { passed: false, output: 'unparseable maestro result' };
  }
}

function filterByPattern(ids: string[], pattern?: string): string[] {
  if (!pattern || pattern.length > 256) return ids;
  try {
    const re = new RegExp(pattern, 'i');
    return ids.filter((id) => re.test(id));
  } catch {
    return ids;
  }
}

export async function runE2eSuiteCore(args: RunE2eSuiteArgs, deps: RunE2eSuiteDeps = {}): Promise<ToolResult> {
  const projectRoot = args.projectRoot ?? findProjectRoot() ?? process.cwd();
  const discover = deps.discover ?? discoverLockedTests;
  const load = deps.load ?? loadLockedTest;
  const maestroRun = deps.maestroRun ?? createMaestroRunHandler();
  const getGit = deps.getGitInfo ?? realGetGitInfo;
  const getSession = deps.getSession ?? getActiveSession;
  const now = deps.now ?? (() => new Date());
  const mkRunId = deps.makeRunId ?? makeRunId;
  const rand = (): string => Math.random().toString(36).slice(2, 8);

  const ids = filterByPattern(discover(projectRoot), args.pattern);
  if (ids.length === 0) {
    return warnResult(
      { runId: null, verdict: 'green', totals: { total: 0, passed: 0, failed: 0, skipped: 0 }, results: [], newlyFailing: [] },
      'No locked e2e tests found — lock one with cdp_lock_e2e_test',
      { code: 'NO_E2E_TESTS' },
    );
  }

  const runId = mkRunId(now, rand);
  const startedAt = now().toISOString();
  const startMs = now().getTime();
  const session = getSession();
  const platform = session?.platform ?? 'ios';
  const deviceId = args.deviceId ?? session?.deviceId ?? null;
  const git = getGit(projectRoot);

  let metroReloaded = false;
  if (deps.runReload) {
    try {
      metroReloaded = await deps.runReload();
    } catch {
      metroReloaded = false;
    }
  }

  const results: E2eFlowResult[] = [];
  for (const id of ids) {
    const locked = load(projectRoot, id);
    if (!locked) continue;
    if (locked.params?.length) {
      results.push(skippedResult(id, locked.intent, 'needs params (unsupported in v1)'));
      deps.onProgress?.(results.length, ids.length, id);
      continue;
    }
    const t0 = now().getTime();
    const result = await maestroRun({ flowPath: locked.filePath, platform: platform as 'ios' | 'android' });
    const { passed, output } = readMaestro(result);
    results.push(classifyFlowResult({ testId: id, intent: locked.intent, passed, durationMs: now().getTime() - t0, output }));
    deps.onProgress?.(results.length, ids.length, id);
  }

  const verdict = computeVerdict(results);
  const prevGreenId = lastGreenRunId(projectRoot);
  const prevGreen = prevGreenId ? loadRunRecord(projectRoot, prevGreenId) : null;
  const record: E2eRunRecord = {
    runId,
    startedAt,
    finishedAt: now().toISOString(),
    durationMs: now().getTime() - startMs,
    gitSha: git.sha,
    gitDirty: git.dirty,
    platform,
    deviceId,
    metroReloaded,
    totals: {
      total: results.length,
      passed: results.filter((r) => r.classification === 'pass').length,
      failed: results.filter((r) => !r.passed && r.classification !== 'skipped').length,
      skipped: results.filter((r) => r.classification === 'skipped').length,
    },
    verdict,
    results,
    previousGreenRunId: prevGreenId,
  };
  writeRunRecord(projectRoot, record);

  return okResult({
    runId,
    verdict,
    totals: record.totals,
    results,
    newlyFailing: diffNewlyFailing(record, prevGreen),
    metroReloaded,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/run-e2e-suite-core.test.js'`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/run-e2e-suite.ts scripts/cdp-bridge/dist scripts/cdp-bridge/test/unit/run-e2e-suite-core.test.js
git commit -m "feat(e2e): suite orchestrator core (skip params, empty-warn, real-pattern classify)"
```

---

## Task 9: Orchestrator handler — preflight, single-slot guard (staleness), request lifecycle, real wiring + startup recovery

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/run-e2e-suite.ts` (handler wrapper)
- Modify: `scripts/cdp-bridge/src/index.ts` (register with real deps + startup recovery)
- Test: `scripts/cdp-bridge/test/unit/run-e2e-suite-guard.test.js`

**Interfaces:**
- Consumes: Task 8 `runE2eSuiteCore`; `writeRequest`/`updateRequest`/`listRequests`/`TERMINAL_STATUSES` (`domain/e2e-run-request.js`)
- Produces: `createRunE2eSuiteHandler(deps?)`; `isRunActive(projectRoot, isPidAlive, now, staleMs?): boolean` (active = non-terminal AND pid alive AND `updatedAt` within `staleMs`)

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/run-e2e-suite-guard.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunE2eSuiteHandler } from '../../dist/tools/run-e2e-suite.js';
import { writeRequest, loadRequest } from '../../dist/domain/e2e-run-request.js';

function parse(r) { return JSON.parse(r.content[0].text); }
const NOW_ISO = '2026-06-18T00:00:00.000Z';
const baseDeps = (over = {}) => ({
  discover: () => [],
  getGitInfo: () => ({ sha: 's', dirty: false }),
  getSession: () => ({ name: 's', platform: 'ios', deviceId: 'udid', appId: 'com.x', openedAt: '' }),
  now: () => new Date(NOW_ISO),
  makeRunId: () => 'run-guard-1',
  runReload: async () => false,
  preflightCheck: async () => ({ ok: true }),
  isPidAlive: () => true,
  ...over,
});

test('pre-flight failure → SETUP_ERROR; request marked failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    const handler = createRunE2eSuiteHandler(baseDeps({ preflightCheck: async () => ({ ok: false, code: 'SETUP_ERROR', detail: 'Metro down' }) }));
    const res = parse(await handler({ projectRoot: root }));
    assert.equal(res.code, 'SETUP_ERROR');
    assert.equal(loadRequest(root, 'run-guard-1').status, 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('single-slot guard refuses a fresh live run in progress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    writeRequest(root, { runId: 'run-existing', status: 'running', pid: process.pid, createdAt: NOW_ISO, updatedAt: NOW_ISO });
    const handler = createRunE2eSuiteHandler(baseDeps({ isPidAlive: (pid) => pid === process.pid }));
    const res = parse(await handler({ projectRoot: root }));
    assert.equal(res.code, 'E2E_RUN_ACTIVE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('STALE running request (old updatedAt) does NOT wedge the guard', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    writeRequest(root, { runId: 'run-stale', status: 'running', pid: process.pid, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' });
    const handler = createRunE2eSuiteHandler(baseDeps({ isPidAlive: () => true }));
    const res = parse(await handler({ projectRoot: root }));
    assert.equal(res.ok, true); // stale holder ignored, run proceeds
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('happy path → ends in done', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    const res = parse(await createRunE2eSuiteHandler(baseDeps())({ projectRoot: root }));
    assert.equal(res.ok, true);
    assert.equal(loadRequest(root, 'run-guard-1').status, 'done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/run-e2e-suite-guard.test.js'`
Expected: FAIL — `createRunE2eSuiteHandler is not a function`

- [ ] **Step 3: Write minimal implementation** (append to `src/tools/run-e2e-suite.ts`)

```typescript
import { writeRequest, updateRequest, listRequests, TERMINAL_STATUSES } from '../domain/e2e-run-request.js';
import { failResult } from '../utils.js';

const STALE_MS = 15 * 60_000;

export interface RunE2eSuiteHandlerDeps extends RunE2eSuiteDeps {
  isPidAlive?: (pid: number) => boolean;
  preflightCheck?: () => Promise<{ ok: true } | { ok: false; code: 'SETUP_ERROR'; detail: string }>;
}

export function isRunActive(
  projectRoot: string,
  isPidAlive: (pid: number) => boolean,
  now: () => Date,
  staleMs: number = STALE_MS,
): boolean {
  const nowMs = now().getTime();
  return listRequests(projectRoot).some((r) => {
    if (TERMINAL_STATUSES.has(r.status)) return false;
    if (!isPidAlive(r.pid)) return false;
    const age = nowMs - new Date(r.updatedAt).getTime();
    return Number.isFinite(age) && age < staleMs;
  });
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createRunE2eSuiteHandler(deps: RunE2eSuiteHandlerDeps = {}) {
  return async (args: RunE2eSuiteArgs): Promise<ToolResult> => {
    const projectRoot = args.projectRoot ?? findProjectRoot() ?? process.cwd();
    const isPidAlive = deps.isPidAlive ?? defaultPidAlive;
    const now = deps.now ?? (() => new Date());
    const preflightCheck = deps.preflightCheck ?? (async () => ({ ok: true as const }));

    if (isRunActive(projectRoot, isPidAlive, now)) {
      return failResult('An e2e run is already in progress', 'E2E_RUN_ACTIVE');
    }

    const rand = (): string => Math.random().toString(36).slice(2, 8);
    const runId = (deps.makeRunId ?? makeRunId)(now, rand);
    // SF9: persist the request BEFORE the preflight await so the guard window is closed.
    writeRequest(projectRoot, {
      runId,
      status: 'requested',
      pid: process.pid,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
      pattern: args.pattern,
    });

    const pre = await preflightCheck();
    if (!pre.ok) {
      updateRequest(projectRoot, runId, { status: 'failed', updatedAt: now().toISOString() });
      return failResult(pre.detail, 'SETUP_ERROR');
    }

    updateRequest(projectRoot, runId, { status: 'running', updatedAt: now().toISOString() });
    try {
      const result = await runE2eSuiteCore(args, {
        ...deps,
        makeRunId: () => runId,
        onProgress: (completed, total, lastTestId) =>
          updateRequest(projectRoot, runId, { updatedAt: now().toISOString(), progress: { total, completed, lastTestId } }),
      });
      updateRequest(projectRoot, runId, { status: 'done', updatedAt: now().toISOString() });
      return result;
    } catch (err) {
      updateRequest(projectRoot, runId, { status: 'failed', updatedAt: now().toISOString() });
      return failResult(`e2e run crashed: ${err instanceof Error ? err.message : String(err)}`, 'E2E_RUN_CRASHED');
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/run-e2e-suite-guard.test.js'`
Expected: PASS (4 tests)

- [ ] **Step 5: Register with REAL preflight + reload deps + startup recovery (`src/index.ts`)**

Add imports:

```typescript
import { createRunE2eSuiteHandler } from './tools/run-e2e-suite.js';
import { recoverInterruptedRequests } from './domain/e2e-run-request.js';
import { preflight, probeMetro } from './e2e/preflight.js';
import { resolveIosUdid } from './tools/device-screenshot-raw.js';
import { probeAppInstalled } from './cdp/app-installed-probe.js';
import { createReloadHandler } from './tools/reload.js';
```

Build the real deps (where `getClient`/`setClient`/`createClient` + `getActiveSession` are in scope) and register:

```typescript
const e2ePreflight = async () => {
  const session = getActiveSession();
  const platform = session?.platform ?? 'ios';
  const metroReachable = await probeMetro(getClient().metroPort);
  let udid: string | null;
  let appInstalled: boolean | null = null;
  if (platform === 'android') {
    udid = session?.deviceId ?? null; // v1: android preflight is device-presence only
  } else {
    udid = (await resolveIosUdid(session?.deviceId)) ?? null;
    appInstalled = udid && session?.appId ? await probeAppInstalled(udid, session.appId) : null;
  }
  return preflight({ platform, udid, appId: session?.appId, metroReachable, appInstalled });
};

const e2eReload = async (): Promise<boolean> => {
  if (!getClient().isConnected) return false;
  try {
    const r = await createReloadHandler(getClient, setClient, createClient)({ full: true });
    return JSON.parse(r.content[0].text)?.ok === true;
  } catch {
    return false;
  }
};

trackedTool(
  'cdp_run_e2e_suite',
  'Run all locked e2e tests strict (no repair) on the booted sim; persist a suite-run report with verdict + per-test results.',
  {
    pattern: z.string().optional().describe('Regex filter over locked-test ids'),
    projectRoot: z.string().optional(),
    deviceId: z.string().optional(),
  },
  createRunE2eSuiteHandler({ preflightCheck: e2ePreflight, runReload: e2eReload }),
);
```

In `main()` (the worker entrypoint, after the server is wired — NOT the supervisor), add the interrupted-run sweep:

```typescript
{
  const root = findProjectRoot();
  if (root) {
    const recovered = recoverInterruptedRequests(
      root,
      (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
      () => new Date(),
    );
    if (recovered.length) console.error(`[e2e] marked interrupted runs: ${recovered.join(', ')}`);
  }
}
```

- [ ] **Step 6: Full suite, then commit**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS (whole suite)

```bash
git add scripts/cdp-bridge/src/tools/run-e2e-suite.ts scripts/cdp-bridge/src/index.ts scripts/cdp-bridge/dist scripts/cdp-bridge/test/unit/run-e2e-suite-guard.test.js
git commit -m "feat(e2e): cdp_run_e2e_suite handler — real preflight/reload wiring, staleness guard, lifecycle, recovery"
```

---

## Task 10: Wiring — `/lock-e2e` command, .gitignore, changeset

**Files:**
- Create: `commands/lock-e2e.md`
- Modify: `.gitignore`
- Create: `.changeset/e2e-regression-runner-engine.md`

- [ ] **Step 1: Create the `/lock-e2e` command** (frontmatter mirrors `commands/run-action.md`: `command`, `description`, `argument-hint`, `allowed-tools`)

```markdown
---
command: lock-e2e
description: Promote a verified action into a frozen, locked e2e regression test. Runs the action once strict (no repair) via cdp_lock_e2e_test and freezes it to .rn-agent/e2e/<id>.yaml only if it passes. v1 supports param-free actions only.
argument-hint: <action-name> [--relock]
allowed-tools: Read, mcp__plugin_rn-dev-agent_cdp__cdp_lock_e2e_test
---

Lock the action into a locked e2e test: $ARGUMENTS

Steps:
1. Call `cdp_lock_e2e_test` with `actionId` = the first positional arg (add `relock: true` if `--relock` is present).
2. If it returns `STRICT_RUN_FAILED`, tell the user the action must pass a strict (no-repair) run first — offer to run `cdp_run_action` to repair it, then retry the lock.
3. If it returns `PARAMS_UNSUPPORTED`, explain that v1 supports param-free tests only.
4. On success, report the frozen file path and that it will now be included in `cdp_run_e2e_suite`.
```

- [ ] **Step 2: Ignore run records (keep locked tests tracked)** — add to `.gitignore`:

```gitignore
# E2E regression run records (machine state); locked tests under .rn-agent/e2e/ stay tracked
.rn-agent/state/e2e-runs/
```

- [ ] **Step 3: Add a changeset** — `.changeset/e2e-regression-runner-engine.md`:

```markdown
---
"rn-dev-agent-cdp": minor
---

feat(e2e): regression runner engine — `cdp_lock_e2e_test` promotes a verified (param-free) action into a frozen, executable locked e2e test, and `cdp_run_e2e_suite` runs all locked tests strict (no auto-repair) on the booted sim, persisting a suite-run report with verdict, per-test classification (regression vs infra, params skipped), and a newly-failing-since-last-green diff. Engine only; observe page + CSRF HTTP trigger land in a follow-up.
```

- [ ] **Step 4: Full build + suite + lint/format**

Run: `cd scripts/cdp-bridge && npm test` → expect PASS (entire suite)
Run (repo root): `npm run lint && npm run format:check` → expect clean

- [ ] **Step 5: Commit**

```bash
git add commands/lock-e2e.md .gitignore .changeset/e2e-regression-runner-engine.md scripts/cdp-bridge/dist
git commit -m "feat(e2e): /lock-e2e command, gitignore run records, changeset"
```

---

## Manual device verification (after Task 10)

**Verification tooling (per maintainer):** drive the RN app on the **simulator** via the plugin's own `device_*` / `cdp_*` MCP tools (not `xcrun`/`adb` directly). Any **browser** navigation — i.e. the observe web UI in Plan 2 — is done with **Claude Chrome** browser automation (`mcp__claude-in-chrome__*`), not a headless driver. Plan 1 is engine-only, so its verification is entirely simulator/MCP-tool based; the Claude-Chrome step applies when Plan 2's Regression page exists.

Run once on the booted simulator with Metro up:

1. Lock a known-good **param-free** action: `cdp_lock_e2e_test { actionId: "<id>" }`. Confirm `.rn-agent/e2e/<id>.yaml` appears, contains the `# e2e-locked-test: true` header **and** an executable `appId:` / `---` / steps body.
2. `cdp_run_e2e_suite {}` → `verdict: green`, a record at `.rn-agent/state/e2e-runs/<runId>.json`, an `index.json` entry.
3. Introduce drift (rename a `testID` in the app), re-run → `verdict: red`, the test `classification: regression`, present in `newlyFailing`; the locked file is **unchanged** (no auto-repair).
4. Stop Metro, run → `SETUP_ERROR` (proves the real preflight wiring from Task 9).
5. Try locking a param-needing action → `PARAMS_UNSUPPORTED`.

---

## Self-Review (completed by author, post-amendment)

- **Spec coverage:** lock gate (param-free) → Task 7; strict-on-booted run → Tasks 8–9; treat-as-regression + pre-flight SETUP_ERROR (real wiring) → Tasks 6, 9; suite-run record + diff-vs-last-green → Tasks 3–4, 8; durable request + interrupted recovery + staleness → Tasks 5, 9; executable frozen flow + robust parse → Tasks 1–2, 7; FLOW_TOOLS lease → Task 7; gitignore/changeset/command → Task 10.
- **Placeholder scan:** none.
- **Type consistency:** `LockedE2eTest.flow` (renamed from `body`) used in Tasks 1/2/7/8; `E2eResultClassification` incl. `'skipped'` (Task 3) honored in `computeVerdict`/`diffNewlyFailing`/Task 8; `totals.skipped` in Tasks 3/4/8; `SessionState` imported from `../types.js` in Tasks 7/8; error codes added to `ToolErrorCode` (Task 7) before first use; maestro envelope parsed identically (`readPassed`/`readMaestro`) in Tasks 7/8 incl. `meta.output` timeout path.
- **Review amendments:** all 6 blockers + should-fixes from the multi-LLM review are folded in (see "Amendments applied" at top).

## Known v1 limitations (carried to Plan 2)

- **Param-needing tests unsupported** (lock refuses, suite skips) until the `.rn-agent/e2e.config.json` params source ships.
- **No HTTP trigger / page** — drive via the MCP tools (or `/lock-e2e`).
- **`runFlow:` file-refs** in a locked flow may break (relative paths resolve against `.rn-agent/e2e/`); author self-contained flows. (Plan 2 can expand refs at freeze time.)
- **Android preflight** is device-presence only (no app-installed probe) in v1.
- **Concurrency:** a run holds the exclusive flow lease (stop-the-world) — expected on one booted sim. The durable request guard is the cross-restart/Plan-2-HTTP backstop.
