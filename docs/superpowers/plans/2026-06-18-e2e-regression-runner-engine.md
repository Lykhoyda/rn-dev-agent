# E2E Regression Runner — Engine (Plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the headless engine for E2E regression testing: promote a verified action into a frozen **locked e2e test**, then run all locked tests **strict** (no auto-repair) on the booted simulator and persist a suite-run report — all driven by two new MCP tools (`cdp_lock_e2e_test`, `cdp_run_e2e_suite`).

**Architecture:** Approach C from the spec — a thin orchestrator that reuses the hardened `maestro_run` handler as its inner loop. New `domain/e2e-*.ts` types/persistence mirror the existing `reusable-action`/`action-store` conventions. The two tools are added to `FLOW_TOOLS` so the arbiter grants exactly one exclusive `flow` lease per call; all orchestration lives in lease-free *core* functions (so Plan 2's HTTP endpoint can reuse them). v1 runs on the already-booted dev sim (no isolation) and reloads JS from Metro via `cdp_reload` instead of rebuilding natively.

**Tech Stack:** TypeScript (ESM, Node16 module resolution, strict), `node:test` + `node:assert/strict`, `node:crypto`, `node:child_process`. Reuses `maestro_run`, `device-arbiter`, `reusable-action`, `action-store`, `maestro-error-parser`.

**Spec:** `docs/superpowers/specs/2026-06-18-e2e-regression-runner-design.md`

## Global Constraints

- **Node >= 22 LTS.** TypeScript `strict`. ESM with explicit `.js` import extensions. Use `import type { ... }` for type-only imports (project convention). No unnecessary comments. Single-quote style (oxfmt enforced).
- **Tests live at `scripts/cdp-bridge/test/unit/<name>.test.js`** (top-level only — CI glob `test/unit/*.test.js` is non-recursive, B217). Framework: `node:test` + `node:assert/strict`. Import the code-under-test from **`../../dist/<path>.js`** (compiled), never from `src/`.
- **Build before test:** `npm run build` (runs `tsc`) compiles `src/ → dist/`. `dist/` is tracked in git and must be rebuilt + committed.
- **Test commands** (run from `scripts/cdp-bridge/`): full = `npm test`; single file = `npm run build && node --test 'test/unit/<name>.test.js'`.
- **Changeset:** package name is `rn-dev-agent-cdp`; add a `.changeset/<slug>.md` (`minor` bump for this feature).
- **Path safety:** any id → path must pass `assertValidActionId(id, ctx)` and `assertWithinDir(file, baseDir)` (from `domain/path-safety.js`).
- **projectRoot is threaded explicitly** (arg), falling back to `findProjectRoot()` (from `nav-graph/storage.js`) then `process.cwd()`.
- **Lease rule:** flow-running tools go in `FLOW_TOOLS` (arbiter leases them); *core* functions never acquire a lease and call `createMaestroRunHandler()` directly.
- **MCP results** use `okResult`/`failResult`/`warnResult` from `utils.js` (envelope `{ ok, data?, error?, code?, meta? }` serialized into `content[0].text`).
- **v1 scope:** strict-on-booted, no isolation, no native rebuild, no HTTP endpoint/web page (those are Plan 2).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/domain/e2e-test.ts` | `LockedE2eTest` type; serialize/parse the frozen file header; path helpers; freeze/load/discover IO |
| `src/domain/e2e-run.ts` | `E2eRunRecord` + result types; `classifyFlowResult` (treat-as-regression); verdict; `diffNewlyFailing`; record + index persistence; `lastGreenRunId` |
| `src/domain/e2e-run-request.ts` | Durable run-request + status state machine; `recoverInterruptedRequests` |
| `src/e2e/git-info.ts` | `getGitInfo()` — sha + dirty (injectable exec) |
| `src/e2e/preflight.ts` | `preflight()` gate (Metro/app/runner) + `probeMetro()` |
| `src/tools/lock-e2e-test.ts` | `lockE2eTestCore` + `createLockE2eTestHandler` (verify strict pass → freeze) |
| `src/tools/run-e2e-suite.ts` | `runE2eSuiteCore` + `createRunE2eSuiteHandler` (preflight → reload → loop → classify → record) |
| `src/index.ts` (modify) | register both tools; wire startup interrupted-recovery |
| `src/lifecycle/device-arbiter.ts` (modify) | add both tool names to `FLOW_TOOLS` |
| `commands/lock-e2e.md` | `/lock-e2e <action>` convenience command |
| `.gitignore` (modify) | ignore `.rn-agent/state/e2e-runs/` (machine state); locked tests under `.rn-agent/e2e/` stay tracked |

---

## Task 1: Locked-test serialization + path helpers (pure)

**Files:**
- Create: `scripts/cdp-bridge/src/domain/e2e-test.ts`
- Test: `scripts/cdp-bridge/test/unit/e2e-test-serialize.test.js`

**Interfaces:**
- Produces: `interface LockedE2eTest { id: string; intent: string; sourceActionId: string; lockedAt: string; lockedGitSha: string | null; sourceContentHash: string; status: 'locked'; params?: string[]; appId?: string; body: string; filePath: string }`
- Produces: `serializeLockedTest(meta: Omit<LockedE2eTest,'filePath'>): string`, `parseLockedTest(text: string, filePath: string): LockedE2eTest | null`, `e2eDirFor(projectRoot: string): string`, `e2ePathFor(projectRoot: string, id: string): string`

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
  params: ['PRODUCT_ID'],
  appId: 'com.example.shop',
  body: 'appId: com.example.shop\n- launchApp\n- tapOn: "Add"\n',
};

test('serialize → parse round-trips all lock fields', () => {
  const text = serializeLockedTest(META);
  const parsed = parseLockedTest(text, '/x/.rn-agent/e2e/add-to-cart.yaml');
  assert.equal(parsed.id, 'add-to-cart');
  assert.equal(parsed.sourceActionId, 'add-to-cart');
  assert.equal(parsed.lockedGitSha, 'abc1234');
  assert.equal(parsed.sourceContentHash, 'deadbeef');
  assert.deepEqual(parsed.params, ['PRODUCT_ID']);
  assert.equal(parsed.appId, 'com.example.shop');
  assert.match(parsed.body, /launchApp/);
  assert.equal(parsed.filePath, '/x/.rn-agent/e2e/add-to-cart.yaml');
});

test('parseLockedTest returns null when lock header is missing', () => {
  assert.equal(parseLockedTest('- launchApp\n', '/x/y.yaml'), null);
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
import { join, dirname } from 'node:path';
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
  body: string;
  filePath: string;
}

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
  const lines = [
    `# e2e-locked-test: true`,
    `# id: ${meta.id}`,
    `# intent: ${meta.intent}`,
    `# sourceActionId: ${meta.sourceActionId}`,
    `# lockedAt: ${meta.lockedAt}`,
    `# lockedGitSha: ${meta.lockedGitSha ?? ''}`,
    `# sourceContentHash: ${meta.sourceContentHash}`,
    `# status: locked`,
  ];
  if (meta.appId) lines.push(`# appId: ${meta.appId}`);
  if (meta.params?.length) lines.push(`# params: ${meta.params.join(', ')}`);
  return `${lines.join('\n')}\n${meta.body}`;
}

