# Observe Web UI Overhaul Implementation Plan (PR 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the observe SPA — header with session stats, filterable/searchable timeline with follow/pause autoscroll, device-screenshot hero pane, guided empty states, inline action param inputs, and E2E run-history drill-down — by splitting the 670-line `main.tsx` into focused modules.

**Architecture:** Pure client-side restructure of `scripts/cdp-bridge/src/observability/web/src/` (React 19 + Vite single-file bundle) plus ONE tiny server-side change: `resolveParams` accepts caller-provided param overrides so the UI's inline inputs actually work. Each new module is written once in its final form; the old `main.tsx` keeps working until the final task flips the app shell over.

**Tech Stack:** React 19, TypeScript, Vite (`vite-plugin-singlefile`, output to `dist/observability/web-dist/`), CSS-in-a-string injected at mount (existing pattern). Server-side: `node:test` against `dist/`.

**Source spec:** `docs/superpowers/specs/2026-07-02-observe-ui-autostart-design.md`

## Global Constraints

- No new runtime dependencies — `web/package.json` keeps exactly `react` + `react-dom`.
- No new server endpoints; the only bridge change is the `resolveParams` extension (Task 1).
- Keep the Tokyo Night palette; dark theme only.
- SPA type gate: `npx tsc --noEmit` inside `src/observability/web/` (vite build does NOT typecheck). Build gate: `npm run build:web` from `scripts/cdp-bridge/`.
- Component annotations use `JSX.Element` (existing codebase style).
- The web app talks to: `GET /api/stream` (SSE), `GET /api/screenshot/:seq`, `GET /api/live-screenshot/:seq`, `POST /api/e2e/run`, `GET /api/e2e/runs`, `GET /api/e2e/runs/:id`, `GET /api/e2e/actions`, `POST /api/e2e/actions/run` — all existing. CSRF token comes from `window.__E2E_CSRF__`.
- All `scripts/cdp-bridge` commands run from that directory; web commands from `scripts/cdp-bridge/src/observability/web/`.

---

### Task 1: Server-side — `resolveParams` accepts UI-provided overrides

Today `POST /api/e2e/actions/run` discards the request's `params` whenever the action declares required params: the `runAction` closure in `index.ts` overwrites them with config-resolved values or fails with `missingParams`. The UI's inline inputs (Task 6) need provided params to win.

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/e2e-config.ts:20-36`
- Modify: `scripts/cdp-bridge/src/index.ts` (the `setObserveE2eDeps.runAction` closure, ~line 2336: `const resolved = resolveParams(config, actionId, required);`)
- Test: `scripts/cdp-bridge/test/unit/e2e-config.test.js` (extend)

**Interfaces:**
- Produces: `resolveParams(config, testId, required, provided?)` — 4th optional arg `provided?: Record<string, string>`; non-empty provided values take precedence over config; return shape unchanged (`{ ok: true, params } | { ok: false, missing }`).

- [ ] **Step 1: Write the failing test**

Append to `scripts/cdp-bridge/test/unit/e2e-config.test.js`:

```js
test('resolveParams: caller-provided params win over config and fill gaps', () => {
  const config = { defaults: { params: { user: 'from-config', pass: 'cfg-pw' } } };
  const r = resolveParams(config, 'login', ['user', 'pass'], { user: 'from-ui' });
  assert.deepEqual(r, { ok: true, params: { user: 'from-ui', pass: 'cfg-pw' } });
});

test('resolveParams: empty-string provided values do not mask config values', () => {
  const config = { defaults: { params: { user: 'from-config' } } };
  const r = resolveParams(config, 'login', ['user'], { user: '' });
  assert.deepEqual(r, { ok: true, params: { user: 'from-config' } });
});

test('resolveParams: provided params satisfy otherwise-missing requirements', () => {
  const r = resolveParams({}, 'login', ['user'], { user: 'typed' });
  assert.deepEqual(r, { ok: true, params: { user: 'typed' } });
});
```

(The file already imports `resolveParams` and `assert` — check its header; if `resolveParams` is not yet imported there, add it to the existing import from `../../dist/domain/e2e-config.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/e2e-config.test.js`
Expected: FAIL — the 4th argument is ignored, so `user` resolves to `'from-config'` instead of `'from-ui'`, and the gap-fill case returns `{ ok: false, missing: ['user'] }`.

- [ ] **Step 3: Extend `resolveParams` in `src/domain/e2e-config.ts`**

```ts
export function resolveParams(
  config: E2eConfig,
  testId: string,
  required: string[],
  provided?: Record<string, string>,
): { ok: true; params: Record<string, string> } | { ok: false; missing: string[] } {
  // Caller-provided values (e.g. typed into the observe UI) take precedence
  // over config; empty strings are treated as "not provided" so a blank input
  // never masks a configured value.
  const overrides = Object.fromEntries(
    Object.entries(provided ?? {}).filter(([, v]) => typeof v === 'string' && v !== ''),
  );
  const merged: Record<string, string> = {
    ...config.defaults?.params,
    ...config.tests?.[testId]?.params,
    ...overrides,
  };
  const missing = required.filter((k) => !merged[k]);
  if (missing.length > 0) return { ok: false, missing };
  // Return ONLY the params the action declares — never leak unrelated
  // defaults (which may include secrets) into a test that doesn't use them.
  const params: Record<string, string> = {};
  for (const k of required) params[k] = merged[k] as string;
  return { ok: true, params };
}
```

- [ ] **Step 4: Pass the HTTP params through in `src/index.ts`**

In the `setObserveE2eDeps({ ... runAction ... })` closure, change:

```ts
      const resolved = resolveParams(config, actionId, required);
