# GH #91 — Mutation-Absence Detector: Per-Project Config Override (Acceptance Closeout)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the per-project config override (`.rn-agent/config.json` → `verification.successShapes` and `verification.mutationMethods`) that closes acceptance criterion #3 of issue #91 ("Per-project config override works"). The detector itself shipped in `fed0dd0` (Apr 28) — this PR closes the remaining acceptance gap so the issue can be closed.

**Architecture:** A new `loadVerificationConfig(projectRoot)` helper reads `.rn-agent/config.json` once per process and caches the result. The cached config is consumed by `annotateMutationAbsence` via the existing `AnnotateContext`. Defaults are preserved on missing-file, parse-error, or empty-arrays so apps that don't opt in see zero behavior change.

**Tech Stack:** TypeScript, Node.js fs sync APIs (matching the existing `project-config.ts` pattern), `node:test` for unit tests.

**Out of scope (documented in PR body):**
- Wiring `device_press` / `cdp_interact` (intentionally deferred in the original `fed0dd0` commit message — these tools don't carry nav-state intent and adding nav-state fetches per tap is expensive; the signal is captured downstream by `cdp_navigation_state`).
- Migrating to a `verification_warnings` array. v1 single-slot is documented as v1-only in `envelope.ts` and remains correct until two detectors hit the same call site.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/cdp-bridge/src/verification/config.ts` | Create | Load + cache `.rn-agent/config.json` verification block; expose typed accessors with defaults. |
| `scripts/cdp-bridge/src/verification/mutation-absence.ts` | Modify | Accept optional `successShapes` and `mutationMethods` via `AnnotateContext`; build per-call regex/Set using config; preserve existing defaults when override is empty/missing. |
| `scripts/cdp-bridge/src/tools/navigation-state.ts` | Modify | Load config once at module init, pass to `annotateMutationAbsence`. |
| `scripts/cdp-bridge/src/tools/proof-step.ts` | Modify | Same — pass config-derived overrides through `AnnotateContext`. |
| `scripts/cdp-bridge/src/index.ts` | Modify | `cdp_navigate` wiring at line ~380 — pass config-derived overrides. |
| `scripts/cdp-bridge/test/unit/gh-91-verification-config.test.js` | Create | Unit tests for `loadVerificationConfig` (missing file, malformed JSON, partial keys, invalid regex strings, cache behavior). |
| `scripts/cdp-bridge/test/unit/gh-91-mutation-absence.test.js` | Modify | Add tests for the integration path: `annotateMutationAbsence` honors `successShapes`/`mutationMethods` overrides; defaults preserved when both undefined. |
| `CHANGELOG.md` | Modify | Add 0.44.37 / cdp-bridge 0.38.32 entry. |
| `scripts/cdp-bridge/package.json` | Modify | Bump version to 0.38.32. |
| `.claude-plugin/plugin.json` | Modify | Bump plugin version to 0.44.37. |

---

## Task 1: Add `verification/config.ts` loader (TDD)

**Files:**
- Create: `scripts/cdp-bridge/src/verification/config.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-91-verification-config.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/cdp-bridge/test/unit/gh-91-verification-config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MOD_PATH = '../../dist/verification/config.js';

function makeProject(contents) {
  const root = mkdtempSync(join(tmpdir(), 'rn-agent-cfg-'));
  if (contents !== undefined) {
    mkdirSync(join(root, '.rn-agent'), { recursive: true });
    writeFileSync(join(root, '.rn-agent', 'config.json'), contents);
  }
  return root;
}

test('loadVerificationConfig returns defaults when projectRoot is null', async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const cfg = loadVerificationConfig(null);
  assert.equal(cfg.successShapes, null);
  assert.equal(cfg.mutationMethods, null);
});