export function parseLockedTest(text: string, filePath: string): LockedE2eTest | null {
  if (!/^#\s*e2e-locked-test:\s*true\s*$/m.test(text)) return null;
  const field = (k: string): string | undefined => {
    const m = text.match(new RegExp(`^#\\s*${k}:\\s*(.*)$`, 'm'));
    const v = m?.[1]?.trim();
    return v ? v : undefined;
  };
  const id = field('id');
  const intent = field('intent');
  if (!id || !intent) return null;
  const headerEnd = text.lastIndexOf('\n#');
  const bodyStart = text.indexOf('\n', headerEnd + 1);
  const body = bodyStart >= 0 ? text.slice(bodyStart + 1) : '';
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
    body,
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
git commit -m "feat(e2e): locked-test serialize/parse + path helpers"
```

---

## Task 2: Locked-test freeze / load / discover IO

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/e2e-test.ts`
- Test: `scripts/cdp-bridge/test/unit/e2e-test-io.test.js`

**Interfaces:**
- Consumes: `LockedE2eTest`, `e2ePathFor`, `e2eDirFor` (Task 1); `createHash` (node:crypto)
- Produces: `freezeLockedTest(projectRoot, source, ctx): LockedE2eTest` where `source = { id, intent, sourceActionId, body, params?, appId? }` and `ctx = { gitSha: string | null; now: () => Date }`; `loadLockedTest(projectRoot, id): LockedE2eTest | null`; `discoverLockedTests(projectRoot): string[]` (ids, sorted); `hashBody(body: string): string`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/e2e-test-io.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  freezeLockedTest,
  loadLockedTest,
  discoverLockedTests,
  hashBody,
} from '../../dist/domain/e2e-test.js';

function tmpProject() {
  return mkdtempSync(join(tmpdir(), 'e2e-io-'));
}
const SRC = {
  id: 'login',
  intent: 'Log in',
  sourceActionId: 'login',
  body: 'appId: com.x\n- launchApp\n',
  params: ['EMAIL'],
  appId: 'com.x',
};
const CTX = { gitSha: 'sha123', now: () => new Date('2026-06-18T00:00:00Z') };

test('freeze writes a parseable file and returns metadata', () => {
  const root = tmpProject();
  try {
    const locked = freezeLockedTest(root, SRC, CTX);
    assert.equal(locked.id, 'login');
    assert.equal(locked.sourceContentHash, hashBody(SRC.body));
    const onDisk = readFileSync(join(root, '.rn-agent', 'e2e', 'login.yaml'), 'utf8');
    assert.match(onDisk, /# e2e-locked-test: true/);
    const reloaded = loadLockedTest(root, 'login');
    assert.equal(reloaded.intent, 'Log in');
    assert.equal(reloaded.lockedGitSha, 'sha123');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverLockedTests lists ids sorted; load returns null for missing', () => {
  const root = tmpProject();
  try {
    freezeLockedTest(root, { ...SRC, id: 'bbb' }, CTX);
    freezeLockedTest(root, { ...SRC, id: 'aaa' }, CTX);
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
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export interface LockSource {
  id: string;
  intent: string;
  sourceActionId: string;
  body: string;
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
    sourceContentHash: hashBody(source.body),
    status: 'locked',
    params: source.params,
    appId: source.appId,
    body: source.body,
  };
  const text = serializeLockedTest(meta);
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, text, 'utf8');
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
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => f.replace(/\.ya?ml$/i, ''))
    .sort();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/e2e-test-io.test.js'`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/e2e-test.ts scripts/cdp-bridge/dist/domain/e2e-test.js scripts/cdp-bridge/test/unit/e2e-test-io.test.js
git commit -m "feat(e2e): freeze/load/discover locked tests"
```

---

## Task 3: Run-record classification + verdict + diff (pure)

**Files:**
- Create: `scripts/cdp-bridge/src/domain/e2e-run.ts`
- Test: `scripts/cdp-bridge/test/unit/e2e-run-classify.test.js`

**Interfaces:**
- Consumes: `parseMaestroFailure` from `domain/maestro-error-parser.js`
- Produces types: `E2eVerdict = 'green' | 'red' | 'setup_error'`; `E2eResultClassification = 'pass' | 'regression' | 'infra'`; `E2eFlowResult`; `E2eRunRecord`
- Produces fns: `classifyFlowResult(input): E2eFlowResult` where `input = { testId, intent, passed, durationMs, output }`; `computeVerdict(results): E2eVerdict`; `diffNewlyFailing(current: E2eRunRecord, previousGreen: E2eRunRecord | null): string[]`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/e2e-run-classify.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFlowResult,
  computeVerdict,
  diffNewlyFailing,
} from '../../dist/domain/e2e-run.js';

test('passed flow → pass classification', () => {
  const r = classifyFlowResult({ testId: 'a', intent: 'A', passed: true, durationMs: 10, output: '' });
  assert.equal(r.classification, 'pass');
  assert.equal(r.failureKind, undefined);
});

test('selector-not-found failure → regression', () => {
  const r = classifyFlowResult({
    testId: 'a', intent: 'A', passed: false, durationMs: 10,
    output: 'Element not found: id: submitButton',
  });
  assert.equal(r.classification, 'regression');
  assert.equal(r.failureKind, 'SELECTOR_NOT_FOUND');
});

test('timeout failure → still red, annotated as infra', () => {
  const r = classifyFlowResult({
    testId: 'a', intent: 'A', passed: false, durationMs: 99,
    output: 'Timed out waiting for ...',
  });
  assert.equal(r.passed, false);
  assert.equal(r.failureKind, 'TIMEOUT');
  assert.equal(r.infraAnnotation, 'likely-infrastructure (timeout)');
});

test('computeVerdict: any failure → red; all pass → green', () => {
  const pass = { classification: 'pass', passed: true };
  const fail = { classification: 'infra', passed: false };
  assert.equal(computeVerdict([pass, pass]), 'green');
  assert.equal(computeVerdict([pass, fail]), 'red');
});

test('diffNewlyFailing: failing now but passing in last green', () => {
  const prev = { results: [{ testId: 'a', passed: true }, { testId: 'b', passed: true }] };
  const cur = { results: [{ testId: 'a', passed: false }, { testId: 'b', passed: true }] };
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
export type E2eResultClassification = 'pass' | 'regression' | 'infra';

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
  totals: { total: number; passed: number; failed: number };
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

export function computeVerdict(results: Array<{ passed: boolean }>): E2eVerdict {
  return results.some((r) => !r.passed) ? 'red' : 'green';
}

export function diffNewlyFailing(
  current: { results: Array<{ testId: string; passed: boolean }> },
  previousGreen: { results: Array<{ testId: string; passed: boolean }> } | null,
): string[] {
  const wasPassing = new Set(
    (previousGreen?.results ?? []).filter((r) => r.passed).map((r) => r.testId),
  );
  return current.results
    .filter((r) => !r.passed && (previousGreen === null || wasPassing.has(r.testId)))
    .map((r) => r.testId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/e2e-run-classify.test.js'`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/e2e-run.ts scripts/cdp-bridge/dist/domain/e2e-run.js scripts/cdp-bridge/test/unit/e2e-run-classify.test.js
git commit -m "feat(e2e): run-result classification, verdict, newly-failing diff"
```

---

## Task 4: Run-record + index persistence

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/e2e-run.ts`
- Test: `scripts/cdp-bridge/test/unit/e2e-run-store.test.js`

**Interfaces:**
- Consumes: `E2eRunRecord` (Task 3)
- Produces: `e2eRunsDirFor(projectRoot): string`; `writeRunRecord(projectRoot, rec: E2eRunRecord): void` (writes `<runId>.json` + updates `index.json`, bounded 100, newest-first); `loadIndex(projectRoot): E2eRunIndexEntry[]`; `loadRunRecord(projectRoot, runId): E2eRunRecord | null`; `lastGreenRunId(projectRoot): string | null`; type `E2eRunIndexEntry = { runId; finishedAt; verdict; totals }`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/e2e-run-store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeRunRecord,
  loadIndex,
  loadRunRecord,
  lastGreenRunId,
} from '../../dist/domain/e2e-run.js';

function rec(runId, verdict) {
  return {
    runId, startedAt: '2026-06-18T00:00:00Z', finishedAt: '2026-06-18T00:01:00Z',
    durationMs: 60000, gitSha: 'x', gitDirty: false, platform: 'ios', deviceId: 'udid',
    metroReloaded: true, totals: { total: 1, passed: verdict === 'green' ? 1 : 0, failed: verdict === 'green' ? 0 : 1 },
    verdict, results: [], previousGreenRunId: null,
  };
}

test('writeRunRecord persists record + index; lastGreenRunId finds newest green', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-store-'));
  try {
    writeRunRecord(root, rec('r1', 'green'));
    writeRunRecord(root, rec('r2', 'red'));
    writeRunRecord(root, rec('r3', 'green'));
    const idx = loadIndex(root);
    assert.equal(idx.length, 3);
    assert.equal(idx[0].runId, 'r3'); // newest-first
    assert.equal(loadRunRecord(root, 'r2').verdict, 'red');
    assert.equal(lastGreenRunId(root), 'r3');
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
  totals: { total: number; passed: number; failed: number };
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

Note: `runId` must be a slug accepted by `assertValidActionId` (regex `^[A-Za-z0-9][A-Za-z0-9_.-]*$`). Task 8/10 generate it as `run-<ISO-compact>-<rand>` using only those chars.

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
- Produces: `E2eRunStatus = 'requested' | 'reloading' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'`; `E2eRunRequest`; `writeRequest(projectRoot, req): void`; `updateRequest(projectRoot, runId, patch): E2eRunRequest | null`; `loadRequest(projectRoot, runId): E2eRunRequest | null`; `listRequests(projectRoot): E2eRunRequest[]`; `recoverInterruptedRequests(projectRoot, isPidAlive: (pid: number) => boolean, now: () => Date): string[]` (marks non-terminal requests with dead pid as `interrupted`, returns affected runIds)

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

test('write → update → load reflects status transitions', () => {
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

test('recover marks running-with-dead-pid as interrupted; leaves live + terminal alone', () => {
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

const TERMINAL: ReadonlySet<E2eRunStatus> = new Set(['done', 'failed', 'cancelled', 'interrupted']);

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
    if (TERMINAL.has(r.status)) continue;
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
- Produces: `getGitInfo(projectRoot, exec?): { sha: string | null; dirty: boolean }` where `exec = (cmd, args) => string`
- Produces: `preflight(input): { ok: true } | { ok: false; code: 'SETUP_ERROR'; detail: string }` where `input = { platform; udid: string | null; appId?: string; metroReachable: boolean; appInstalled: boolean | null }`

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/e2e-preflight.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGitInfo } from '../../dist/e2e/git-info.js';
import { preflight } from '../../dist/e2e/preflight.js';

test('getGitInfo parses sha + dirty from injected exec', () => {
  const exec = (_cmd, args) =>
    args[0] === 'rev-parse' ? 'abc1234\n' : ' M file.ts\n';
  assert.deepEqual(getGitInfo('/x', exec), { sha: 'abc1234', dirty: true });
});

test('getGitInfo: clean tree → dirty false; failure → sha null', () => {
  const clean = (_c, args) => (args[0] === 'rev-parse' ? 'def5678\n' : '');
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

test('preflight SETUP_ERROR when metro down or no device or app missing', () => {
  assert.equal(preflight({ platform: 'ios', udid: 'u', metroReachable: false, appInstalled: true }).code, 'SETUP_ERROR');
  assert.equal(preflight({ platform: 'ios', udid: null, metroReachable: true, appInstalled: true }).code, 'SETUP_ERROR');
  assert.equal(preflight({ platform: 'ios', udid: 'u', metroReachable: true, appInstalled: false }).code, 'SETUP_ERROR');
  // unknown (null) app-installed is tolerated (probe couldn't tell)
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

export type PreflightResult =
  | { ok: true }
  | { ok: false; code: 'SETUP_ERROR'; detail: string };

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
    const req = request({ host: '127.0.0.1', port, path: '/status', method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
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

## Task 7: Lock tool (`cdp_lock_e2e_test`)

**Files:**
- Create: `scripts/cdp-bridge/src/tools/lock-e2e-test.ts`
- Modify: `scripts/cdp-bridge/src/index.ts` (register tool)
- Modify: `scripts/cdp-bridge/src/lifecycle/device-arbiter.ts` (add to `FLOW_TOOLS`)
- Test: `scripts/cdp-bridge/test/unit/lock-e2e-test.test.js`

**Interfaces:**
- Consumes: `loadAction` (`domain/action-store.js`); `freezeLockedTest`, `loadLockedTest` (`domain/e2e-test.js`); `getGitInfo` (`e2e/git-info.js`); `getActiveSession` (`agent-device-wrapper.js`); `createMaestroRunHandler` (`tools/maestro-run.js`); `okResult`/`failResult` (`utils.js`)
- Produces: `lockE2eTestCore(args, deps): Promise<ToolResult>` and `createLockE2eTestHandler(deps?)`. `args = { actionId: string; relock?: boolean; projectRoot?: string }`. `deps = { maestroRun?; loadAction?; getGitInfo?; getSession?; now? }` (all injectable for tests)

- [ ] **Step 1: Write the failing test**

```javascript
// test/unit/lock-e2e-test.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockE2eTestCore } from '../../dist/tools/lock-e2e-test.js';

function parse(result) { return JSON.parse(result.content[0].text); }

function seedAction(root, id) {
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.yaml`),
    `# id: ${id}\n# intent: do a thing\n# status: active\n# appId: com.x\nappId: com.x\n- launchApp\n`,
    'utf8',
  );
}
const okMaestro = async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { passed: true, output: 'Flow PASSED' } }) }] });
const failMaestro = async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'Element not found: id: x', meta: { output: 'Element not found: id: x' } }) }], isError: true });
const deps = (maestroRun) => ({
  maestroRun,
  getGitInfo: () => ({ sha: 'sha1', dirty: false }),
  getSession: () => ({ name: 's', platform: 'ios', deviceId: 'udid', appId: 'com.x', openedAt: '' }),
  now: () => new Date('2026-06-18T00:00:00Z'),
});

