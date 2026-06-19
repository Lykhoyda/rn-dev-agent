# Action Storage Persistence — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-action JSON sidecars with a derived, gitignored `node:sqlite` store for the action corpus index + run/repair history, degrading gracefully to the legacy sidecars when SQLite is unavailable.

**Architecture:** YAML stays the git-tracked source of truth. A new `domain/action-db.ts` owns a rebuildable `.rn-agent/state/actions.db`. A facade (`domain/action-state-store.ts`) presents the existing `loadOrInitSidecar`/`saveSidecar` shape, choosing the DB backend when `node:sqlite` loads and the legacy JSON sidecar otherwise. The pure state-transition helpers (`appendRunRecord`, `appendRepairRecord`) are unchanged — only the load/save backend moves.

**Tech Stack:** TypeScript (Node ≥ 22.5), `node:sqlite` (built-in, `--experimental-sqlite`), `node:test`, `node:fs`.

## Global Constraints

- Node engines floor: **`>=22.5.0`** (was `>=22`).
- Worker process must run with **`--experimental-sqlite`** (supervisor passes it; on Node ≥ 23.6 it is a no-op default-on).
- **Zero new npm dependencies** — `node:sqlite` is built-in. No native addons.
- **All source is TypeScript**; explicit type imports (`import type { ... }`); no unnecessary comments.
- Test files stay **`.js`** under `test/unit/**/*.test.js` (the `node:test` convention CI runs as of #340).
- The DB is **derived and rebuildable** from YAML + sidecars; never the source of truth.
- A failure to open/use the DB must **never throw** to a tool caller — degrade to legacy files.
- Add a **changeset** (`rn-dev-agent-cdp`, minor) — this changes shippable `scripts/cdp-bridge/src/`.

---

## File Structure

- **Create** `scripts/cdp-bridge/src/domain/action-db.ts` — `node:sqlite` wrapper: feature-detect + `open`, schema init, typed row CRUD, `loadState`/`saveState` (serialize `ActionRuntimeState`), `migrateSidecars`, `recentRepairCountFromDb`.
- **Create** `scripts/cdp-bridge/src/domain/action-state-store.ts` — backend-selecting facade: `loadOrInitState`, `saveState`, `storeMode`. Delegates to `action-db.ts` or `sidecar-io.ts`.
- **Modify** `scripts/cdp-bridge/src/tools/run-action.ts` — persist RunRecords through the facade.
- **Modify** `scripts/cdp-bridge/src/tools/repair-action.ts` — append RepairRecords + read repair budget through the facade.
- **Modify** `scripts/cdp-bridge/src/tools/save-as-action.ts` — initial state through the facade.
- **Modify** `scripts/cdp-bridge/src/tools/status.ts` — add `actionStore` to the status payload.
- **Modify** `scripts/cdp-bridge/src/supervisor.ts:61` — add `--experimental-sqlite` to the worker spawn.
- **Modify** `scripts/cdp-bridge/package.json` — `engines.node` → `>=22.5.0`.
- **Migrate** `scripts/learned-actions.mjs` → `scripts/learned-actions.ts`; update command/agent invocations.
- **Modify** the `.rn-agent/.gitignore` scaffold to ignore `state/*.db*`.
- **Tests** under `scripts/cdp-bridge/test/unit/domain/` and `test/unit/tools/`.

---

## Task 1: `action-db.ts` — open + schema + graceful degradation

**Files:**
- Create: `scripts/cdp-bridge/src/domain/action-db.ts`
- Test: `scripts/cdp-bridge/test/unit/domain/action-db.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `loadSqlite(): DatabaseSyncCtor | null` — returns `node:sqlite`'s `DatabaseSync` class, or `null` if unavailable.
  - `openActionDb(projectRoot: string): ActionDb | null` — opens `<projectRoot>/.rn-agent/state/actions.db`, initializes schema, returns a handle; `null` when SQLite is unavailable or open fails.
  - `interface ActionDb { db: unknown; close(): void }` (extended in later tasks).

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { openActionDb, loadSqlite } = require('../../../dist/domain/action-db.js');

test('openActionDb creates the db file + schema when node:sqlite is available', () => {
  if (!loadSqlite()) return; // environment without node:sqlite — covered by Task 1b
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-'));
  const handle = openActionDb(root);
  assert.ok(handle, 'expected a handle when sqlite is available');
  assert.ok(existsSync(join(root, '.rn-agent', 'state', 'actions.db')));
  const rows = handle.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all();
  const names = rows.map((r) => r.name);
  assert.deepEqual(names, ['actions_index', 'repair_records', 'run_records']);
  handle.close();
});

test('openActionDb returns null and never throws when sqlite is unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-'));
  const handle = openActionDb(root, { sqliteCtor: null });
  assert.equal(handle, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/domain/action-db.test.js`
Expected: FAIL — `Cannot find module '../../../dist/domain/action-db.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/cdp-bridge/src/domain/action-db.ts
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

type DatabaseSyncCtor = new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
};

export interface ActionDb {
  db: InstanceType<DatabaseSyncCtor>;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS actions_index (
  id TEXT PRIMARY KEY, app_id TEXT, path TEXT, content_hash TEXT,
  status TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER,
  mtime_baseline INTEGER
);
CREATE TABLE IF NOT EXISTS run_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT, ts TEXT,
  trigger TEXT, status TEXT, failure_code TEXT, transport TEXT,
  auto_repair_json TEXT, duration_ms INTEGER
);
CREATE TABLE IF NOT EXISTS repair_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT, ts TEXT,
  failure_code TEXT, diff_json TEXT, duration_ms INTEGER, agent_reasoning TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_action ON run_records(action_id);
CREATE INDEX IF NOT EXISTS idx_repair_action ON repair_records(action_id);
CREATE INDEX IF NOT EXISTS idx_index_app ON actions_index(app_id);
`;

export function loadSqlite(): DatabaseSyncCtor | null {
  try {
    const mod = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
    return mod.DatabaseSync ?? null;
  } catch {
    return null;
  }
}

export function openActionDb(
  projectRoot: string,
  opts: { sqliteCtor?: DatabaseSyncCtor | null } = {},
): ActionDb | null {
  const Ctor = opts.sqliteCtor === undefined ? loadSqlite() : opts.sqliteCtor;
  if (!Ctor) return null;
  try {
    const dbPath = join(projectRoot, '.rn-agent', 'state', 'actions.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Ctor(dbPath);
    db.exec(SCHEMA);
    return { db, close: () => db.close() };
  } catch {
    return null;
  }
}
```

> Note: `require` is available because the bridge builds to CJS. If the build is ESM, use `createRequire(import.meta.url)` at module top and call that — confirm the existing module format in `tsconfig`/`esbuild` config and match it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/domain/action-db.test.js`
Expected: PASS (2 tests; first is a no-op if `node:sqlite` is absent in the dev env).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/action-db.ts scripts/cdp-bridge/test/unit/domain/action-db.test.js
git commit -m "feat(actions): node:sqlite store — open + schema + graceful degradation"
```

---

## Task 2: `action-db.ts` — state load/save round-trip

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/action-db.ts`
- Test: `scripts/cdp-bridge/test/unit/domain/action-db.test.js`

**Interfaces:**
- Consumes: `ActionRuntimeState`, `RunRecord`, `RepairRecord` from `./reusable-action.js`; `ActionDb` from Task 1.
- Produces (added to `ActionDb`):
  - `loadState(actionId: string): ActionRuntimeState | null` — reconstructs the sidecar-shaped state from `actions_index` + `run_records` + `repair_records`; `null` if the action id is absent.
  - `saveState(actionId: string, state: ActionRuntimeState, meta?: { appId?: string; path?: string; contentHash?: string }): void` — upserts the index row and **replaces** the run/repair rows for the action (history is already capped by `appendRunRecord`).

- [ ] **Step 1: Write the failing test**

```js
test('saveState then loadState round-trips run + repair history and stats', () => {
  if (!loadSqlite()) return;
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-'));
  const handle = openActionDb(root);
  const { freshRuntimeState, appendRunRecord } = require('../../../dist/domain/reusable-action.js');
  let state = freshRuntimeState(() => new Date('2026-06-19T00:00:00Z'), 111);
  state = appendRunRecord(state, {
    timestamp: '2026-06-19T00:01:00Z', durationMs: 4200, status: 'pass', trigger: 'agent',
  });
  handle.saveState('login', state, { appId: 'com.x.app', path: '/p/login.yaml', contentHash: 'abc' });

  const loaded = handle.loadState('login');
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.runHistory.length, 1);
  assert.equal(loaded.runHistory[0].status, 'pass');
  assert.equal(loaded.stats.totalRuns, 1);
  assert.equal(loaded.stats.successCount, 1);
  assert.equal(loaded.lastSeenMtimeMs, 111);
  assert.equal(handle.loadState('missing'), null);
  handle.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/domain/action-db.test.js`
Expected: FAIL — `handle.saveState is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `openActionDb`'s returned object (build the helpers over `db`):

```ts
import type { ActionRuntimeState, RunRecord, RepairRecord } from './reusable-action.js';

// inside openActionDb, after `const db = new Ctor(dbPath); db.exec(SCHEMA);`
const api: ActionDb = {
  db,
  close: () => db.close(),
  loadState(actionId: string): ActionRuntimeState | null {
    const idx = db.prepare('SELECT * FROM actions_index WHERE id = ?').get(actionId) as
      | Record<string, unknown>
      | undefined;
    if (!idx) return null;
    const runs = db.prepare('SELECT * FROM run_records WHERE action_id = ? ORDER BY id').all(actionId) as Record<string, unknown>[];
    const repairs = db.prepare('SELECT * FROM repair_records WHERE action_id = ? ORDER BY id').all(actionId) as Record<string, unknown>[];
    const runHistory: RunRecord[] = runs.map((r) => ({
      timestamp: String(r.ts), durationMs: Number(r.duration_ms), status: r.status as 'pass' | 'fail',
      ...(r.failure_code ? { failureCode: r.failure_code as RunRecord['failureCode'] } : {}),
      trigger: r.trigger as RunRecord['trigger'],
      ...(r.transport ? { transport: 'cdp-js' as const } : {}),
      ...(r.auto_repair_json ? { autoRepair: JSON.parse(String(r.auto_repair_json)) } : {}),
    }));
    const repairHistory: RepairRecord[] = repairs.map((r) => ({
      timestamp: String(r.ts), failureCode: r.failure_code as RepairRecord['failureCode'],
      diff: r.diff_json ? JSON.parse(String(r.diff_json)) : {}, durationMs: Number(r.duration_ms),
      ...(r.agent_reasoning ? { agentReasoning: String(r.agent_reasoning) } : {}),
    }));
    return recomputeStateShell(idx, runHistory, repairHistory);
  },
  saveState(actionId, state, meta = {}) {
    const tx = db.prepare.bind(db);
    db.exec('BEGIN');
    try {
      tx(
        `INSERT INTO actions_index (id, app_id, path, content_hash, status, revision, created_at, updated_at, mtime_baseline)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET app_id=excluded.app_id, path=excluded.path,
           content_hash=excluded.content_hash, status=excluded.status, revision=excluded.revision,
           updated_at=excluded.updated_at, mtime_baseline=excluded.mtime_baseline`,
      ).run(actionId, meta.appId ?? null, meta.path ?? null, meta.contentHash ?? null, null,
            state.revision, Date.parse(state.updatedAt) || 0, Date.parse(state.updatedAt) || 0,
            state.lastSeenMtimeMs);
      tx('DELETE FROM run_records WHERE action_id = ?').run(actionId);
      tx('DELETE FROM repair_records WHERE action_id = ?').run(actionId);
      for (const r of state.runHistory) {
        tx(`INSERT INTO run_records (action_id, ts, trigger, status, failure_code, transport, auto_repair_json, duration_ms)
            VALUES (?,?,?,?,?,?,?,?)`).run(actionId, r.timestamp, r.trigger, r.status,
            r.failureCode ?? null, r.transport ?? null, r.autoRepair ? JSON.stringify(r.autoRepair) : null, r.durationMs);
      }
      for (const r of state.repairHistory) {
        tx(`INSERT INTO repair_records (action_id, ts, failure_code, diff_json, duration_ms, agent_reasoning)
            VALUES (?,?,?,?,?,?)`).run(actionId, r.timestamp, r.failureCode,
            JSON.stringify(r.diff ?? {}), r.durationMs, r.agentReasoning ?? null);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
};
return api;
```

Add a small pure helper near the bottom of the module that rebuilds the `stats` from history (mirrors `appendRunRecord`'s stats math so a DB-loaded state equals a sidecar-loaded one):

```ts
function recomputeStateShell(
  idx: Record<string, unknown>,
  runHistory: RunRecord[],
  repairHistory: RepairRecord[],
): ActionRuntimeState {
  const successes = runHistory.filter((r) => r.status === 'pass');
  const failures = runHistory.filter((r) => r.status === 'fail');
  const avg = successes.length
    ? Math.round(successes.reduce((a, r) => a + r.durationMs, 0) / successes.length)
    : 0;
  return {
    schemaVersion: 1,
    revision: Number(idx.revision) || 1,
    updatedAt: new Date(Number(idx.updated_at) || 0).toISOString(),
    lastSeenMtimeMs: Number(idx.mtime_baseline) || 0,
    runHistory,
    repairHistory,
    stats: {
      totalRuns: runHistory.length,
      successCount: successes.length,
      failureCount: failures.length,
      avgDurationMs: avg,
      ...(successes.length ? { lastSuccessAt: successes[successes.length - 1].timestamp } : {}),
      ...(failures.length ? { lastFailureAt: failures[failures.length - 1].timestamp } : {}),
    },
  };
}
```

Update `ActionDb` interface to declare `loadState`/`saveState`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/domain/action-db.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/action-db.ts scripts/cdp-bridge/test/unit/domain/action-db.test.js
git commit -m "feat(actions): db state load/save round-trip with stats recompute"
```

---

## Task 3: `action-db.ts` — migrate existing JSON sidecars

**Files:**
- Modify: `scripts/cdp-bridge/src/domain/action-db.ts`
- Test: `scripts/cdp-bridge/test/unit/domain/action-db.test.js`

**Interfaces:**
- Consumes: `loadOrInitSidecar` from `./sidecar-io.js`; the actions dir layout `<root>/.rn-agent/actions/*.yaml`.
- Produces (added to `ActionDb`): `migrateSidecars(): { migrated: number }` — for each `<root>/.rn-agent/state/<id>.state.json` whose `<id>` has no `actions_index` row, load it and `saveState`. Idempotent.

- [ ] **Step 1: Write the failing test**

```js
test('migrateSidecars imports legacy .state.json files exactly once', () => {
  if (!loadSqlite()) return;
  const { mkdirSync, writeFileSync } = require('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'rn-actiondb-'));
  const stateDir = join(root, '.rn-agent', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'login.state.json'), JSON.stringify({
    schemaVersion: 1, revision: 2, updatedAt: '2026-06-19T00:00:00Z', lastSeenMtimeMs: 9,
    runHistory: [{ timestamp: '2026-06-19T00:00:01Z', durationMs: 10, status: 'pass', trigger: 'agent' }],
    repairHistory: [], stats: { totalRuns: 1, successCount: 1, failureCount: 0, avgDurationMs: 10 },
  }));
  const handle = openActionDb(root);
  assert.equal(handle.migrateSidecars().migrated, 1);
  assert.equal(handle.migrateSidecars().migrated, 0); // idempotent
  assert.equal(handle.loadState('login').runHistory.length, 1);
  handle.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/domain/action-db.test.js`
Expected: FAIL — `handle.migrateSidecars is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';

// add to the api object:
migrateSidecars(): { migrated: number } {
  const stateDir = join(projectRoot, '.rn-agent', 'state');
  if (!existsSync(stateDir)) return { migrated: 0 };
  let migrated = 0;
  for (const f of readdirSync(stateDir)) {
    if (!f.endsWith('.state.json')) continue;
    const id = f.replace(/\.state\.json$/, '');
    const exists = db.prepare('SELECT 1 FROM actions_index WHERE id = ?').get(id);
    if (exists) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(stateDir, f), 'utf8')) as ActionRuntimeState;
      if (parsed?.schemaVersion === 1) {
        api.saveState(id, parsed);
        migrated++;
      }
    } catch {
      /* skip corrupt sidecar — reconcile() in Phase 2 will flag it */
    }
  }
  return { migrated };
}
```

(`api` is the object literal from Task 2; reference it after construction — assign the object to `const api` first, then return it, so `migrateSidecars` can call `api.saveState`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/domain/action-db.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/action-db.ts scripts/cdp-bridge/test/unit/domain/action-db.test.js
git commit -m "feat(actions): migrate legacy JSON sidecars into the db (idempotent)"
```

---

## Task 4: `action-state-store.ts` — backend-selecting facade

**Files:**
- Create: `scripts/cdp-bridge/src/domain/action-state-store.ts`
- Test: `scripts/cdp-bridge/test/unit/domain/action-state-store.test.js`

**Interfaces:**
- Consumes: `openActionDb` (Task 1–3); `loadOrInitSidecar`, `saveSidecar` from `./sidecar-io.js`.
- Produces:
  - `loadOrInitState(yamlFilePath: string, projectRoot: string): ActionRuntimeState` — DB if available (migrating sidecars on first open), else legacy sidecar.
  - `saveState(yamlFilePath: string, projectRoot: string, state: ActionRuntimeState, meta?): void`.
  - `storeMode(projectRoot: string): 'sqlite' | 'legacy-files'`.

The facade derives the action id from the YAML basename (`<id>.yaml`) and opens one DB per `projectRoot` (cache by root to avoid re-opening per call).

- [ ] **Step 1: Write the failing test**

```js
test('facade reports legacy-files and round-trips when sqlite ctor is forced null', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-store-'));
  const { mkdirSync } = require('node:fs');
  mkdirSync(join(root, '.rn-agent', 'actions'), { recursive: true });
  const yaml = join(root, '.rn-agent', 'actions', 'login.yaml');
  require('node:fs').writeFileSync(yaml, 'appId: x\n---\n- launchApp\n');
  const store = require('../../../dist/domain/action-state-store.js');
  // force degraded mode for determinism
  store.__setSqliteCtorForTest(null);
  assert.equal(store.storeMode(root), 'legacy-files');
  const s0 = store.loadOrInitState(yaml, root);
  assert.equal(s0.runHistory.length, 0);
  store.saveState(yaml, root, { ...s0, revision: 2 });
  assert.equal(store.loadOrInitState(yaml, root).revision, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/domain/action-state-store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/cdp-bridge/src/domain/action-state-store.ts
import { basename } from 'node:path';
import type { ActionRuntimeState } from './reusable-action.js';
import { openActionDb, loadSqlite, type ActionDb } from './action-db.js';
import { loadOrInitSidecar, saveSidecar } from './sidecar-io.js';

let sqliteCtorOverride: unknown | undefined; // test seam
export function __setSqliteCtorForTest(ctor: unknown | null): void {
  sqliteCtorOverride = ctor;
  dbCache.clear();
}

const dbCache = new Map<string, ActionDb | null>();

function dbFor(projectRoot: string): ActionDb | null {
  if (dbCache.has(projectRoot)) return dbCache.get(projectRoot)!;
  const handle =
    sqliteCtorOverride === undefined
      ? openActionDb(projectRoot)
      : openActionDb(projectRoot, { sqliteCtor: sqliteCtorOverride as never });
  if (handle) handle.migrateSidecars();
  dbCache.set(projectRoot, handle);
  return handle;
}

const idOf = (yamlFilePath: string): string => basename(yamlFilePath).replace(/\.ya?ml$/i, '');

export function storeMode(projectRoot: string): 'sqlite' | 'legacy-files' {
  return dbFor(projectRoot) ? 'sqlite' : 'legacy-files';
}

export function loadOrInitState(yamlFilePath: string, projectRoot: string): ActionRuntimeState {
  const handle = dbFor(projectRoot);
  if (handle) {
    const existing = handle.loadState(idOf(yamlFilePath));
    if (existing) return existing;
  }
  return loadOrInitSidecar(yamlFilePath); // seeds from mtime; DB row created on first saveState
}

export function saveState(
  yamlFilePath: string,
  projectRoot: string,
  state: ActionRuntimeState,
  meta: { appId?: string; contentHash?: string } = {},
): void {
  const handle = dbFor(projectRoot);
  if (handle) {
    handle.saveState(idOf(yamlFilePath), state, { ...meta, path: yamlFilePath });
    return;
  }
  saveSidecar(yamlFilePath, state);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/domain/action-state-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/domain/action-state-store.ts scripts/cdp-bridge/test/unit/domain/action-state-store.test.js
git commit -m "feat(actions): backend-selecting state-store facade (db | legacy sidecar)"
```

---

## Task 5: Wire tool call-sites to the facade

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/run-action.ts` (the `appendRunRecord` persistence around line 677–719)
- Modify: `scripts/cdp-bridge/src/tools/repair-action.ts` (RepairRecord append + budget read; `saveAction` call ~line 375)
- Modify: `scripts/cdp-bridge/src/tools/save-as-action.ts` (initial state pair-write ~line 151–158)
- Test: `scripts/cdp-bridge/test/unit/tools/run-action-persistence.test.js`

**Interfaces:**
- Consumes: `loadOrInitState`, `saveState` from `../domain/action-state-store.js`.
- Produces: no new exports; behavior change only — RunRecords/RepairRecords land in the DB when available.

Replace direct `loadOrInitSidecar`/`saveSidecar` (and the sidecar half of `saveAction`'s pair-write) with the facade. The pure `appendRunRecord`/`appendRepairRecord` calls are unchanged; only where the resulting state is **persisted** changes. `repair-action.ts`'s budget check switches from `recentRepairCount(state, ...)` over the sidecar to the same count over the facade-loaded state (identical data, now DB-backed). Pass the resolved `projectRoot` (already available via `projectRootFor()` at the call sites) into the facade.

- [ ] **Step 1: Write the failing test**

```js
test('run-action persistence writes a RunRecord retrievable via the store facade', () => {
  if (!require('../../../dist/domain/action-db.js').loadSqlite()) return;
  const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const root = mkdtempSync(join(tmpdir(), 'rn-runpersist-'));
  const yaml = join(root, '.rn-agent', 'actions', 'login.yaml');
  mkdirSync(join(root, '.rn-agent', 'actions'), { recursive: true });
  writeFileSync(yaml, 'appId: com.x\n---\n- launchApp\n');
  const store = require('../../../dist/domain/action-state-store.js');
  const { appendRunRecord } = require('../../../dist/domain/reusable-action.js');
  let s = store.loadOrInitState(yaml, root);
  s = appendRunRecord(s, { timestamp: '2026-06-19T00:00:00Z', durationMs: 1, status: 'pass', trigger: 'agent' });
  store.saveState(yaml, root, s, { appId: 'com.x' });
  assert.equal(store.loadOrInitState(yaml, root).runHistory.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/tools/run-action-persistence.test.js`
Expected: PASS for the store path, but the wiring tasks below are verified by the **existing** run-action/repair-action suites still passing after the swap. (If the store test already passes, treat the wiring as a refactor guarded by the existing tests — run them in Step 4.)

- [ ] **Step 3: Make the edits**

In each of the three tool files, replace `import { loadOrInitSidecar, saveSidecar } from '../domain/sidecar-io.js'` usages with the facade (`loadOrInitState`/`saveState`), threading `projectRoot`. For `save-as-action.ts`, keep the YAML write (the `atomicWriter` YAML half) and route the sidecar half through `saveState` so the initial row is created. Leave `sidecar-io.ts` intact (the facade falls back to it).

- [ ] **Step 4: Run the full action suites to verify no regression**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/**/*.test.js' 2>&1 | tail -4`
Expected: all pass (existing run-action / repair-action / save-as-action tests green; new persistence test green).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/run-action.ts scripts/cdp-bridge/src/tools/repair-action.ts scripts/cdp-bridge/src/tools/save-as-action.ts scripts/cdp-bridge/test/unit/tools/run-action-persistence.test.js
git commit -m "refactor(actions): persist run/repair state through the db-backed store facade"
```

---

## Task 6: `cdp_status.actionStore` visibility

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/status.ts`
- Test: `scripts/cdp-bridge/test/unit/status-actionstore.test.js`

**Interfaces:**
- Consumes: `storeMode` from `../domain/action-state-store.js`.
- Produces: status payload gains `actionStore: 'sqlite' | 'legacy-files'`.

- [ ] **Step 1: Write the failing test**

```js
test('cdp_status payload includes actionStore reflecting the active backend', () => {
  const store = require('../../dist/domain/action-state-store.js');
  // unit-level: assert storeMode is one of the allowed literals for a temp root
  const { mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const mode = store.storeMode(mkdtempSync(join(tmpdir(), 'rn-status-')));
  assert.ok(['sqlite', 'legacy-files'].includes(mode));
});
```

- [ ] **Step 2: Run test to verify it fails / passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/status-actionstore.test.js`
Expected: PASS at the unit level. Then wire `actionStore: storeMode(projectRootFor())` into the status object in `status.ts` (find the object the handler returns; add the field next to `deviceSession`).

- [ ] **Step 3: Add the field in `status.ts`**

```ts
import { storeMode } from '../domain/action-state-store.js';
// in the status result object:
actionStore: storeMode(projectRoot),
```

- [ ] **Step 4: Verify build + full suite**

Run: `cd scripts/cdp-bridge && npm run build && node --test 'test/unit/**/*.test.js' 2>&1 | tail -3`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/status.ts scripts/cdp-bridge/test/unit/status-actionstore.test.js
git commit -m "feat(status): report actionStore backend (sqlite | legacy-files)"
```

---

## Task 7: Enable `node:sqlite` — supervisor flag + engines bump + gitignore

**Files:**
- Modify: `scripts/cdp-bridge/src/supervisor.ts:61`
- Modify: `scripts/cdp-bridge/package.json` (`engines.node`)
- Modify: the `.rn-agent/.gitignore` scaffold (locate via `grep -rn "rn-agent/.gitignore\|state/e2e-runs" scripts commands skills`)
- Test: `scripts/cdp-bridge/test/unit/supervisor-sqlite-flag.test.js`

**Interfaces:**
- Produces: extract the worker arg list into a pure exported helper for testability: `export function workerSpawnArgs(workerPath: string): string[]`.

- [ ] **Step 1: Write the failing test**

```js
const { workerSpawnArgs } = require('../../dist/supervisor.js');
test('workerSpawnArgs enables node:sqlite before the worker script', () => {
  const args = workerSpawnArgs('/abs/dist/index.js');
  assert.deepEqual(args, ['--experimental-sqlite', '/abs/dist/index.js', '--no-lock']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/supervisor-sqlite-flag.test.js`
Expected: FAIL — `workerSpawnArgs is not a function`.

- [ ] **Step 3: Implement**

In `supervisor.ts`, add and use the helper:

```ts
export function workerSpawnArgs(workerPath: string): string[] {
  return ['--experimental-sqlite', workerPath, '--no-lock'];
}
// line ~61:
const child = spawn(process.execPath, workerSpawnArgs(workerPath), { ... });
```

Bump `scripts/cdp-bridge/package.json`: `"engines": { "node": ">=22.5.0" }`.

Add to the `.rn-agent/.gitignore` scaffold (next to `state/e2e-runs/`):
```
# Derived action store (rebuildable from YAML) — never committed
state/*.db
state/*.db-journal
state/*.db-wal
```

- [ ] **Step 4: Verify**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/supervisor-sqlite-flag.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/supervisor.ts scripts/cdp-bridge/package.json scripts/cdp-bridge/test/unit/supervisor-sqlite-flag.test.js
# plus the gitignore-scaffold file you located
git commit -m "feat(actions): enable node:sqlite (supervisor flag, engines>=22.5, gitignore db)"
```

---

## Task 8: Migrate `learned-actions.mjs` → TypeScript

**Files:**
- Create: `scripts/learned-actions.ts` (port of `scripts/learned-actions.mjs`)
- Delete: `scripts/learned-actions.mjs` (after invocations updated)
- Modify: command/agent files that invoke it (locate via `grep -rn "learned-actions.mjs" commands skills agents .claude-plugin`)
- Test: `scripts/cdp-bridge/test/unit/learned-actions-inventory.test.js` (behavioral parity)

**Interfaces:**
- Produces: same CLI surface/output as the `.mjs`. Run mechanism: `node --experimental-strip-types scripts/learned-actions.ts` (Node ≥ 22.6).

- [ ] **Step 1: Capture current behavior as a golden test** (run the existing `.mjs` against a fixture corpus, snapshot its JSON/stdout) so the port is verified equal.

```js
test('learned-actions TS port emits the same inventory as the .mjs for a fixture corpus', () => {
  // build a fixture .rn-agent/actions corpus in a temp dir, run both, compare normalized output
  // (exact harness: spawn `node --experimental-strip-types scripts/learned-actions.ts <root>`
  //  and assert the parsed inventory equals the known fixture inventory)
});
```

- [ ] **Step 2: Run to verify it fails** (TS file absent).
- [ ] **Step 3: Port the module** — copy `.mjs` to `.ts`, add explicit types (`import type { ... }`), no logic change. Update invocations to `node --experimental-strip-types scripts/learned-actions.ts`.
- [ ] **Step 4: Run the parity test** — Expected: PASS; delete the `.mjs`.
- [ ] **Step 5: Commit**

```bash
git add scripts/learned-actions.ts scripts/cdp-bridge/test/unit/learned-actions-inventory.test.js
git rm scripts/learned-actions.mjs
# plus updated command/agent invocation files
git commit -m "refactor: migrate learned-actions.mjs to TypeScript (type-stripped run)"
```

---

## Task 9: Changeset + docs

**Files:**
- Create: `.changeset/action-storage-phase1.md`
- Modify: `CLAUDE.md` (Key Technical Decisions — add the store note)

- [ ] **Step 1:** Write the changeset:

```md
---
"rn-dev-agent-cdp": minor
---

Action corpus run/repair history now persists in a derived, gitignored node:sqlite store (.rn-agent/state/actions.db) instead of per-action JSON sidecars, with graceful degradation to the legacy sidecars when node:sqlite is unavailable. YAML remains the git-tracked source of truth. Engines floor raised to node>=22.5; cdp_status reports the active actionStore backend.
```

- [ ] **Step 2:** Add a one-line note under CLAUDE.md "Key Technical Decisions": `Action run/repair history persists in a derived node:sqlite store (rebuildable from YAML); degrades to JSON sidecars — Phase 1 of action-storage-persistence`.
- [ ] **Step 3:** Run the full suite + lint + format:

```bash
cd scripts/cdp-bridge && npm run build && node --test 'test/unit/*.test.js' 'test/unit/**/*.test.js' 2>&1 | tail -3
npm run lint && npm run format:check
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add .changeset/action-storage-phase1.md CLAUDE.md
git commit -m "chore: changeset + docs for action-storage phase 1"
```

---

## Self-Review

**Spec coverage:**
- §2 structured DB + history → Tasks 1–5. ✓
- §2 never-silently-lost → **deferred to Phase 2** by design (reconcile + resolution guard); Phase 1 lays the index that Phase 2 reconciles. ✓ (explicitly out of this plan)
- §4 YAML-primary, DB derived/gitignored → Tasks 1, 7. ✓
- §6 data model → Task 1 schema. ✓
- §8 migration → Task 3; graceful degradation → Tasks 1, 4; engines/flag → Task 7. ✓
- §9 testing in nested `test/unit/domain/` → all tasks. ✓
- §12 all source TS; learned-actions → TS → Task 8; tests stay `.js` → honored. ✓

**Placeholder scan:** Task 8's golden-test harness is described rather than fully coded — acceptable because the exact spawn/normalize harness depends on the `.mjs`'s current output shape, which the implementer reads at Step 1; the parity contract (same inventory) is explicit. All other steps carry real code.

**Type consistency:** `ActionRuntimeState`/`RunRecord`/`RepairRecord` used in Tasks 2–5 match `reusable-action.ts`. `openActionDb(root, {sqliteCtor})`, `loadState`, `saveState`, `storeMode`, `workerSpawnArgs` names are consistent across tasks.
