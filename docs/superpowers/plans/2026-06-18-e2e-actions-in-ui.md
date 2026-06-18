# Actions in the Observe UI — list + per-action Run (Plan 4)

**Goal:** Add an **Actions** section to the observe Regression view: list the project's actions (`.rn-agent/actions/`) and run any one with a **Run** button (the repairable `cdp_run_action` path), resolving params from `.rn-agent/e2e.config.json`. Complements the existing locked-test "Run E2E Suite".

**Built on:** Plan-2 page + control endpoint, Plan-3 params source.

## Global constraints
- Node>=22, TS strict, ESM `.js` imports, `import type`, single-quote, no unnecessary comments.
- Unit tests at `test/unit/*.test.js` (top-level), `node:test`, import from `../../dist/*.js`. Build `npm run build`; `dist/` tracked. Web bundle via `npm run build:web` (committed).
- New endpoints reuse the existing `guard()` + CSRF (`isPostAllowed`) on the POST; GET reads need no CSRF. `runAction` takes the arbiter **flow** lease.

## Task 1 — `domain/action-inventory.ts` (TDD)

**Produces:** `interface ActionSummary { id: string; intent: string; params: string[]; mutates: boolean; status: string; appId?: string }` and `listActions(projectRoot): ActionSummary[]` — readdir `.rn-agent/actions/*.yaml`, `loadAction(projectRoot, id)` each, map metadata → summary; sorted by id; tolerant (skip unparseable). Reuse `loadAction` + `actionPathFor` conventions from `domain/action-store.js`.

- [ ] failing test `test/unit/action-inventory.test.js` (seed 2 actions in a tmp project, assert listed sorted with metadata; an unreadable file is skipped) → fail → implement → pass → commit.

## Task 2 — endpoints on `ObservabilityServer` (TDD)

`E2eServerDeps` += `listActions: () => Promise<unknown[]>` and `runAction: (actionId: string) => Promise<unknown>`. Routes in `handle()`:
- `GET /api/e2e/actions` → 200 json `listActions()` (501 if no e2e deps).
- `POST /api/e2e/actions/run` → `isPostAllowed` (CSRF/method/content-type) → parse body `{ actionId }` (400 if missing/blank) → `await runAction(actionId)` → 200 json. GET on this path → 405.

- [ ] failing test `test/unit/e2e-server-actions.test.js` (real server + fetch: GET lists; POST w/o CSRF → 403, no trigger; POST w/ CSRF → result; GET on /run → 405) → fail → implement → pass → commit.

## Task 3 — wiring in `index.ts`

- `listActions: async () => listActions(projectRootFor())` (from `domain/action-inventory.js`).
- `runAction: async (actionId) => { const cfg = loadE2eConfig(root); const action = loadAction(root, actionId); const required = action?.metadata.params ?? []; const res = resolveParams(cfg, actionId, required); if (!res.ok) return { ok:false, code:'MISSING_PARAMS', error:'missing param values: '+res.missing.join(', ') }; const L = arbiter.tryAcquire('flow','cdp_run_action'); if (!L.ok) return { ok:false, code:'BUSY_FLOW_ACTIVE' }; try { const r = await runActionHandler({ actionId, params: res.params, trigger:'human' }); return JSON.parse(r.content[0].text); } finally { arbiter.release(L.lease); } }` where `runActionHandler = createRunActionHandler()` (from `tools/run-action.js`). Pass both into `setObserveE2eDeps`.
- Imports: `listActions`, `loadE2eConfig`, `resolveParams`, `loadAction`, `createRunActionHandler`.

- [ ] build + `npm test` (full suite green) + commit.

## Task 4 — Regression view: Actions section + Run buttons + bundle

`web/src/main.tsx`: in the Regression view, add an **Actions** panel below the suite controls:
- On mount / view-switch, `GET /api/e2e/actions` → render a table: id · intent · params (chips) · status badge · **Run** button.
- **Run** → `POST /api/e2e/actions/run` with `{ actionId }` + `X-CSRF-Token`; disable that row's button while running; show per-action result (pass/fail + verdict/`code` e.g. `MISSING_PARAMS`/`BUSY_FLOW_ACTIVE`).
- Reuse existing styles + palette; add `.actions-*` classes.
- [ ] `npm run build:web`; commit `main.tsx` + `dist/observability/web-dist/index.html`.

## Verification
- Unit: inventory listing, endpoint routes + CSRF, missing-params path.
- Live (browser): list renders + Run wired; an actual green action run needs a non-blind WDA (iOS 18) — #317 blocks tap-based runs on iOS 26.5.

## Known limits
- Action runs are single-action (no batch); v1.1 could add per-action param overrides in the UI (today values come from `e2e.config.json`).