test('strict pass → freezes a locked test', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-'));
  try {
    seedAction(root, 'login');
    const res = parse(await lockE2eTestCore({ actionId: 'login', projectRoot: root }, deps(okMaestro)));
    assert.equal(res.ok, true);
    assert.equal(res.data.locked, true);
    assert.ok(existsSync(join(root, '.rn-agent', 'e2e', 'login.yaml')));
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
    assert.match(res.error, /pass.*strict/i);
    assert.equal(existsSync(join(root, '.rn-agent', 'e2e', 'login.yaml')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('already locked → refuses unless relock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-'));
  try {
    seedAction(root, 'login');
    await lockE2eTestCore({ actionId: 'login', projectRoot: root }, deps(okMaestro));
    const dup = parse(await lockE2eTestCore({ actionId: 'login', projectRoot: root }, deps(okMaestro)));
    assert.equal(dup.ok, false);
    assert.match(dup.error, /already locked/i);
    const re = parse(await lockE2eTestCore({ actionId: 'login', projectRoot: root, relock: true }, deps(okMaestro)));
    assert.equal(re.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing action → refuses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-'));
  try {
    const res = parse(await lockE2eTestCore({ actionId: 'nope', projectRoot: root }, deps(okMaestro)));
    assert.equal(res.ok, false);
    assert.match(res.error, /not found/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/lock-e2e-test.test.js'`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tools/lock-e2e-test.ts
import { loadAction } from '../domain/action-store.js';
import { freezeLockedTest, loadLockedTest } from '../domain/e2e-test.js';
import { getGitInfo as realGetGitInfo } from '../e2e/git-info.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { createMaestroRunHandler } from './maestro-run.js';
import { findProjectRoot } from '../nav-graph/storage.js';
import { okResult, failResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import type { SessionState } from '../agent-device-wrapper.js';

export interface LockE2eTestArgs {
  actionId: string;
  relock?: boolean;
  projectRoot?: string;
}

export interface LockE2eTestDeps {
  maestroRun?: (args: Record<string, unknown>) => Promise<ToolResult>;
  loadAction?: typeof loadAction;
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
    const passed = env.ok === true && env.data?.passed === true;
    const output = env.data?.output ?? env.meta?.output ?? env.error ?? '';
    return { passed, output };
  } catch {
    return { passed: false, output: 'unparseable maestro result' };
  }
}

export async function lockE2eTestCore(args: LockE2eTestArgs, deps: LockE2eTestDeps = {}): Promise<ToolResult> {
  const projectRoot = args.projectRoot ?? findProjectRoot() ?? process.cwd();
  const load = deps.loadAction ?? loadAction;
  const getGit = deps.getGitInfo ?? realGetGitInfo;
  const getSession = deps.getSession ?? getActiveSession;
  const now = deps.now ?? (() => new Date());
  const maestroRun = deps.maestroRun ?? createMaestroRunHandler();

  const action = load(projectRoot, args.actionId);
  if (!action) return failResult(`Action '${args.actionId}' not found`, 'NOT_FOUND');

  if (!args.relock && loadLockedTest(projectRoot, args.actionId)) {
    return failResult(`'${args.actionId}' is already locked — pass relock:true to re-lock`, 'ALREADY_LOCKED');
  }

  const session = getSession();
  const platform = (session?.platform as 'ios' | 'android' | undefined) ?? undefined;

  const result = await maestroRun({
    flowPath: action.filePath,
    platform,
    params: paramsFromMetadata(action.metadata.params),
  });
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
      body: action.body,
      params: action.metadata.params,
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

function paramsFromMetadata(params?: string[]): Record<string, string> | undefined {
  return params?.length ? Object.fromEntries(params.map((p) => [p, ''])) : undefined;
}

export function createLockE2eTestHandler(deps: LockE2eTestDeps = {}) {
  return (args: LockE2eTestArgs): Promise<ToolResult> => lockE2eTestCore(args, deps);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/lock-e2e-test.test.js'`
Expected: PASS (4 tests)

- [ ] **Step 5: Register the tool + mark it a flow tool**

In `src/lifecycle/device-arbiter.ts`, add the two new tool names to the `FLOW_TOOLS` set literal:

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

In `src/index.ts`, near the other `trackedTool(...)` registrations, add (mirror the existing call shape; import `z` is already in scope, and import the handler at the top of the file):

```typescript
import { createLockE2eTestHandler } from './tools/lock-e2e-test.js';
// ...
trackedTool(
  'cdp_lock_e2e_test',
  'Promote a verified action into a frozen, locked e2e regression test. Runs the action once strict (no repair); freezes it only if it passes.',
  {
    actionId: z.string().describe('The action id under .rn-agent/actions to lock'),
    relock: z.boolean().optional().describe('Overwrite an existing locked test'),
    projectRoot: z.string().optional(),
  },
  createLockE2eTestHandler(),
);
```

- [ ] **Step 6: Build + full suite, then commit**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS (whole suite incl. the new file)

```bash
git add scripts/cdp-bridge/src/tools/lock-e2e-test.ts scripts/cdp-bridge/src/index.ts scripts/cdp-bridge/src/lifecycle/device-arbiter.ts scripts/cdp-bridge/dist scripts/cdp-bridge/test/unit/lock-e2e-test.test.js
git commit -m "feat(e2e): cdp_lock_e2e_test — verify strict pass, freeze locked test"
```

---

## Task 8: Suite orchestrator core (discover → run → classify → record)

**Files:**
- Create: `scripts/cdp-bridge/src/tools/run-e2e-suite.ts`
- Test: `scripts/cdp-bridge/test/unit/run-e2e-suite-core.test.js`

**Interfaces:**
- Consumes: `discoverLockedTests`, `loadLockedTest` (`domain/e2e-test.js`); `classifyFlowResult`, `computeVerdict`, `diffNewlyFailing`, `writeRunRecord`, `loadRunRecord`, `lastGreenRunId` (`domain/e2e-run.js`); `getGitInfo`; `getActiveSession`; `createMaestroRunHandler`
- Produces: `runE2eSuiteCore(args, deps): Promise<ToolResult>`; `makeRunId(now: () => Date, rand: () => string): string`. `args = { pattern?; projectRoot?; deviceId? }`. `deps` injects every collaborator (maestroRun, discover, load, writeRunRecord, lastGreenRunId, loadRunRecord, getGitInfo, getSession, now, makeRunId, runReload, preflightCheck) — defaults wire the real ones.

This task covers the **happy path only** (preflight assumed ok, reload skipped). Task 9 adds preflight + reload + single-slot + request lifecycle.

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
const passEnv = (out = 'Flow PASSED') => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { passed: true, output: out } }) }] });
const failEnv = (out) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: out, meta: { output: out } }) }], isError: true });

