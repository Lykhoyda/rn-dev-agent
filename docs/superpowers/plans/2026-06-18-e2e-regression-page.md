# E2E Regression Page — Observe UI + Control Endpoint (Plan 2 of 2) Implementation Plan

> **For agentic workers:** built on the Plan-1 engine. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Surface the E2E regression engine in the read-only observe web app — a "Regression" view with a Run button, live progress, verdict, per-test table, and run history — backed by a CSRF-guarded HTTP control endpoint.

**Architecture:** Additive to `ObservabilityServer`: new routes (`POST /api/e2e/run`, `GET /api/e2e/runs`, `GET /api/e2e/runs/:id`) reusing the existing host/`Sec-Fetch-Site` guard, extended with a per-server **CSRF token** injected into the served HTML and validated on POST. The endpoint bypasses `trackedTool`, so its `triggerE2eRun` acquires the arbiter **flow** lease itself, then calls the Plan-1 `createRunE2eSuiteHandler` (already wired with real preflight/reload). Live progress broadcasts via a new `Recorder.push()` over the existing SSE stream. The SPA gains a top-level `Live | Regression` toggle.

**Tech Stack:** TS (ESM strict), `node:test`, `node:http`, `node:crypto`; React 19 + Vite single-file bundle.

**Spec:** `docs/superpowers/specs/2026-06-18-e2e-regression-runner-design.md` (Control endpoint + Observe page sections).

## Global Constraints

- Node>=22, TS strict, ESM explicit `.js` imports, `import type` for types, single-quote (oxfmt), no unnecessary comments.
- Unit tests at `scripts/cdp-bridge/test/unit/*.test.js` (top-level, CI glob non-recursive), import from `../../dist/*.js`.
- Security: reuse the existing `guard()` (127.0.0.1 + Sec-Fetch-Site); POST also requires `Content-Type: application/json` + a valid `X-CSRF-Token` matching the per-server token; **GET never triggers a run**. The endpoint takes exactly one `flow` lease (refuse `BUSY_FLOW_ACTIVE`/409 if held).
- Web bundle: after any `src/observability/web/` change, run `npm run build:web` and commit `dist/observability/web-dist/index.html` (CI `web-bundle` job checks freshness).
- `dist/` tracked; build TS via `npm run build`.

## File Structure

| File | Responsibility |
|---|---|
| `src/observability/e2e-csrf.ts` (new) | `makeCsrfToken()` + `isPostAllowed(req, token)` (method/content-type/host/sec-fetch/csrf) — pure, testable |
| `src/observability/recorder.ts` (mod) | add public `push(ev)` broadcast for custom SSE events |
| `src/tools/run-e2e-suite.ts` (mod) | `createRunE2eSuiteHandler` composes an external `onProgress` sink (for SSE) with the request-update |
| `src/observability/server.ts` (mod) | optional `e2e` deps in constructor; routes; CSRF HTML injection |
| `src/tools/observe.ts` (mod) | accept + forward `e2e` deps to the server |
| `src/index.ts` (mod) | build `triggerE2eRun` (lease + handler + SSE onProgress), `listRuns`/`loadRun`, CSRF token; pass to `observeHandler` |
| `src/observability/web/src/main.tsx` (mod) | top-level `Live | Regression` toggle + Regression view + fetch + e2e SSE handling + styles |

---

## Task 1: CSRF + POST-validation helpers (pure, TDD)

**Files:** Create `src/observability/e2e-csrf.ts`; Test `test/unit/e2e-csrf.test.js`.

**Produces:** `makeCsrfToken(): string` (32+ hex chars via `node:crypto`); `isPostAllowed(req: { method?; headers }, token: string): { ok: true } | { ok: false; status: number; reason: string }` — rejects non-POST (405), wrong/missing content-type (415), missing/mismatched `x-csrf-token` (403). Host/Sec-Fetch stay in the server's existing `guard()`.

- [ ] **Step 1: failing test**