```

to:

```ts
      const resolved = resolveParams(config, actionId, required, params);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — the three new tests plus all existing `e2e-config` and run-action tests (the new argument is optional, so `cdp_run_e2e_suite`'s call sites are unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/domain/e2e-config.ts src/index.ts test/unit/e2e-config.test.js
git commit -m "feat(e2e): resolveParams accepts caller-provided overrides so the observe UI can supply action params"
```

---

### Task 2: Web scaffolding — `types.ts`, `derive.ts`, `theme.ts`

New modules only; `main.tsx` untouched (still builds and behaves as before).

**Files:**
- Create: `scripts/cdp-bridge/src/observability/web/src/types.ts`
- Create: `scripts/cdp-bridge/src/observability/web/src/derive.ts`
- Create: `scripts/cdp-bridge/src/observability/web/src/theme.ts`

**Interfaces:**
- Produces (consumed by every later task): all shared types; pure helpers `latestByTool`, `latestByFamily`, `pretty`, `routeOf`, `appOf`, `fmtClock`, `fmtElapsed`, `csrfToken`; theme exports `FAMILY_COLOR`, `FAMILIES`, `CSS`.

- [ ] **Step 1: Create `src/types.ts`**

```ts
export type Family =
  | 'interaction'
  | 'introspection'
  | 'navigation'
  | 'lifecycle'
  | 'testing'
  | 'other';

export interface AgentEvent {
  seq: number;
  ts: number;
  tool: string;
  family: Family;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs?: number;
  error?: { message: string; code?: string };
  ghost?: { attempted: boolean; outcome: string };
  summary: string;
  payload?: unknown;
  truncated?: boolean;
}

export type Conn = 'connecting' | 'open' | 'error';

export interface ActionSummary {
  id: string;
  intent: string;
  status: string;
  params?: string[];
  mutates?: boolean;
  appId?: string;
}

export interface ActionRunResult {
  ok: boolean;
  output?: string;
  error?: string;
  missingParams?: string[];
}

export interface ActionRunState {
  running: boolean;
  result?: ActionRunResult;
}

export interface E2eProgress {
  completed: number;
  total: number;
  lastTestId: string;
}

export interface E2eFlowResult {
  testId: string;
  intent?: string;
  passed: boolean;
  durationMs?: number;
  classification: string;
  errorExcerpt?: string | null;
}

export interface E2eRunResult {
  ok?: boolean;
  data?: {
    runId?: string | null;
    verdict?: string | null;
    totals?: { total: number; passed: number; failed: number; skipped: number };
    results?: E2eFlowResult[];
    newlyFailing?: string[];
  };
}

export interface E2eRunIndexEntry {
  runId: string;
  finishedAt: string;
  verdict: string;
  totals: { total: number; passed: number; failed: number; skipped: number };
}

/** Shape of GET /api/e2e/runs/:id — the bridge's E2eRunRecord. */
export interface E2eRunDetail {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  platform: string;
  verdict: string;
  totals: { total: number; passed: number; failed: number; skipped: number };
  results: E2eFlowResult[];
}
```

- [ ] **Step 2: Create `src/derive.ts`** (pure helpers moved out of the old `main.tsx`, plus formatters)

```ts
import type { AgentEvent, Family } from './types';

export function latestByTool(events: AgentEvent[], tools: string[]): AgentEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (tools.includes(events[i].tool)) return events[i];
  }
  return undefined;
}

export function latestByFamily(events: AgentEvent[], family: Family): AgentEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].family === family) return events[i];
  }
  return undefined;
}

export function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function routeOf(ev: AgentEvent | undefined): string | undefined {
  if (!ev) return undefined;
  const p = ev.payload as
    | { routeName?: string; nested?: { routeName?: string; nested?: { routeName?: string } } }
    | undefined;
  const cand = p?.nested?.nested?.routeName ?? p?.nested?.routeName ?? p?.routeName;
  return typeof cand === 'string' ? cand : undefined;
}

export function appOf(events: AgentEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const a = events[i].args as { appId?: unknown; bundleId?: unknown; bundle?: unknown };
    const id = a.appId ?? a.bundleId ?? a.bundle;
    if (typeof id === 'string' && id) return id;
  }
  return undefined;
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss.padStart(2, '0')}`;
}

export function csrfToken(): string {
  return (window as unknown as { __E2E_CSRF__?: string }).__E2E_CSRF__ ?? '';
}
```

- [ ] **Step 3: Create `src/theme.ts`** (tokens + the full stylesheet; injected by `main.tsx` in Task 6)