function baseDeps(root, maestroByTest) {
  return {
    discover: () => ['login', 'checkout'],
    load: (_root, id) => ({ id, intent: `do ${id}`, body: '- launchApp\n', params: [], appId: 'com.x', filePath: `/x/${id}.yaml`, status: 'locked', sourceActionId: id, lockedAt: '', lockedGitSha: null, sourceContentHash: '' }),
    maestroRun: async (a) => maestroByTest(a.flowPath),
    getGitInfo: () => ({ sha: 's', dirty: false }),
    getSession: () => ({ name: 's', platform: 'ios', deviceId: 'udid', appId: 'com.x', openedAt: '' }),
    now: () => new Date('2026-06-18T00:00:00Z'),
    makeRunId: () => 'run-test-1',
    runReload: async () => false,
    preflightCheck: async () => ({ ok: true }),
  };
}

test('all pass → verdict green, record persisted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-'));
  try {
    const res = parse(await runE2eSuiteCore({ projectRoot: root }, baseDeps(root, () => passEnv())));
    assert.equal(res.ok, true);
    assert.equal(res.data.verdict, 'green');
    assert.equal(res.data.totals.passed, 2);
    assert.equal(loadIndex(root)[0].verdict, 'green');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one selector failure → verdict red, classified regression, newlyFailing listed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-'));
  try {
    const byTest = (fp) => (fp.includes('checkout') ? failEnv('Element not found: id: payBtn') : passEnv());
    const res = parse(await runE2eSuiteCore({ projectRoot: root }, baseDeps(root, byTest)));
    assert.equal(res.data.verdict, 'red');
    assert.equal(res.data.totals.failed, 1);
    const checkout = res.data.results.find((r) => r.testId === 'checkout');
    assert.equal(checkout.classification, 'regression');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty suite → green with zero totals + a note', async () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-'));
  try {
    const deps = { ...baseDeps(root, () => passEnv()), discover: () => [] };
    const res = parse(await runE2eSuiteCore({ projectRoot: root }, deps));
    assert.equal(res.data.verdict, 'green');
    assert.equal(res.data.totals.total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('makeRunId produces a path-safe slug', () => {
  const id = makeRunId(() => new Date('2026-06-18T12:34:56Z'), () => 'ab12');
  assert.match(id, /^run-[0-9TZ-]+-ab12$/);
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
import { okResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import type { SessionState } from '../agent-device-wrapper.js';

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
  preflightCheck?: () => Promise<{ ok: true } | { ok: false; code: 'SETUP_ERROR'; detail: string }>;
}

export function makeRunId(now: () => Date, rand: () => string): string {
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  return `run-${stamp}-${rand()}`;
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
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    return ids;
  }
  return ids.filter((id) => re.test(id));
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

  const runId = mkRunId(now, rand);
  const startedAt = now().toISOString();
  const startMs = now().getTime();
  const session = getSession();
  const platform = session?.platform ?? 'ios';
  const deviceId = args.deviceId ?? session?.deviceId ?? null;
  const git = getGit(projectRoot);

  const metroReloaded = deps.runReload ? await deps.runReload() : false;

  const ids = filterByPattern(discover(projectRoot), args.pattern);
  const results: E2eFlowResult[] = [];
  for (const id of ids) {
    const locked = load(projectRoot, id);
    if (!locked) continue;
    const t0 = now().getTime();
    const result = await maestroRun({
      flowPath: locked.filePath,
      platform: platform as 'ios' | 'android',
      params: paramsFor(locked.params),
    });
    const { passed, output } = readMaestro(result);
    results.push(
      classifyFlowResult({
        testId: id,
        intent: locked.intent,
        passed,
        durationMs: now().getTime() - t0,
        output,
      }),
    );
  }

  const verdict = computeVerdict(results);
  const prevGreenId = lastGreenRunId(projectRoot);
  const prevGreen = prevGreenId ? loadRunRecord(projectRoot, prevGreenId) : null;
  const finishedAt = now().toISOString();
  const record: E2eRunRecord = {
    runId,
    startedAt,
    finishedAt,
    durationMs: now().getTime() - startMs,
    gitSha: git.sha,
    gitDirty: git.dirty,
    platform,
    deviceId,
    metroReloaded,
    totals: {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
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

function paramsFor(params?: string[]): Record<string, string> | undefined {
  return params?.length ? Object.fromEntries(params.map((p) => [p, ''])) : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/run-e2e-suite-core.test.js'`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/run-e2e-suite.ts scripts/cdp-bridge/dist scripts/cdp-bridge/test/unit/run-e2e-suite-core.test.js
git commit -m "feat(e2e): suite orchestrator core (discover/run/classify/record)"
```

---

## Task 9: Orchestrator pre-flight + reload + single-slot guard + request lifecycle + tool registration

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/run-e2e-suite.ts` (add the handler wrapper)
- Modify: `scripts/cdp-bridge/src/index.ts` (register tool + startup recovery)
- Test: `scripts/cdp-bridge/test/unit/run-e2e-suite-guard.test.js`

**Interfaces:**
- Consumes: Task 8 `runE2eSuiteCore`; `writeRequest`/`updateRequest`/`loadRequest`/`listRequests` (`domain/e2e-run-request.js`)
- Produces: `createRunE2eSuiteHandler(deps?)` that wraps `runE2eSuiteCore` with: (a) a single-slot guard (refuse `E2E_RUN_ACTIVE` if a non-terminal request exists for a live pid), (b) a durable request written before/updated during/after, (c) a pre-flight gate returning `SETUP_ERROR`. Produces `isRunActive(projectRoot, isPidAlive): boolean`.

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
const baseDeps = (over = {}) => ({
  discover: () => [],
  getGitInfo: () => ({ sha: 's', dirty: false }),
  getSession: () => ({ name: 's', platform: 'ios', deviceId: 'udid', appId: 'com.x', openedAt: '' }),
  now: () => new Date('2026-06-18T00:00:00Z'),
  makeRunId: () => 'run-guard-1',
  runReload: async () => false,
  preflightCheck: async () => ({ ok: true }),
  isPidAlive: () => true,
  ...over,
});

test('pre-flight failure → SETUP_ERROR, no run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    const handler = createRunE2eSuiteHandler(baseDeps({ preflightCheck: async () => ({ ok: false, code: 'SETUP_ERROR', detail: 'Metro down' }) }));
    const res = parse(await handler({ projectRoot: root }));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SETUP_ERROR');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('single-slot guard → refuses when a live run is in progress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    writeRequest(root, { runId: 'run-existing', status: 'running', pid: process.pid, createdAt: '', updatedAt: '' });
    const handler = createRunE2eSuiteHandler(baseDeps({ isPidAlive: (pid) => pid === process.pid }));
    const res = parse(await handler({ projectRoot: root }));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'E2E_RUN_ACTIVE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('happy path → writes request and ends in done', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    const handler = createRunE2eSuiteHandler(baseDeps());
    const res = parse(await handler({ projectRoot: root }));
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
import {
  writeRequest,
  updateRequest,
  listRequests,
} from '../domain/e2e-run-request.js';
import { failResult } from '../utils.js';

export interface RunE2eSuiteHandlerDeps extends RunE2eSuiteDeps {
  isPidAlive?: (pid: number) => boolean;
}

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted']);

export function isRunActive(projectRoot: string, isPidAlive: (pid: number) => boolean): boolean {
  return listRequests(projectRoot).some((r) => !TERMINAL.has(r.status) && isPidAlive(r.pid));
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

    if (isRunActive(projectRoot, isPidAlive)) {
      return failResult('An e2e run is already in progress', 'E2E_RUN_ACTIVE');
    }

    const preflightCheck =
      deps.preflightCheck ?? (async () => ({ ok: true as const }));
    const pre = await preflightCheck();
    if (!pre.ok) return failResult(pre.detail, 'SETUP_ERROR');

    const rand = (): string => Math.random().toString(36).slice(2, 8);
    const runId = (deps.makeRunId ?? makeRunId)(now, rand);
    const ts = now().toISOString();
    writeRequest(projectRoot, {
      runId,
      status: 'running',
      pid: process.pid,
      createdAt: ts,
      updatedAt: ts,
      pattern: args.pattern,
    });

    try {
      // reuse the same runId so request + record line up
      const result = await runE2eSuiteCore(args, { ...deps, makeRunId: () => runId });
      updateRequest(projectRoot, runId, { status: 'done', updatedAt: now().toISOString() });
      return result;
    } catch (err) {
      updateRequest(projectRoot, runId, { status: 'failed', updatedAt: now().toISOString() });
      const msg = err instanceof Error ? err.message : String(err);
      return failResult(`e2e run crashed: ${msg}`, 'E2E_RUN_CRASHED');
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/run-e2e-suite-guard.test.js'`
Expected: PASS (3 tests)

- [ ] **Step 5: Register the tool + startup recovery**

In `src/index.ts`, add the import + `trackedTool` registration (it's already in `FLOW_TOOLS` from Task 7):

```typescript
import { createRunE2eSuiteHandler } from './tools/run-e2e-suite.js';
import { recoverInterruptedRequests } from './domain/e2e-run-request.js';
// ...
trackedTool(
  'cdp_run_e2e_suite',
  'Run all locked e2e tests strict (no repair) on the booted sim; persist a suite-run report with verdict + per-test results.',
  {
    pattern: z.string().optional().describe('Regex filter over locked-test ids'),
    projectRoot: z.string().optional(),
    deviceId: z.string().optional(),
  },
  createRunE2eSuiteHandler(),
);
```

Then, in the server startup path (after `findProjectRoot()` is available — mirror where other one-time startup work runs), add the interrupted-run sweep:

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

- [ ] **Step 6: Build + full suite, then commit**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS (whole suite)

```bash
git add scripts/cdp-bridge/src/tools/run-e2e-suite.ts scripts/cdp-bridge/src/index.ts scripts/cdp-bridge/dist scripts/cdp-bridge/test/unit/run-e2e-suite-guard.test.js
git commit -m "feat(e2e): cdp_run_e2e_suite handler — preflight, single-slot, request lifecycle, startup recovery"
```

---

## Task 10: Wiring — `/lock-e2e` command, .gitignore, changeset, docs

**Files:**
- Create: `commands/lock-e2e.md`
- Modify: `.gitignore`
- Create: `.changeset/e2e-regression-runner-engine.md`
- Modify: `CLAUDE.md` (tool count + one-line mention) — optional but keep counts honest

- [ ] **Step 1: Create the `/lock-e2e` command** (mirror the frontmatter of an existing command such as `commands/run-action.md`; verify keys against that file)

```markdown
---
description: Promote a verified action into a frozen, locked e2e regression test (runs it strict once; freezes only on pass).
---

Lock the action **$1** into a locked e2e test.

Steps:
1. Call the `cdp_lock_e2e_test` MCP tool with `actionId: "$1"` (add `relock: true` if the user asked to re-lock).
2. If it returns `STRICT_RUN_FAILED`, tell the user the action must pass a strict (no-repair) run first — offer to run `cdp_run_action` to repair it, then retry the lock.
3. On success, report the frozen file path and that it will now be included in `cdp_run_e2e_suite`.
```

- [ ] **Step 2: Ignore run records (keep locked tests tracked)**

Add to `.gitignore`:

```gitignore
# E2E regression run records (machine state); locked tests under .rn-agent/e2e/ stay tracked
.rn-agent/state/e2e-runs/
```

- [ ] **Step 3: Add a changeset**

```markdown
---
"rn-dev-agent-cdp": minor
---

feat(e2e): regression runner engine — `cdp_lock_e2e_test` promotes a verified action into a frozen locked e2e test, and `cdp_run_e2e_suite` runs all locked tests strict (no auto-repair) on the booted sim, persisting a suite-run report with verdict, per-test classification (regression vs infra), and a newly-failing-since-last-green diff. Engine only; observe page + HTTP trigger land in a follow-up.
```

- [ ] **Step 4: Full build + suite + lint/format**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS (entire suite)
Run (repo root): `npm run lint && npm run format:check` (oxlint + oxfmt gate)
Expected: clean

- [ ] **Step 5: Commit**

```bash
git add commands/lock-e2e.md .gitignore .changeset/e2e-regression-runner-engine.md CLAUDE.md scripts/cdp-bridge/dist
git commit -m "feat(e2e): /lock-e2e command, gitignore run records, changeset"
```

---

## Manual device verification (after Task 10)

Not a unit test — run once on the booted simulator with Metro up:

1. Lock a known-good action: invoke `cdp_lock_e2e_test { actionId: "<an-existing-passing-action>" }`. Confirm `.rn-agent/e2e/<id>.yaml` appears with the `# e2e-locked-test: true` header.
2. Run the suite: invoke `cdp_run_e2e_suite {}`. Confirm `verdict: green`, a record at `.rn-agent/state/e2e-runs/<runId>.json`, and an `index.json` entry.
3. Introduce drift (rename a `testID` in the app or edit the locked YAML's selector to something absent), re-run: confirm `verdict: red`, the test classified `regression`, and it appears in `newlyFailing`. Confirm the locked file was **not** auto-repaired (its selector is unchanged).
4. Stop Metro and run the suite: confirm `SETUP_ERROR` (not a misleading red/green).

---

## Self-Review (completed by author)

- **Spec coverage:** lifecycle/lock gate → Task 7; strict-on-booted run → Tasks 8–9; treat-as-regression + pre-flight SETUP_ERROR → Tasks 3, 6, 9; suite-run record + diff-vs-last-green → Tasks 3–4, 8; durable request + interrupted recovery → Tasks 5, 9; locked-test freeze format → Tasks 1–2; FLOW_TOOLS lease → Task 7; gitignore/changeset/command → Task 10. **Deferred to Plan 2 (per spec):** CSRF HTTP endpoint + observe Regression page; params from `.rn-agent/e2e.config.json` (v1 sends empty values → param-needing tests should be authored param-free or will surface as failures until Plan 2 — noted as a known v1 limitation); in-page Promote/Re-lock buttons + `cdp_list_e2e_tests` (v1.1).
- **Placeholder scan:** none — every step has real code/commands.
- **Type consistency:** `LockedE2eTest`, `E2eRunRecord`, `E2eFlowResult`, `E2eRunRequest`, `runE2eSuiteCore`/`createRunE2eSuiteHandler`, `lockE2eTestCore`, `freezeLockedTest`, `writeRunRecord`, `recoverInterruptedRequests` used consistently across tasks. Maestro envelope parsed identically in Tasks 7 & 8 (`readPassed`/`readMaestro`).

## Known v1 limitations (carried to Plan 2)

- **Params:** locked tests requiring `${VAR}` get empty values in v1 (no `e2e.config.json` yet) — they may fail until Plan 2 adds the params source + redaction. Author v1 locked tests to be self-contained.
- **No HTTP trigger / page:** drive via the MCP tools (or `/lock-e2e`) until Plan 2.
- **Concurrency:** a suite run holds the exclusive flow lease (stop-the-world) — expected on a single booted sim.