```javascript
// test/unit/e2e-csrf.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCsrfToken, isPostAllowed } from '../../dist/observability/e2e-csrf.js';

const T = 'tok_abc123';
const post = (over = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': T, ...over.headers }, ...over });

test('makeCsrfToken returns a long unguessable hex token, unique per call', () => {
  const a = makeCsrfToken(); const b = makeCsrfToken();
  assert.match(a, /^[0-9a-f]{32,}$/); assert.notEqual(a, b);
});
test('valid POST with matching csrf + json passes', () => {
  assert.deepEqual(isPostAllowed(post(), T), { ok: true });
});
test('GET is refused (405) — never triggers a run', () => {
  assert.equal(isPostAllowed({ method: 'GET', headers: {} }, T).status, 405);
});
test('missing/wrong csrf is refused (403)', () => {
  assert.equal(isPostAllowed(post({ headers: { 'x-csrf-token': 'nope' } }), T).status, 403);
  assert.equal(isPostAllowed({ method: 'POST', headers: { 'content-type': 'application/json' } }, T).status, 403);
});
test('non-json content-type is refused (415)', () => {
  assert.equal(isPostAllowed(post({ headers: { 'content-type': 'text/plain' } }), T).status, 415);
});
```

- [ ] **Step 2: run → fail** (`npm run build && node --test test/unit/e2e-csrf.test.js`)
- [ ] **Step 3: implement**

```typescript
// src/observability/e2e-csrf.ts
import { randomBytes, timingSafeEqual } from 'node:crypto';

export function makeCsrfToken(): string {
  return randomBytes(24).toString('hex');
}

interface ReqLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

export function isPostAllowed(
  req: ReqLike,
  token: string,
): { ok: true } | { ok: false; status: number; reason: string } {
  if ((req.method ?? '').toUpperCase() !== 'POST') {
    return { ok: false, status: 405, reason: 'method not allowed' };
  }
  const ct = String(req.headers['content-type'] ?? '');
  if (!ct.includes('application/json')) {
    return { ok: false, status: 415, reason: 'content-type must be application/json' };
  }
  const got = String(req.headers['x-csrf-token'] ?? '');
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 403, reason: 'bad csrf token' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: run → pass. Step 5: commit** (`feat(e2e-page): CSRF + POST-validation helpers`)

---

## Task 2: Recorder.push broadcast + handler onProgress compose (TDD)

**Files:** Mod `src/observability/recorder.ts`, `src/tools/run-e2e-suite.ts`; Test `test/unit/e2e-recorder-push.test.js` + extend guard test.

**Produces:** `Recorder.push(ev: { type: string; [k: string]: unknown }): void` (broadcast to subs, swallow per-sub). `createRunE2eSuiteHandler` calls a passed `deps.onProgress` (compose) in addition to its request-update.

- [ ] **Step 1: failing test**

```javascript
// test/unit/e2e-recorder-push.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../../dist/observability/recorder.js';