```ts
import type { Family } from './types';

export const FAMILIES: Family[] = [
  'interaction',
  'introspection',
  'navigation',
  'lifecycle',
  'testing',
  'other',
];

export const FAMILY_COLOR: Record<Family, string> = {
  interaction: '#7aa2f7',
  introspection: '#9ece6a',
  navigation: '#e0af68',
  lifecycle: '#bb9af7',
  testing: '#f7768e',
  other: '#787c99',
};

// Tokyo Night tokens
// bg #16161e | surface #1a1b26 | raised #1f2335 | selected #283457 | border #2a2b3d
// text #c0caf5 | soft #a9b1d6 | muted #787c99 | dim #565f89
// blue #7aa2f7 | cyan #7dcfff | green #9ece6a | yellow #e0af68 | purple #bb9af7 | red #f7768e

export const CSS = `
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: #16161e; color: #c0caf5;
  font: 13px/1.45 -apple-system, system-ui, sans-serif;
}
pre, .mono, .tool, .dur, .summ, .time, .reg-testid { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
button { font: inherit; }
.app { display: flex; flex-direction: column; height: 100%; }

/* ── Header ─────────────────────────────────────────────── */
.header {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 8px 16px; background: #1a1b26; border-bottom: 1px solid #2a2b3d;
}
.brand { display: flex; align-items: baseline; gap: 8px; }
.brand strong { font-size: 14px; letter-spacing: 0.3px; }
.brand span { color: #565f89; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
.conn-pill {
  display: inline-flex; align-items: center; gap: 6px;
  background: #1f2335; border: 1px solid #2a2b3d; border-radius: 999px;
  padding: 2px 10px; font-size: 11px; color: #a9b1d6;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: #787c99; flex: none; }
.dot.open { background: #9ece6a; box-shadow: 0 0 6px #9ece6a66; }
.dot.connecting { background: #e0af68; }
.dot.error { background: #f7768e; }
.chip {
  background: #1f2335; border: 1px solid #2a2b3d; border-radius: 6px;
  padding: 2px 8px; font-size: 11px; color: #a9b1d6; max-width: 260px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chip.route { color: #9ece6a; }
.chip b { color: #565f89; font-weight: 600; margin-right: 5px; text-transform: uppercase; font-size: 10px; }
.hstats { margin-left: auto; display: flex; align-items: center; gap: 14px; }
.stat { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.2; }
.stat .v { font-weight: 700; font-size: 13px; }
.stat .k { color: #565f89; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
.stat .v.bad { color: #f7768e; }
.view-toggle { display: flex; gap: 4px; }

/* ── Panes ──────────────────────────────────────────────── */
.panes { display: flex; flex: 1; min-height: 0; }
.pane { display: flex; flex-direction: column; min-width: 0; border-right: 1px solid #2a2b3d; }
.pane.left { flex: 0 0 40%; }
.pane.center { flex: 1; }
.pane.right { flex: 0 0 26%; border-right: none; }
.pane-head {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; background: #1a1b26; border-bottom: 1px solid #2a2b3d;
  font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; color: #a9b1d6;
}

/* ── Filter bar ─────────────────────────────────────────── */
.filterbar {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 8px 10px; background: #1a1b26; border-bottom: 1px solid #2a2b3d;
}
.fchip {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  background: #1f2335; color: #a9b1d6; border: 1px solid #2a2b3d;
  border-radius: 999px; padding: 2px 10px; font-size: 11px;
}
.fchip .fdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.fchip .n { color: #565f89; }
.fchip.off { opacity: 0.35; }
.fchip.errors.on { border-color: #f7768e; color: #f7768e; }
.search {
  flex: 1; min-width: 130px; background: #1f2335; border: 1px solid #2a2b3d;
  border-radius: 6px; color: #c0caf5; padding: 4px 10px; font: inherit; font-size: 12px;
}
.search::placeholder { color: #565f89; }
.search:focus { outline: none; border-color: #7aa2f7; }

/* ── Timeline ───────────────────────────────────────────── */
.timeline-wrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.timeline { flex: 1; overflow: auto; padding: 4px 0; }
.row {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 12px; cursor: pointer; white-space: nowrap;
}
.row:hover { background: #1f2335; }
.row.sel { background: #283457; }
.row.err { box-shadow: inset 2px 0 0 #f7768e; }
.time { color: #565f89; font-size: 11px; flex: none; }
.fam { color: #16161e; border-radius: 3px; padding: 0 5px; font-size: 10px; font-weight: 700; text-transform: uppercase; flex: none; }
.tool { color: #7dcfff; flex: none; }
.summ { color: #a9b1d6; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.ghost { color: #16161e; background: #e0af68; border-radius: 3px; padding: 0 4px; font-size: 10px; font-weight: 700; flex: none; }
.ok { flex: none; } .ok.pass { color: #9ece6a; } .ok.fail { color: #f7768e; }
.dur { color: #565f89; font-size: 11px; flex: none; }
.dur.slow { color: #e0af68; font-weight: 700; }
.detail { background: #13141c; border-top: 1px solid #2a2b3d; border-bottom: 1px solid #2a2b3d; padding: 8px 12px; }
.dlabel { color: #787c99; text-transform: uppercase; font-size: 10px; margin: 6px 0 2px; letter-spacing: 0.5px; }
.detail pre, .state pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
.detail pre.errtext { color: #f7768e; }
.jump {
  position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);
  background: #283457; color: #c0caf5; border: 1px solid #7aa2f7; border-radius: 999px;
  padding: 5px 14px; cursor: pointer; font-size: 12px; font-weight: 600;
  box-shadow: 0 4px 14px #00000088;
}
.jump:hover { background: #3b4261; }
.count-note { padding: 4px 12px; color: #565f89; font-size: 11px; border-top: 1px solid #1f2335; }

/* ── Device pane ────────────────────────────────────────── */
.screen { flex: 1; overflow: auto; display: flex; align-items: center; justify-content: center; padding: 16px; }
.device-frame {
  background: #101018; border: 1px solid #2a2b3d; border-radius: 22px;
  padding: 10px; box-shadow: 0 8px 30px #00000066; max-width: 100%; max-height: 100%;
}
.device-frame img { display: block; max-width: 100%; max-height: calc(100vh - 180px); border-radius: 14px; }
.route-chip {
  margin-left: auto; background: #1f2335; color: #9ece6a; border: 1px solid #2a2b3d;
  border-radius: 999px; padding: 1px 10px; font-size: 11px; font-weight: 600; text-transform: none; letter-spacing: 0;
}

/* ── Tabs / state pane ──────────────────────────────────── */
.tabs { display: flex; gap: 6px; padding: 7px 10px; background: #1a1b26; border-bottom: 1px solid #2a2b3d; }
.tab {
  background: #1f2335; color: #a9b1d6; border: 1px solid #2a2b3d; border-radius: 6px;
  padding: 3px 12px; cursor: pointer;
}
.tab.on { background: #283457; color: #c0caf5; border-color: #7aa2f7; }
.state { flex: 1; overflow: auto; padding: 10px 12px; }
.trunc { color: #e0af68; font-size: 11px; margin-bottom: 6px; }
.liveroute { color: #9ece6a; font-weight: 600; margin-bottom: 8px; }

/* ── Empty states ───────────────────────────────────────── */
.empty { color: #565f89; padding: 14px; }
.empty-guide { margin: auto; max-width: 320px; text-align: center; line-height: 1.6; }
.empty-guide .empty-title { color: #a9b1d6; font-weight: 600; margin-bottom: 6px; font-size: 14px; }

/* ── Regression view ────────────────────────────────────── */
.reg-container { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: auto; padding: 16px; gap: 16px; }
.reg-panel, .actions-panel, .reg-history { background: #1a1b26; border: 1px solid #2a2b3d; border-radius: 8px; }
.reg-panel { padding: 14px; }
.reg-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.reg-run-btn {
  background: #283457; color: #c0caf5; border: 1px solid #7aa2f7; border-radius: 6px;
  padding: 6px 18px; cursor: pointer; font-weight: 600;
}
.reg-run-btn:hover:not(:disabled) { background: #3b4261; }
.reg-run-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.reg-progress { color: #e0af68; font-size: 12px; }
.reg-verdict { font-weight: 700; border-radius: 6px; padding: 3px 12px; font-size: 13px; }
.reg-verdict.pass { background: #1a2d1a; color: #9ece6a; border: 1px solid #9ece6a; }
.reg-verdict.fail { background: #2d1a1a; color: #f7768e; border: 1px solid #f7768e; }
.reg-verdict.none { background: #1f2335; color: #787c99; border: 1px solid #565f89; }
.reg-empty-hint { color: #787c99; font-size: 12px; font-style: italic; }
.reg-none { color: #787c99; font-weight: 600; }
.reg-results { overflow: auto; }
.reg-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.reg-table th { padding: 7px 12px; text-align: left; background: #13141c; color: #787c99; font-weight: 600; border-bottom: 1px solid #2a2b3d; }
.reg-table td { padding: 6px 12px; border-bottom: 1px solid #1f2335; }
.reg-table tr:last-child td { border-bottom: none; }
.reg-table tbody tr:hover td { background: #1f2335; }
.reg-testid { color: #7dcfff; }
.reg-pass { color: #9ece6a; font-weight: 600; }
.reg-fail { color: #f7768e; font-weight: 600; }
.reg-newly-failing td { background: #2d1a1a !important; }
.reg-badge { border-radius: 3px; padding: 1px 6px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
.reg-badge-pass { background: #1a2d1a; color: #9ece6a; }
.reg-badge-regression { background: #2d1a1a; color: #f7768e; }
.reg-badge-infra { background: #2d2a1a; color: #e0af68; }
.reg-badge-skipped { background: #1f2335; color: #787c99; }
.hist-row { cursor: pointer; }
.hist-detail td { background: #13141c !important; padding: 10px 12px; }
.hist-detail .errx { color: #f7768e; font-size: 11px; white-space: pre-wrap; word-break: break-word; margin: 2px 0 8px; }
.hist-meta { color: #787c99; font-size: 11px; margin-bottom: 8px; }

/* ── Actions panel ──────────────────────────────────────── */
.actions-table { width: 100%; }
.actions-intent { color: #a9b1d6; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actions-params { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.param-input {
  background: #1f2335; border: 1px solid #2a2b3d; border-radius: 4px; color: #c0caf5;
  padding: 2px 7px; font-size: 11px; font-family: ui-monospace, "SF Mono", Menlo, monospace; width: 110px;
}
.param-input::placeholder { color: #565f89; }
.param-input:focus { outline: none; border-color: #7aa2f7; }
.param-input.missing { border-color: #f7768e; }
.actions-mutates { background: #2d2a1a; color: #e0af68; border-radius: 3px; padding: 1px 4px; font-size: 10px; font-weight: 700; margin-left: 4px; }
.actions-status-active { background: #1a2d1a; color: #9ece6a; }
.actions-status-experimental { background: #2d2a1a; color: #e0af68; }
.actions-status-deprecated { background: #1f2335; color: #787c99; }
.actions-run-cell { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.actions-run-btn {
  background: #283457; color: #c0caf5; border: 1px solid #2a2b3d; border-radius: 4px;
  padding: 3px 12px; cursor: pointer; font-size: 11px;
}
.actions-run-btn:hover:not(:disabled) { background: #3b4261; border-color: #7aa2f7; }
.actions-run-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.actions-result-ok { color: #9ece6a; font-size: 11px; font-weight: 600; cursor: pointer; }
.actions-result-fail { color: #f7768e; font-size: 11px; cursor: pointer; }
.action-output td { background: #13141c !important; }
.action-output pre { margin: 0; font-size: 11px; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; }
`;
```

- [ ] **Step 4: Type + build gate**

```bash
cd src/observability/web
npx tsc --noEmit
npm run build
```

Expected: both succeed (new modules are not imported yet — that's fine; `tsc --noEmit` checks them, vite ignores them).

- [ ] **Step 5: Commit**

```bash
git add src/observability/web/src/types.ts src/observability/web/src/derive.ts src/observability/web/src/theme.ts
git commit -m "refactor(observe-ui): extract types, derive helpers, and theme tokens/stylesheet"
```

---

### Task 3: `hooks/useEventStream.ts`

**Files:**
- Create: `scripts/cdp-bridge/src/observability/web/src/hooks/useEventStream.ts`

**Interfaces:**
- Consumes: `AgentEvent`, `Conn`, `E2eProgress` from `../types`.
- Produces: `useEventStream(): EventStream` where `EventStream = { events, conn, liveShotSeq, liveRoute, e2eProgress, e2eDoneCount }`. `e2eDoneCount` increments on every `e2e-done` SSE message — consumers refetch history when it changes.

- [ ] **Step 1: Create the hook**

```ts
import { useEffect, useRef, useState } from 'react';
import type { AgentEvent, Conn, E2eProgress } from '../types';

const MAX_EVENTS = 500;

export interface EventStream {
  events: AgentEvent[];
  conn: Conn;
  liveShotSeq: number | null;
  liveRoute: string | null;
  e2eProgress: E2eProgress | null;
  /** Increments on every e2e-done SSE message — watch it to refetch run history. */
  e2eDoneCount: number;
}

export function useEventStream(): EventStream {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [conn, setConn] = useState<Conn>('connecting');
  const [liveShotSeq, setLiveShotSeq] = useState<number | null>(null);
  const [liveRoute, setLiveRoute] = useState<string | null>(null);
  const [e2eProgress, setE2eProgress] = useState<E2eProgress | null>(null);
  const [e2eDoneCount, setE2eDoneCount] = useState(0);
  const maxSeqRef = useRef(0);

  useEffect(() => {
    const merge = (incoming: AgentEvent[]): void => {
      const fresh = incoming.filter(
        (e) => e && typeof e.seq === 'number' && e.seq > maxSeqRef.current,
      );
      if (fresh.length === 0) return;
      for (const e of fresh) if (e.seq > maxSeqRef.current) maxSeqRef.current = e.seq;
      setEvents((prev) => {
        const next = prev.concat(fresh);
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
      });
    };

    const es = new EventSource('/api/stream');
    es.onopen = () => setConn('open');
    es.onerror = () => setConn('error');
    es.onmessage = (msg) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.data);
      } catch {
        return;
      }
      const type =
        parsed && typeof parsed === 'object' ? (parsed as { type?: string }).type : undefined;
      if (type === 'shutdown') {
        es.close();
        setConn('error');
        setLiveShotSeq(null);
        setLiveRoute(null);
        return;
      }
      if (type === 'live') {
        const p = parsed as { shotSeq?: number; route?: string };
        if (typeof p.shotSeq === 'number') setLiveShotSeq(p.shotSeq);
        if (typeof p.route === 'string') setLiveRoute(p.route);
        return;
      }
      if (type === 'e2e-progress') {
        const p = parsed as { completed?: number; total?: number; lastTestId?: string };
        setE2eProgress({
          completed: p.completed ?? 0,
          total: p.total ?? 0,
          lastTestId: p.lastTestId ?? '',
        });
        return;
      }
      if (type === 'e2e-done') {
        setE2eProgress(null);
        setE2eDoneCount((n) => n + 1);
        return;
      }
      if (type === 'snapshot') {
        merge((parsed as { events?: AgentEvent[] }).events ?? []);
      } else {
        merge([parsed as AgentEvent]);
      }
    };
    return () => es.close();
  }, []);

  return { events, conn, liveShotSeq, liveRoute, e2eProgress, e2eDoneCount };
}
```

- [ ] **Step 2: Type gate + commit**

```bash
cd src/observability/web && npx tsc --noEmit
git add src/hooks/useEventStream.ts
git commit -m "refactor(observe-ui): extract SSE wiring into useEventStream hook"
```

(Run `git add` from the repo with the full path `scripts/cdp-bridge/src/observability/web/src/hooks/useEventStream.ts` if the cwd differs.)

---

### Task 4: `Header`, `FilterBar`, `Timeline` components

**Files:**
- Create: `scripts/cdp-bridge/src/observability/web/src/components/Header.tsx`
- Create: `scripts/cdp-bridge/src/observability/web/src/components/FilterBar.tsx`
- Create: `scripts/cdp-bridge/src/observability/web/src/components/Timeline.tsx`

**Interfaces:**
- Consumes: types from `../types`, `FAMILY_COLOR`/`FAMILIES` from `../theme`, `pretty`/`fmtClock`/`fmtElapsed` from `../derive`.
- Produces (consumed by `main.tsx` in Task 7):
  - `Header({ conn, app, route, events, view, onViewChange })`
  - `FilterBar({ counts, active, onToggleFamily, search, onSearch, errorsOnly, onErrorsOnly })`
  - `Timeline({ events, totalCount, selected, onSelect })`

- [ ] **Step 1: Create `src/components/Header.tsx`**

```tsx
import { useEffect, useState } from 'react';
import type { AgentEvent, Conn } from '../types';
import { fmtElapsed } from '../derive';

export type View = 'live' | 'regression';

interface HeaderProps {
  conn: Conn;
  app?: string;
  route?: string;
  events: AgentEvent[];
  view: View;
  onViewChange: (v: View) => void;
}

export function Header({ conn, app, route, events, view, onViewChange }: HeaderProps): JSX.Element {
  const startTs = events.length > 0 ? events[0].ts : null;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (startTs == null) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [startTs]);

  const errors = events.reduce((n, e) => (e.ok ? n : n + 1), 0);

  return (
    <div className="header">
      <div className="brand">
        <strong>Observe</strong>
        <span>rn-dev-agent</span>
      </div>
      <span className="conn-pill">
        <span className={`dot ${conn}`} />
        {conn === 'open' ? 'live' : conn}
      </span>
      {app && (
        <span className="chip" title={app}>
          <b>app</b>
          {app}
        </span>
      )}
      {route && (
        <span className="chip route" title={route}>
          <b>route</b>
          {route}
        </span>
      )}
      <div className="hstats">
        {startTs != null && (
          <span className="stat">
            <span className="v">{fmtElapsed(Date.now() - startTs)}</span>
            <span className="k">session</span>
          </span>
        )}
        <span className="stat">
          <span className="v">{events.length}</span>
          <span className="k">calls</span>
        </span>
        <span className="stat">
          <span className={errors > 0 ? 'v bad' : 'v'}>{errors}</span>
          <span className="k">errors</span>
        </span>
        <span className="view-toggle">
          <button className={view === 'live' ? 'tab on' : 'tab'} onClick={() => onViewChange('live')}>
            Live
          </button>
          <button
            className={view === 'regression' ? 'tab on' : 'tab'}
            onClick={() => onViewChange('regression')}
          >
            Regression
          </button>
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `src/components/FilterBar.tsx`**

```tsx
import type { Family } from '../types';
import { FAMILIES, FAMILY_COLOR } from '../theme';

interface FilterBarProps {
  counts: Record<Family, number>;
  active: ReadonlySet<Family>;
  onToggleFamily: (f: Family) => void;
  search: string;
  onSearch: (q: string) => void;
  errorsOnly: boolean;
  onErrorsOnly: (on: boolean) => void;
}

export function FilterBar({
  counts,
  active,
  onToggleFamily,
  search,
  onSearch,
  errorsOnly,
  onErrorsOnly,
}: FilterBarProps): JSX.Element {
  return (
    <div className="filterbar">
      {FAMILIES.map((f) => (
        <button
          key={f}
          className={active.has(f) ? 'fchip' : 'fchip off'}
          onClick={() => onToggleFamily(f)}
          title={`toggle ${f} events`}
        >
          <span className="fdot" style={{ background: FAMILY_COLOR[f] }} />
          {f}
          <span className="n">{counts[f] ?? 0}</span>
        </button>
      ))}
      <button
        className={errorsOnly ? 'fchip errors on' : 'fchip errors'}
        onClick={() => onErrorsOnly(!errorsOnly)}
        title="only failed calls"
      >
        ✗ errors
      </button>
      <input
        className="search"
        placeholder="search tool or summary…"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
    </div>
  );
}
```

- [ ] **Step 3: Create `src/components/Timeline.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '../types';
import { FAMILY_COLOR } from '../theme';
import { fmtClock, pretty } from '../derive';

const SLOW_MS = 2000;
const BOTTOM_SLACK_PX = 48;

interface TimelineProps {
  /** Filtered events to render (already capped upstream). */
  events: AgentEvent[];
  /** Unfiltered buffer size, for the "showing X of Y" note. */
  totalCount: number;
  selected: number | null;
  onSelect: (seq: number | null) => void;
}

export function Timeline({ events, totalCount, selected, onSelect }: TimelineProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const countAtPauseRef = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [events, following]);

  const onScroll = (): void => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
    if (atBottom && !following) setFollowing(true);
    if (!atBottom && following) {
      countAtPauseRef.current = events.length;
      setFollowing(false);
    }
  };

  const newCount = following ? 0 : Math.max(0, events.length - countAtPauseRef.current);

  return (
    <div className="timeline-wrap">
      <div className="timeline" ref={ref} onScroll={onScroll}>
        {events.map((e) => (
          <div key={e.seq}>
            <div
              className={`row ${selected === e.seq ? 'sel' : ''} ${e.ok ? '' : 'err'}`}
              onClick={() => onSelect(selected === e.seq ? null : e.seq)}
            >
              <span className="time">{fmtClock(e.ts)}</span>
              <span className="fam" style={{ background: FAMILY_COLOR[e.family] }}>
                {e.family.slice(0, 4)}
              </span>
              <span className="tool">{e.tool}</span>
              <span className="summ">{e.summary}</span>
              {e.ghost && <span className="ghost">ghost</span>}
              <span className={`ok ${e.ok ? 'pass' : 'fail'}`}>{e.ok ? '✓' : '✗'}</span>
              {e.durationMs != null && (
                <span className={e.durationMs > SLOW_MS ? 'dur slow' : 'dur'}>{e.durationMs}ms</span>
              )}
            </div>
            {selected === e.seq && (
              <div className="detail">
                <div className="dlabel">args</div>
                <pre>{pretty(e.args)}</pre>
                {e.error && (
                  <>
                    <div className="dlabel">error</div>
                    <pre className="errtext">{pretty(e.error)}</pre>
                  </>
                )}
                {e.payload !== undefined && (
                  <>
                    <div className="dlabel">payload{e.truncated ? ' (truncated)' : ''}</div>
                    <pre>{pretty(e.payload)}</pre>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        {events.length === 0 && totalCount === 0 && (
          <div className="empty empty-guide">
            <div className="empty-title">Waiting for agent activity</div>
            <div>Tool calls appear here as the agent works. Ask it to interact with the app.</div>
          </div>
        )}
        {events.length === 0 && totalCount > 0 && (
          <div className="empty">no events match the current filters</div>
        )}
      </div>
      {events.length < totalCount && (
        <div className="count-note">
          showing {events.length} of {totalCount} events
        </div>
      )}
      {!following && (
        <button className="jump" onClick={() => setFollowing(true)}>
          ↓ latest{newCount > 0 ? ` (${newCount} new)` : ''}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Type gate + commit**

```bash
cd src/observability/web && npx tsc --noEmit
git add src/components/Header.tsx src/components/FilterBar.tsx src/components/Timeline.tsx
git commit -m "feat(observe-ui): header with session stats, filter bar, timeline with follow/pause autoscroll"
```

---

### Task 5: `DevicePane` + `StatePane` components

**Files:**
- Create: `scripts/cdp-bridge/src/observability/web/src/components/DevicePane.tsx`
- Create: `scripts/cdp-bridge/src/observability/web/src/components/StatePane.tsx`

**Interfaces:**
- Produces (consumed by `main.tsx`):
  - `DevicePane({ liveShotSeq, fallbackSeq, route })`
  - `StatePane({ navEv, storeEv, treeEv, liveRoute })` (owns its own tab state)

- [ ] **Step 1: Create `src/components/DevicePane.tsx`**

```tsx
interface DevicePaneProps {
  liveShotSeq: number | null;
  /** seq of the latest device_screenshot event, used before any live frame exists. */
  fallbackSeq: number | null;
  route: string | null;
}

export function DevicePane({ liveShotSeq, fallbackSeq, route }: DevicePaneProps): JSX.Element {
  const src =
    liveShotSeq != null
      ? `/api/live-screenshot/${liveShotSeq}`
      : fallbackSeq != null
        ? `/api/screenshot/${fallbackSeq}`
        : null;
  return (
    <div className="pane center">
      <div className="pane-head">
        Device
        {route && <span className="route-chip">{route}</span>}
      </div>
      <div className="screen">
        {src ? (
          <div className="device-frame">
            <img src={src} alt="device screenshot" />
          </div>
        ) : (
          <div className="empty empty-guide">
            <div className="empty-title">No screenshot yet</div>
            <div>
              The screen appears here automatically after the agent interacts with the app.
            </div>
            <div>Nothing showing? Check the connection with cdp_status.</div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `src/components/StatePane.tsx`**

```tsx
import { useState } from 'react';
import type { AgentEvent } from '../types';
import { pretty } from '../derive';

type Tab = 'route' | 'store' | 'tree';

const EMPTY_HINT: Record<Tab, string> = {
  route: 'no navigation state yet — run cdp_navigation_state',
  store: 'no store snapshot yet — run cdp_store_state',
  tree: 'no component tree yet — run cdp_component_tree',
};

interface StatePaneProps {
  navEv?: AgentEvent;
  storeEv?: AgentEvent;
  treeEv?: AgentEvent;
  liveRoute: string | null;
}

export function StatePane({ navEv, storeEv, treeEv, liveRoute }: StatePaneProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('route');
  const tabEv = tab === 'route' ? navEv : tab === 'store' ? storeEv : treeEv;

  return (
    <div className="pane right">
      <div className="tabs">
        {(['route', 'store', 'tree'] as const).map((t) => (
          <button key={t} className={tab === t ? 'tab on' : 'tab'} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="state">
        {tab === 'route' && liveRoute && <div className="liveroute">live route: {liveRoute}</div>}
        {tabEv ? (
          <>
            {tabEv.truncated && <div className="trunc">payload truncated</div>}
            <pre>{pretty(tabEv.payload)}</pre>
          </>
        ) : tab === 'route' && liveRoute ? null : (
          <div className="empty">{EMPTY_HINT[tab]}</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Type gate + commit**

```bash
cd src/observability/web && npx tsc --noEmit
git add src/components/DevicePane.tsx src/components/StatePane.tsx
git commit -m "feat(observe-ui): device hero pane with route chip + state pane with guided empty states"
```

---

### Task 6: `ActionsPanel` + `RegressionView` components

**Files:**
- Create: `scripts/cdp-bridge/src/observability/web/src/components/ActionsPanel.tsx`
- Create: `scripts/cdp-bridge/src/observability/web/src/components/RegressionView.tsx`

**Interfaces:**
- Consumes: Task 1's server behavior (provided params win); `csrfToken` from `../derive`.
- Produces (consumed by `main.tsx`): `RegressionView({ e2eProgress, e2eDoneCount })` — self-contained (fetches actions + history itself); it renders `ActionsPanel` internally.

- [ ] **Step 1: Create `src/components/ActionsPanel.tsx`**

```tsx
import { useState } from 'react';
import type { ActionRunState, ActionSummary } from '../types';
import { csrfToken } from '../derive';

interface ActionsPanelProps {
  actions: ActionSummary[];
}

export function ActionsPanel({ actions }: ActionsPanelProps): JSX.Element {
  const [states, setStates] = useState<Record<string, ActionRunState>>({});
  const [paramValues, setParamValues] = useState<Record<string, Record<string, string>>>({});
  const [openOutput, setOpenOutput] = useState<string | null>(null);

  const setParam = (actionId: string, key: string, value: string): void => {
    setParamValues((prev) => ({ ...prev, [actionId]: { ...prev[actionId], [key]: value } }));
  };

  const run = async (a: ActionSummary): Promise<void> => {
    setStates((prev) => ({ ...prev, [a.id]: { running: true } }));
    try {
      const r = await fetch('/api/e2e/actions/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ actionId: a.id, params: paramValues[a.id] ?? {} }),
      });
      const result = (await r.json()) as ActionRunState['result'];
      setStates((prev) => ({ ...prev, [a.id]: { running: false, result } }));
      if (result && (!result.ok || result.output)) setOpenOutput(a.id);
    } catch {
      setStates((prev) => ({
        ...prev,
        [a.id]: { running: false, result: { ok: false, error: 'network error' } },
      }));
    }
  };

  return (
    <div className="actions-panel">
      <div className="pane-head">Actions</div>
      {actions.length === 0 ? (
        <div className="empty empty-guide">
          <div className="empty-title">No learned actions</div>
          <div>Save a verified flow with cdp_record_test_save_as_action and it appears here.</div>
        </div>
      ) : (
        <table className="reg-table actions-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Intent</th>
              <th>Status</th>
              <th>Params</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {actions.map((a) => {
              const st = states[a.id];
              const missing = st?.result?.missingParams ?? [];
              return (
                <ActionRow
                  key={a.id}
                  action={a}
                  state={st}
                  missing={missing}
                  values={paramValues[a.id] ?? {}}
                  onParam={(k, v) => setParam(a.id, k, v)}
                  onRun={() => void run(a)}
                  outputOpen={openOutput === a.id}
                  onToggleOutput={() => setOpenOutput(openOutput === a.id ? null : a.id)}
                />
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface ActionRowProps {
  action: ActionSummary;
  state?: ActionRunState;
  missing: string[];
  values: Record<string, string>;
  onParam: (key: string, value: string) => void;
  onRun: () => void;
  outputOpen: boolean;
  onToggleOutput: () => void;
}

function ActionRow({
  action: a,
  state: st,
  missing,
  values,
  onParam,
  onRun,
  outputOpen,
  onToggleOutput,
}: ActionRowProps): JSX.Element {
  const res = st?.result;
  return (
    <>
      <tr>
        <td className="reg-testid">{a.id}</td>
        <td className="actions-intent" title={a.intent}>
          {a.intent}
        </td>
        <td>
          <span className={`reg-badge actions-status-${a.status}`}>{a.status}</span>
          {a.mutates && (
            <span className="actions-mutates" title="mutates state">
              M
            </span>
          )}
        </td>
        <td>
          <span className="actions-params">
            {(a.params ?? []).map((p) => (
              <input
                key={p}
                className={missing.includes(p) ? 'param-input missing' : 'param-input'}
                placeholder={p}
                value={values[p] ?? ''}
                onChange={(e) => onParam(p, e.target.value)}
              />
            ))}
          </span>
        </td>
        <td className="actions-run-cell">
          <button className="actions-run-btn" disabled={st?.running} onClick={onRun}>
            {st?.running ? '…' : 'Run'}
          </button>
          {res && (
            <span
              className={res.ok ? 'actions-result-ok' : 'actions-result-fail'}
              onClick={onToggleOutput}
              title="show output"
            >
              {res.ok
                ? '✓ output'
                : res.missingParams
                  ? `missing: ${res.missingParams.join(', ')}`
                  : (res.error ?? 'failed')}
            </span>
          )}
        </td>
      </tr>
      {outputOpen && res && (res.output || res.error) && (
        <tr className="action-output">
          <td colSpan={5}>
            <pre>{res.output ?? res.error}</pre>
          </td>
        </tr>
      )}
    </>
  );
}
```

- [ ] **Step 2: Create `src/components/RegressionView.tsx`**

```tsx
import { useEffect, useState } from 'react';
import type {
  ActionSummary,
  E2eProgress,
  E2eRunDetail,
  E2eRunIndexEntry,
  E2eRunResult,
} from '../types';
import { csrfToken } from '../derive';
import { ActionsPanel } from './ActionsPanel';

interface RegressionViewProps {
  e2eProgress: E2eProgress | null;
  /** From useEventStream — bumps when a suite finishes anywhere (tool or UI). */
  e2eDoneCount: number;
}

export function RegressionView({ e2eProgress, e2eDoneCount }: RegressionViewProps): JSX.Element {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<E2eRunResult | null>(null);
  const [history, setHistory] = useState<E2eRunIndexEntry[]>([]);
  const [actions, setActions] = useState<ActionSummary[]>([]);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [runDetails, setRunDetails] = useState<Record<string, E2eRunDetail | 'loading' | 'error'>>(
    {},
  );

  const fetchHistory = async (): Promise<void> => {
    try {
      const r = await fetch('/api/e2e/runs');
      if (r.ok) setHistory((await r.json()) as E2eRunIndexEntry[]);
    } catch {
      /* non-fatal */
    }
  };

  const fetchActions = async (): Promise<void> => {
    try {
      const r = await fetch('/api/e2e/actions');
      if (r.ok) setActions((await r.json()) as ActionSummary[]);
    } catch {
      /* non-fatal */
    }
  };

  useEffect(() => {
    void fetchHistory();
    void fetchActions();
  }, [e2eDoneCount]);

  const toggleRun = (runId: string): void => {
    const next = openRun === runId ? null : runId;
    setOpenRun(next);
    if (next && runDetails[next] === undefined) {
      setRunDetails((prev) => ({ ...prev, [next]: 'loading' }));
      fetch(`/api/e2e/runs/${encodeURIComponent(next)}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status));
          const detail = (await r.json()) as E2eRunDetail;
          setRunDetails((prev) => ({ ...prev, [next]: detail }));
        })
        .catch(() => {
          setRunDetails((prev) => ({ ...prev, [next]: 'error' }));
        });
    }
  };

  const runSuite = async (): Promise<void> => {
    setRunning(true);
    setResult(null);
    try {
      const r = await fetch('/api/e2e/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: '{}',
      });
      setResult((await r.json()) as E2eRunResult);
      await fetchHistory();
    } catch {
      /* non-fatal */
    } finally {
      setRunning(false);
    }
  };

  const verdict = result?.data?.verdict;
  const newlyFailing = result?.data?.newlyFailing ?? [];

  return (
    <div className="reg-container">
      <ActionsPanel actions={actions} />
      <div className="reg-panel">
        <div className="reg-header">
          <button className="reg-run-btn" disabled={running} onClick={() => void runSuite()}>
            {running ? 'Running…' : 'Run E2E Suite'}
          </button>
          {e2eProgress && (
            <span className="reg-progress mono">
              test {e2eProgress.completed}/{e2eProgress.total} — {e2eProgress.lastTestId}
            </span>
          )}
          {verdict && (
            <span
              className={`reg-verdict ${verdict === 'green' ? 'pass' : verdict === 'empty' ? 'none' : 'fail'}`}
            >
              {verdict === 'green' ? 'PASS' : verdict === 'empty' ? 'NO TESTS' : 'FAIL'}
            </span>
          )}
          {verdict === 'empty' && (
            <span className="reg-empty-hint">No locked tests — lock one with cdp_lock_e2e_test</span>
          )}
        </div>
        {result?.data?.results && result.data.results.length > 0 && (
          <div className="reg-results">
            <table className="reg-table">
              <thead>
                <tr>
                  <th>Test ID</th>
                  <th>Result</th>
                  <th>Classification</th>
                </tr>
              </thead>
              <tbody>
                {result.data.results.map((r) => (
                  <tr
                    key={r.testId}
                    className={newlyFailing.includes(r.testId) ? 'reg-newly-failing' : ''}
                  >
                    <td className="reg-testid">{r.testId}</td>
                    <td className={r.passed ? 'reg-pass' : 'reg-fail'}>
                      {r.passed ? 'pass' : 'fail'}
                    </td>
                    <td>
                      <span className={`reg-badge reg-badge-${r.classification}`}>
                        {r.classification}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="reg-history">
        <div className="pane-head">Run History</div>
        {history.length === 0 ? (
          <div className="empty">no runs yet</div>
        ) : (
          <table className="reg-table">
            <thead>
              <tr>
                <th>Run ID</th>
                <th>Finished</th>
                <th>Verdict</th>
                <th>Pass/Fail/Skip</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <HistoryRow
                  key={h.runId}
                  entry={h}
                  open={openRun === h.runId}
                  detail={runDetails[h.runId]}
                  onToggle={() => toggleRun(h.runId)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

interface HistoryRowProps {
  entry: E2eRunIndexEntry;
  open: boolean;
  detail?: E2eRunDetail | 'loading' | 'error';
  onToggle: () => void;
}

function HistoryRow({ entry: h, open, detail, onToggle }: HistoryRowProps): JSX.Element {
  return (
    <>
      <tr className="hist-row" onClick={onToggle}>
        <td className="reg-testid">
          {open ? '▾ ' : '▸ '}
          {h.runId}
        </td>
        <td>{new Date(h.finishedAt).toLocaleTimeString()}</td>
        <td
          className={
            h.verdict === 'green' ? 'reg-pass' : h.verdict === 'empty' ? 'reg-none' : 'reg-fail'
          }
        >
          {h.verdict === 'green' ? 'PASS' : h.verdict === 'empty' ? 'NO TESTS' : 'FAIL'}
        </td>
        <td>
          {h.totals.passed}/{h.totals.failed}/{h.totals.skipped}
        </td>
      </tr>
      {open && (
        <tr className="hist-detail">
          <td colSpan={4}>
            {detail === 'loading' || detail === undefined ? (
              <div className="empty">loading run…</div>
            ) : detail === 'error' ? (
              <div className="empty">failed to load run detail</div>
            ) : (
              <>
                <div className="hist-meta mono">
                  {detail.platform} · {Math.round(detail.durationMs / 1000)}s ·{' '}
                  {new Date(detail.startedAt).toLocaleTimeString()} →{' '}
                  {new Date(detail.finishedAt).toLocaleTimeString()}
                </div>
                {detail.results.map((r) => (
                  <div key={r.testId}>
                    <span className={r.passed ? 'reg-pass' : 'reg-fail'}>
                      {r.passed ? '✓' : '✗'}
                    </span>{' '}
                    <span className="reg-testid">{r.testId}</span>{' '}
                    <span className={`reg-badge reg-badge-${r.classification}`}>
                      {r.classification}
                    </span>
                    {r.durationMs != null && <span className="mono"> {r.durationMs}ms</span>}
                    {r.errorExcerpt && <div className="errx">{r.errorExcerpt}</div>}
                  </div>
                ))}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
```

- [ ] **Step 3: Type gate + commit**

```bash
cd src/observability/web && npx tsc --noEmit
git add src/components/ActionsPanel.tsx src/components/RegressionView.tsx
git commit -m "feat(observe-ui): action param inputs + run output, e2e history drill-down"
```

---

### Task 7: New `main.tsx` shell — flip the app over

**Files:**
- Modify: `scripts/cdp-bridge/src/observability/web/src/main.tsx` (full replacement — the old inline components, helpers, and CSS string are deleted; everything now comes from the Task 2–6 modules)

**Interfaces:**
- Consumes: everything produced by Tasks 2–6.

- [ ] **Step 1: Replace `src/main.tsx` with**

```tsx
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentEvent, Family } from './types';
import { CSS, FAMILIES } from './theme';
import { appOf, latestByFamily, latestByTool, routeOf } from './derive';
import { useEventStream } from './hooks/useEventStream';
import { Header, type View } from './components/Header';
import { FilterBar } from './components/FilterBar';
import { Timeline } from './components/Timeline';
import { DevicePane } from './components/DevicePane';
import { StatePane } from './components/StatePane';
import { RegressionView } from './components/RegressionView';

const RENDER_ROWS = 250;

function App(): JSX.Element {
  const { events, conn, liveShotSeq, liveRoute, e2eProgress, e2eDoneCount } = useEventStream();
  const [view, setView] = useState<View>('live');
  const [selected, setSelected] = useState<number | null>(null);
  const [activeFamilies, setActiveFamilies] = useState<ReadonlySet<Family>>(new Set(FAMILIES));
  const [search, setSearch] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);

  const toggleFamily = (f: Family): void => {
    setActiveFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };

  const counts = useMemo(() => {
    const c = Object.fromEntries(FAMILIES.map((f) => [f, 0])) as Record<Family, number>;
    for (const e of events) c[e.family] = (c[e.family] ?? 0) + 1;
    return c;
  }, [events]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (e: AgentEvent): boolean => {
      if (!activeFamilies.has(e.family)) return false;
      if (errorsOnly && e.ok) return false;
      if (q && !e.tool.toLowerCase().includes(q) && !e.summary.toLowerCase().includes(q))
        return false;
      return true;
    };
    const out = events.filter(match);
    return out.length > RENDER_ROWS ? out.slice(out.length - RENDER_ROWS) : out;
  }, [events, activeFamilies, search, errorsOnly]);

  const navEv =
    latestByTool(events, ['cdp_navigation_state']) ?? latestByFamily(events, 'navigation');
  const storeEv = latestByTool(events, ['cdp_store_state']);
  const treeEv = latestByTool(events, ['cdp_component_tree']);
  const shotEv = latestByTool(events, ['device_screenshot']);
  const route = liveRoute ?? routeOf(navEv) ?? null;
  const app = appOf(events);

  return (
    <div className="app">
      <Header
        conn={conn}
        app={app}
        route={route ?? undefined}
        events={events}
        view={view}
        onViewChange={setView}
      />
      {view === 'live' ? (
        <div className="panes">
          <div className="pane left">
            <FilterBar
              counts={counts}
              active={activeFamilies}
              onToggleFamily={toggleFamily}
              search={search}
              onSearch={setSearch}
              errorsOnly={errorsOnly}
              onErrorsOnly={setErrorsOnly}
            />
            <Timeline
              events={filtered}
              totalCount={events.length}
              selected={selected}
              onSelect={setSelected}
            />
          </div>
          <DevicePane
            liveShotSeq={liveShotSeq}
            fallbackSeq={shotEv && shotEv.ok ? shotEv.seq : null}
            route={route}
          />
          <StatePane navEv={navEv} storeEv={storeEv} treeEv={treeEv} liveRoute={liveRoute} />
        </div>
      ) : (
        <RegressionView e2eProgress={e2eProgress} e2eDoneCount={e2eDoneCount} />
      )}
    </div>
  );
}

const style = document.createElement('style');
style.textContent = CSS;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<App />);
```

Behavior notes vs. the old shell (for the reviewer):
- `shotEv` now uses `latestByTool` + `ok` guard instead of the old `[...events].reverse().find(...)` — same result, no copy.
- The old `device_screenshot` fallback filtered on `family === 'introspection'` AND tool — tool name alone is sufficient (family is derived from the tool).
- `RENDER_ROWS` capping moved after filtering so a filter can surface older rows that the cap would have hidden.
- Filter/search/errors state lives here (not in FilterBar) so `filtered` feeds both Timeline and the "showing X of Y" note.

- [ ] **Step 2: Type + build + bundle into dist**

```bash
cd src/observability/web && npx tsc --noEmit && cd ../../..
npm run build:web
ls dist/observability/web-dist/index.html
```

Expected: type check clean, vite build succeeds, single-file bundle exists.

- [ ] **Step 3: Smoke the built UI against a real server**

Run the unit suite first (`npm test` — server + tool tests must stay green), then live-drive it:

1. In an RN project session with the locally-built plugin: `observe` tool `action: "start"` → open the URL.
2. Live view: events stream in; family chips filter; search narrows; errors-only isolates failures; scrolling up pauses autoscroll and shows "↓ latest (N new)"; clicking it resumes; screenshot renders in the device frame with the route chip; state tabs show route/store/tree with the new empty hints.
3. Regression view: actions table renders; an action with params shows inline inputs; running with a typed param succeeds (Task 1 server change); the ✓/✗ toggles the output row; Run History rows expand and load per-flow detail with error excerpts.
4. `observe` tool `action: "restart"` → reload the tab → timeline still shows pre-restart events.

- [ ] **Step 4: Commit**

```bash
git add src/observability/web/src/main.tsx
git commit -m "feat(observe-ui): new app shell — filterable timeline, session header, device hero, regression drill-down"
```

---

### Task 8: Gates + changeset

**Files:**
- Create: `.changeset/observe-ui-overhaul.md`

- [ ] **Step 1: Full gates**

```bash
cd scripts/cdp-bridge && npm test && npm run build:web
cd ../.. && npx oxlint && npx oxfmt --check
```

Expected: all pass (run `npx oxfmt` to fix formatting if needed).

- [ ] **Step 2: Create the changeset**

Create `.changeset/observe-ui-overhaul.md`:

```markdown
---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

Observe web UI overhaul: session header (connection, app, route, duration, call/error stats),
filterable + searchable timeline with follow/pause autoscroll, device-screenshot hero pane with
route chip, guided empty states, inline param inputs for learned actions (server now honors
UI-provided params), expandable action output, and E2E run-history drill-down with per-flow
error excerpts. The SPA is split from one 670-line file into focused modules.
```

- [ ] **Step 3: Commit**

```bash
git add .changeset/observe-ui-overhaul.md
git commit -m "chore: changeset for observe UI overhaul"
```