test('loadVerificationConfig returns defaults when config file does not exist', async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(undefined);
  try {
    const cfg = loadVerificationConfig(root);
    assert.equal(cfg.successShapes, null);
    assert.equal(cfg.mutationMethods, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadVerificationConfig parses successShapes regex array', async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(JSON.stringify({ verification: { successShapes: ['Receipt$', '^Thanks'] } }));
  try {
    const cfg = loadVerificationConfig(root);
    assert.ok(cfg.successShapes instanceof RegExp);
    assert.ok(cfg.successShapes.test('OrderReceipt'));
    assert.ok(cfg.successShapes.test('ThanksScreen'));
    assert.ok(!cfg.successShapes.test('Login'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadVerificationConfig parses mutationMethods array uppercased and trimmed', async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(JSON.stringify({ verification: { mutationMethods: ['options', ' Query ', 'POST'] } }));
  try {
    const cfg = loadVerificationConfig(root);
    assert.ok(cfg.mutationMethods instanceof Set);
    assert.ok(cfg.mutationMethods.has('OPTIONS'));
    assert.ok(cfg.mutationMethods.has('QUERY'));
    assert.ok(cfg.mutationMethods.has('POST'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadVerificationConfig returns defaults on malformed JSON (never throws)', async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject('{not valid json');
  try {
    const cfg = loadVerificationConfig(root);
    assert.equal(cfg.successShapes, null);
    assert.equal(cfg.mutationMethods, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadVerificationConfig returns defaults when verification block is missing', async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(JSON.stringify({ unrelated: { foo: 'bar' } }));
  try {
    const cfg = loadVerificationConfig(root);
    assert.equal(cfg.successShapes, null);
    assert.equal(cfg.mutationMethods, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadVerificationConfig drops invalid regex strings, keeps valid ones', async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(JSON.stringify({ verification: { successShapes: ['Valid$', '[invalid('] } }));
  try {
    const cfg = loadVerificationConfig(root);
    assert.ok(cfg.successShapes instanceof RegExp);
    assert.ok(cfg.successShapes.test('OrderValid'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadVerificationConfig returns null for successShapes when ALL regex strings are invalid', async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(JSON.stringify({ verification: { successShapes: ['[invalid('] } }));
  try {
    const cfg = loadVerificationConfig(root);
    assert.equal(cfg.successShapes, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadVerificationConfig caches result per projectRoot', async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(JSON.stringify({ verification: { successShapes: ['Foo$'] } }));
  try {
    const cfg1 = loadVerificationConfig(root);
    const cfg2 = loadVerificationConfig(root);
    assert.strictEqual(cfg1, cfg2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadVerificationConfig ignores empty arrays (falls back to defaults)', async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(JSON.stringify({ verification: { successShapes: [], mutationMethods: [] } }));
  try {
    const cfg = loadVerificationConfig(root);
    assert.equal(cfg.successShapes, null);
    assert.equal(cfg.mutationMethods, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail (no module yet)**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-91-verification-config.test.js`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `verification/config.ts`**

```typescript
// scripts/cdp-bridge/src/verification/config.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// GH #91 acceptance #3: per-project override for the mutation-absence
// detector. Reads `.rn-agent/config.json` once per project root and caches
// the result. Defaults are preserved when:
//   - projectRoot is null (no rooted project found)
//   - the config file is missing
//   - JSON parsing fails
//   - the `verification` block is missing
//   - arrays are empty
//   - every regex string is invalid
// In other words: opting-in is the only way to change behavior.

export interface VerificationConfig {
  /** Compiled OR-of-patterns regex from successShapes[]; null = use built-in default. */
  successShapes: RegExp | null;
  /** Uppercased Set of method names from mutationMethods[]; null = use built-in default. */
  mutationMethods: Set<string> | null;
}

const DEFAULTS: VerificationConfig = { successShapes: null, mutationMethods: null };

const cache = new Map<string, VerificationConfig>();

function compileShapes(raw: unknown): RegExp | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const valid: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    try {
      // eslint-disable-next-line no-new
      new RegExp(entry);
      valid.push(entry);
    } catch {
      continue;
    }
  }
  if (valid.length === 0) return null;
  try {
    return new RegExp(valid.map(s => `(?:${s})`).join('|'), 'i');
  } catch {
    return null;
  }
}

function parseMethods(raw: unknown): Set<string> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim().toUpperCase();
    if (trimmed.length > 0) out.add(trimmed);
  }
  return out.size > 0 ? out : null;
}

export function loadVerificationConfig(projectRoot: string | null): VerificationConfig {
  if (!projectRoot) return DEFAULTS;
  const cached = cache.get(projectRoot);
  if (cached) return cached;

  const path = join(projectRoot, '.rn-agent', 'config.json');
  if (!existsSync(path)) {
    cache.set(projectRoot, DEFAULTS);
    return DEFAULTS;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    cache.set(projectRoot, DEFAULTS);
    return DEFAULTS;
  }
  const verification = (raw as { verification?: unknown })?.verification;
  if (!verification || typeof verification !== 'object') {
    cache.set(projectRoot, DEFAULTS);
    return DEFAULTS;
  }
  const v = verification as { successShapes?: unknown; mutationMethods?: unknown };
  const cfg: VerificationConfig = {
    successShapes: compileShapes(v.successShapes),
    mutationMethods: parseMethods(v.mutationMethods),
  };
  cache.set(projectRoot, cfg);
  return cfg;
}

/** Test seam: clear the per-root cache so tests can re-read fixtures. Not exported via index.ts. */
export function _resetCacheForTests(): void {
  cache.clear();
}
```

- [ ] **Step 4: Build + run tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-91-verification-config.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/verification/config.ts scripts/cdp-bridge/test/unit/gh-91-verification-config.test.js
git commit -m "feat(gh-91): verification config loader for per-project overrides"
```

---

## Task 2: Plumb config through `annotateMutationAbsence`

**Files:**
- Modify: `scripts/cdp-bridge/src/verification/mutation-absence.ts`
- Modify: `scripts/cdp-bridge/test/unit/gh-91-mutation-absence.test.js`

- [ ] **Step 1: Add failing tests for the override path**

Append to `test/unit/gh-91-mutation-absence.test.js`:

```js
test('annotateMutationAbsence honors successShapes override (custom name fires warning)', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const client = makeMockClient({ entries: [] });
  // Prime first
  annotateMutationAbsence(makeOkResult({}), { client, screenName: 'Home', source: 'cdp_navigate' });
  // Trigger with a custom shape name that the DEFAULT regex would not match
  const customRegex = /(receipt|thanks)$/i;
  const result = annotateMutationAbsence(makeOkResult({}), {
    client,
    screenName: 'OrderReceipt',
    source: 'cdp_navigate',
    successShapes: customRegex,
  });
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.meta.verification_warning.code, 'MUTATION_ABSENCE');
});

test('annotateMutationAbsence honors mutationMethods override (extra method silences warning)', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const now = 1_700_000_000_000;
  const client = makeMockClient({
    entries: [
      { method: 'QUERY', status: 200, timestamp: new Date(now - 1_000).toISOString() },
    ],
  });
  annotateMutationAbsence(makeOkResult({}), {
    client, screenName: 'Home', source: 'cdp_navigate', now: () => now,
  });
  const result = annotateMutationAbsence(makeOkResult({}), {
    client,
    screenName: 'OrderConfirmation',
    source: 'cdp_navigate',
    mutationMethods: new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'QUERY']),
    now: () => now,
  });
  // QUERY is now a recognized mutation method → no warning
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.meta?.verification_warning, undefined);
});

test('annotateMutationAbsence defaults preserved when both overrides are null/undefined', async () => {
  const { annotateMutationAbsence, _resetForTests } = await import(MOD_PATH);
  _resetForTests();
  const client = makeMockClient({ entries: [] });
  annotateMutationAbsence(makeOkResult({}), { client, screenName: 'Home', source: 'cdp_navigate' });
  const result = annotateMutationAbsence(makeOkResult({}), {
    client,
    screenName: 'OrderConfirmation',
    source: 'cdp_navigate',
    successShapes: null,
    mutationMethods: null,
  });
  // Default regex still matches "confirmation" suffix
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.meta.verification_warning.code, 'MUTATION_ABSENCE');
});
```

(Assumes `makeMockClient` and `makeOkResult` helpers exist in the test file. If `makeOkResult` doesn't exist, define it next to `makeMockClient` — `(data) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] })`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-91-mutation-absence.test.js`
Expected: FAIL with overrides being ignored.

- [ ] **Step 3: Wire overrides into `mutation-absence.ts`**

In `scripts/cdp-bridge/src/verification/mutation-absence.ts`:

1. Extend `AnnotateContext`:
```typescript
export interface AnnotateContext {
  client: CDPClient;
  screenName: string | null;
  source: 'cdp_navigate' | 'cdp_navigation_state' | 'proof_step';
  windowMs?: number;
  now?: () => number;
  /** Per-project override; null/undefined → built-in default regex. */
  successShapes?: RegExp | null;
  /** Per-project override; null/undefined → built-in default Set. */
  mutationMethods?: Set<string> | null;
}
```

2. Change `isSuccessShape` to take an optional regex:
```typescript
export function isSuccessShape(rawName: string | null | undefined, regex: RegExp = SUCCESS_SHAPE_REGEX): boolean {
  const normalized = normalizeRouteName(rawName);
  if (!normalized) return false;
  return regex.test(normalized);
}
```

3. Change `countWindowedMutations` to take an optional Set:
```typescript
export function countWindowedMutations(
  client: CDPClient,
  windowMs: number,
  now: number,
  methods: Set<string> = MUTATION_METHODS,
): { inWindow: number; lastMutationAgeMs: number | null } {
  const deviceKey = client.activeDeviceKey;
  const sinceISO = new Date(now - windowMs).toISOString();
  const allMutations = client.networkBufferManager.filter(deviceKey, (entry) => {
    const method = (entry.method ?? '').toUpperCase();
    if (!methods.has(method)) return false;
    const status = entry.status;
    if (status === undefined) {
      const t = Date.parse(entry.timestamp);
      return Number.isFinite(t) && (now - t) <= MAX_PENDING_AGE_MS;
    }
    return status >= 200 && status < 400;
  });
  // ... unchanged
}
```

4. In `annotateMutationAbsence`, resolve overrides:
```typescript
const successRegex = ctx.successShapes ?? SUCCESS_SHAPE_REGEX;
const methods = ctx.mutationMethods ?? MUTATION_METHODS;
// ...
if (!isSuccessShape(ctx.screenName, successRegex)) return result;
// ...
const { inWindow, lastMutationAgeMs } = countWindowedMutations(ctx.client, windowMs, now, methods);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-91-mutation-absence.test.js test/unit/gh-91-verification-config.test.js`
Expected: PASS (all tests, including the 3 new override tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/verification/mutation-absence.ts scripts/cdp-bridge/test/unit/gh-91-mutation-absence.test.js
git commit -m "feat(gh-91): thread successShapes/mutationMethods overrides through detector"
```

---

## Task 3: Wire config loader into the 3 call sites

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/navigation-state.ts`
- Modify: `scripts/cdp-bridge/src/tools/proof-step.ts`
- Modify: `scripts/cdp-bridge/src/index.ts` (cdp_navigate handler at line ~380)

- [ ] **Step 1: Add an integration test that verifies the config flows through the wirings**

Append to `test/unit/gh-91-verification-config.test.js`:

```js
test('loadVerificationConfig is idempotent + safe to call from each tool wiring', async () => {
  const { loadVerificationConfig, _resetCacheForTests } = await import(MOD_PATH);
  _resetCacheForTests();
  const root = makeProject(JSON.stringify({ verification: { successShapes: ['Custom$'] } }));
  try {
    const a = loadVerificationConfig(root);
    const b = loadVerificationConfig(root);
    const c = loadVerificationConfig(root);
    assert.strictEqual(a, b);
    assert.strictEqual(b, c);
    assert.ok(a.successShapes?.test('OrderCustom'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Update `tools/navigation-state.ts`**

```typescript
// Add to imports
import { loadVerificationConfig } from '../verification/config.js';
import { findProjectRoot } from '../nav-graph/storage.js';

// In createNavigationStateHandler, where annotateMutationAbsence is called:
const cfg = loadVerificationConfig(findProjectRoot());
return annotateMutationAbsence(okResult(parsed), {
  client,
  screenName: extractActiveScreen(parsed),
  source: 'cdp_navigation_state',
  successShapes: cfg.successShapes,
  mutationMethods: cfg.mutationMethods,
});
```

- [ ] **Step 3: Update `tools/proof-step.ts`**

Same pattern — load config once, pass to both `annotateMutationAbsence` calls (lines 147 and 149).

- [ ] **Step 4: Update `index.ts` cdp_navigate handler (line ~380)**

```typescript
const cfg = loadVerificationConfig(findProjectRoot());
return annotateMutationAbsence(okResult(parsed), {
  client,
  screenName: args.screen,
  source: 'cdp_navigate',
  successShapes: cfg.successShapes,
  mutationMethods: cfg.mutationMethods,
});
```

Add `import { loadVerificationConfig } from './verification/config.js';` and `import { findProjectRoot } from './nav-graph/storage.js';` near other imports.

- [ ] **Step 5: Run full test suite + build**

Run: `cd scripts/cdp-bridge && npm run build && npm test`
Expected: 1312 → 1325+ tests, all passing.

- [ ] **Step 6: Commit**

```bash
git add scripts/cdp-bridge/src/tools/navigation-state.ts scripts/cdp-bridge/src/tools/proof-step.ts scripts/cdp-bridge/src/index.ts scripts/cdp-bridge/test/unit/gh-91-verification-config.test.js
git commit -m "feat(gh-91): wire verification config into cdp_navigate / nav_state / proof_step"
```

---

## Task 4: Version bumps + CHANGELOG

**Files:**
- Modify: `scripts/cdp-bridge/package.json` (0.38.31 → 0.38.32)
- Modify: `.claude-plugin/plugin.json` (0.44.36 → 0.44.37)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump versions**

Edit the two version strings; verify `package.json` lockfile if applicable.

- [ ] **Step 2: Add CHANGELOG entry**

```markdown
## [0.44.37] — 2026-05-12

### Added
- `verification.successShapes` and `verification.mutationMethods` per-project overrides in `.rn-agent/config.json` for the mutation-absence detector (closes GH #91 acceptance criterion #3). Defaults are unchanged when no config is present.
```

- [ ] **Step 3: Commit**

```bash
git add scripts/cdp-bridge/package.json .claude-plugin/plugin.json CHANGELOG.md
git commit -m "chore: bump versions for gh-91 config override"
```

---

## Task 5: Multi-review + open PR

- [ ] **Step 1: Build, test, push branch**

```bash
cd scripts/cdp-bridge && npm run build && npm test
cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin
git push -u origin fix/issue-91-mutation-absence-config-override
```

- [ ] **Step 2: Invoke ask-llm:multi-review against the diff**

Run the multi-review skill, address HIGH-confidence findings only. Note lower-confidence ones in the PR body for transparency.

- [ ] **Step 3: Open PR with `Closes #91`**

Body must:
- Explain the gap: detector shipped in `fed0dd0`, this PR closes acceptance #3 (config override).
- Document the `device_press`/`cdp_interact` deferral with the rationale from the original commit.
- Mention any multi-review LOW-confidence findings that were not addressed and why.

- [ ] **Step 4: Wait for CI green; on transient flake, push an empty re-trigger commit**

---

## Self-Review

**1. Spec coverage:** Per-project config override → Task 1-3 ✓. Defaults preserved → tests in Task 1 + Task 2 ✓. Acceptance gap closed → PR body in Task 5 ✓. Wiring deferral documented → Task 5 ✓.

**2. Placeholder scan:** None — every step has the actual code or command.

**3. Type consistency:** `VerificationConfig` shape stable across Tasks 1-3. `AnnotateContext` extension preserves backward-compat (optional fields). `successShapes` flows as `RegExp | null` end-to-end; `mutationMethods` as `Set<string> | null`.

---

## Execution Handoff

Plan complete. The execution path is **inline** (this session) using superpowers:executing-plans — the work is small enough that subagent dispatch overhead isn't worth it.