test('push broadcasts a custom event to all subscribers', () => {
  const r = new Recorder();
  const seen = [];
  r.attach((e) => seen.push(e));
  r.push({ type: 'e2e-progress', completed: 1, total: 3 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'e2e-progress');
  assert.equal(seen[0].completed, 1);
});
test('push swallows a throwing subscriber and still reaches others', () => {
  const r = new Recorder();
  const seen = [];
  r.attach(() => { throw new Error('boom'); });
  r.attach((e) => seen.push(e));
  r.push({ type: 'e2e-done', runId: 'x' });
  assert.equal(seen.length, 1);
});
```

- [ ] **Step 2: run → fail. Step 3: implement** — append to Recorder:

```typescript
push(ev: { type: string; [k: string]: unknown }): void {
  for (const fn of this.subs) {
    try {
      fn(ev as unknown as AgentEvent);
    } catch {
      /* per-subscriber swallow */
    }
  }
}
```

In `createRunE2eSuiteHandler`, compose the external onProgress (the handler currently sets `onProgress` to a request-update; change it to also call `deps.onProgress`):

```typescript
const externalOnProgress = deps.onProgress;
// ... inside the runE2eSuiteCore call:
onProgress: (completed, total, lastTestId) => {
  updateRequest(projectRoot, runId, { updatedAt: now().toISOString(), progress: { total, completed, lastTestId } });
  externalOnProgress?.(completed, total, lastTestId);
},
```

- [ ] **Step 4: add a guard-test assertion** that a passed `onProgress` is invoked during a run (extend `run-e2e-suite-guard.test.js` happy case with a counter). **Step 5: run → pass. Commit** (`feat(e2e-page): Recorder.push + compose handler onProgress for SSE`).

---

## Task 3: Endpoint routes + CSRF injection in ObservabilityServer

**Files:** Mod `src/observability/server.ts`; Test `test/unit/e2e-server-routes.test.js`.

**Produces:** `ObservabilityServer` constructor gains an optional 2nd arg `e2e?: E2eServerDeps` where `E2eServerDeps = { token: string; triggerRun: (pattern?: string) => Promise<unknown>; listRuns: () => unknown[]; loadRun: (id: string) => unknown | null }`. Routes in `handle()`:
- `POST /api/e2e/run` → `isPostAllowed(req, token)` (else status+json error) → read+parse JSON body `{ pattern? }` → `await triggerRun(pattern)` → 200 json. If no `e2e` deps wired → 501.
- `GET /api/e2e/runs` → 200 json `listRuns()`. `GET /api/e2e/runs/:id` → `loadRun(id)` (404 if null).
- `index()` injects `<script>window.__E2E_CSRF__='<token>'</script>` before `</head>` when `e2e` is present.

Add a small `json(res, status, obj)` helper. Body read capped (e.g. 64KB) to avoid unbounded buffering.

- [ ] **Step 1: failing test** (drive `handle` via mock req/res or the real listening server with `fetch`):

```javascript
// test/unit/e2e-server-routes.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilityServer } from '../../dist/observability/server.js';
import { recorder } from '../../dist/observability/recorder.js';

async function withServer(e2e, fn) {
  const s = new ObservabilityServer(recorder, e2e);
  const { url } = await s.start();
  try { await fn(url); } finally { await s.stop(); }
}
const E2E = (over = {}) => ({ token: 'tok1', triggerRun: async () => ({ ok: true, data: { verdict: 'green' } }), listRuns: () => [{ runId: 'r1', verdict: 'green' }], loadRun: (id) => (id === 'r1' ? { runId: 'r1' } : null), ...over });

test('GET /api/e2e/runs returns the index json', async () => {
  await withServer(E2E(), async (url) => {
    const r = await fetch(url + '/api/e2e/runs');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), [{ runId: 'r1', verdict: 'green' }]);
  });
});
test('POST /api/e2e/run without csrf is 403 and does NOT trigger', async () => {
  let triggered = false;
  await withServer(E2E({ triggerRun: async () => { triggered = true; return {}; } }), async (url) => {
    const r = await fetch(url + '/api/e2e/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);
    assert.equal(triggered, false);
  });
});
test('POST /api/e2e/run with valid csrf triggers + returns result', async () => {
  await withServer(E2E(), async (url) => {
    const r = await fetch(url + '/api/e2e/run', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'tok1' }, body: JSON.stringify({ pattern: 'smoke' }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).data.verdict, 'green');
  });
});
test('GET /api/e2e/run is refused (405) — reads never run', async () => {
  await withServer(E2E(), async (url) => {
    const r = await fetch(url + '/api/e2e/run');
    assert.equal(r.status, 405);
  });
});
```

- [ ] **Step 2-5:** implement the routes + `json()` helper + CSRF injection (per File Structure), build, run → pass, commit (`feat(e2e-page): CSRF-guarded e2e control routes on the observe server`). (Routes are additive in `handle()`; reuse `guard()` first.)

---

## Task 4: Wire observe.ts + index.ts (triggerE2eRun with lease)

**Files:** Mod `src/tools/observe.ts`, `src/index.ts`. (Integration — verified by the demo + full suite.)

- `observe.ts`: `observeHandler` accepts the `e2e` deps (module-level setter `setObserveE2eDeps(deps)` called from index.ts, OR thread through). Pass them to `new ObservabilityServer(recorder, e2eDeps)`.
- `index.ts`: build once —
  - `csrfToken = makeCsrfToken()`.
  - `triggerE2eRun = async (pattern) => { const L = arbiter.tryAcquire('flow','cdp_run_e2e_suite'); if(!L.ok) return failResult-ish {ok:false,code:'BUSY_FLOW_ACTIVE'}; try { return parseEnvelope(await e2eSuiteHandler({pattern})); } finally { arbiter.release(L.lease); } }` where `e2eSuiteHandler = createRunE2eSuiteHandler({ preflightCheck: e2ePreflight, runReload: e2eReload, onProgress: (c,t,id)=>recorder.push({type:'e2e-progress',completed:c,total:t,lastTestId:id}) })` (reuse the Task-9 adapters; add the SSE onProgress). After the run, `recorder.push({type:'e2e-done', runId, verdict})`.
  - `listRuns = () => loadIndex(findProjectRoot() ?? process.cwd())`, `loadRun = (id) => loadRunRecord(findProjectRoot() ?? process.cwd(), id)`.
  - register these via `setObserveE2eDeps({ token: csrfToken, triggerRun: triggerE2eRun, listRuns, loadRun })`.

- [ ] Build, `npm test` (full suite green), commit (`feat(e2e-page): wire observe e2e control deps + SSE progress`).

---

## Task 5: Regression view in the SPA + bundle

**Files:** Mod `src/observability/web/src/main.tsx`; rebuild bundle.

- Add `const [view, setView] = useState<'live'|'regression'>('live')` + a header toggle (two buttons).
- Regression view: a **Run** button (POST `/api/e2e/run` with `X-CSRF-Token: window.__E2E_CSRF__`; disabled while running), a live progress line (from `e2e-progress` SSE: `test {completed}/{total}`), the latest verdict badge + per-test table (testId · pass/fail · classification badge), and a history list (GET `/api/e2e/runs` on mount + after a run) with the newest run's `newlyFailing` highlighted.
- SSE: in `onmessage`, handle `type==='e2e-progress'` (update progress state) and `type==='e2e-done'` (clear progress + refetch history).
- Styles: extend the CSS string with `.view-toggle`, `.reg-*`, verdict colors (green `#9ece6a`, red `#f7768e`).
- [ ] Build the bundle: `cd scripts/cdp-bridge && npm run build:web`; commit `dist/observability/web-dist/index.html` + main.tsx (`feat(e2e-page): Regression view in observe SPA`).

---

## Task 6: Live demo (browser via Claude Chrome)

- [ ] Self-contained harness (`/tmp/e2e-page-demo.mjs`): re-create the `e2e-smoke` action in the workspace test-app, lock it (green), start `ObservabilityServer(recorder, e2eDeps)` from fresh dist with `triggerE2eRun` wired to the real engine against the booted sim, print the URL.
- [ ] Claude Chrome: navigate to the URL, switch to Regression, click **Run**, observe progress → green verdict + the smoke test in the table + history entry. Then (optional) break the frozen baseline and Run again → red + newly-failing. Capture screenshots.
- [ ] Clean up demo artifacts afterward.

## Self-Review / Known limits
- Security: CSRF + host + Sec-Fetch + method + content-type; localhost-only; one flow lease. Body size capped.
- v1.1 (not here): in-page promote/re-lock buttons + `cdp_list_e2e_tests`; cancellation; per-test live streaming detail.
- Params: param-needing locked tests still skipped (engine behavior); the page shows them as skipped.
