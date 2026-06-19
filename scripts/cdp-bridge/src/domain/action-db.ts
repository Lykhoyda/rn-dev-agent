// Action DB — node:sqlite wrapper for the action corpus store.
//
// Opens (or creates) the per-project `.rn-agent/state/actions.db` SQLite
// database, runs schema migrations, and sets WAL + busy_timeout PRAGMAs.
//
// Gracefully degrades: when `node:sqlite` is unavailable (Node < 22.5 or
// missing flag) `openActionDb` returns null without throwing so callers
// can fall back to JSON sidecars.

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const _require = createRequire(import.meta.url);

// ─── Minimal structural type for node:sqlite's DatabaseSync ──────────────────
// @types/node@24 provides these too; this local type keeps the wrapper
// decoupled from the devDependency version and avoids ambient-import
// noise in tests that mock the ctor.

type PreparedStatement = {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

type DatabaseSyncCtor = new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  close(): void;
};

// ─── Public interface ─────────────────────────────────────────────────────────

export interface ActionDb {
  db: InstanceType<DatabaseSyncCtor>;
  close(): void;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA busy_timeout=5000;
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS actions_index (
  id             TEXT PRIMARY KEY,
  app_id         TEXT,
  path           TEXT,
  content_hash   TEXT,
  status         TEXT,
  revision       INTEGER,
  created_at     INTEGER,
  updated_at     INTEGER,
  mtime_baseline INTEGER,
  stats_json     TEXT
);

CREATE TABLE IF NOT EXISTS run_records (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id       TEXT,
  ts              TEXT,
  trigger         TEXT,
  status          TEXT,
  failure_code    TEXT,
  failure_detail  TEXT,
  transport       TEXT,
  auto_repair_json TEXT,
  duration_ms     INTEGER
);

CREATE TABLE IF NOT EXISTS repair_records (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id        TEXT,
  ts               TEXT,
  failure_code     TEXT,
  diff_json        TEXT,
  duration_ms      INTEGER,
  agent_reasoning  TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_action    ON run_records(action_id);
CREATE INDEX IF NOT EXISTS idx_repair_action ON repair_records(action_id);
CREATE INDEX IF NOT EXISTS idx_index_app     ON actions_index(app_id);
`;

// ─── ESM-safe dynamic loader ──────────────────────────────────────────────────

/**
 * Returns the `DatabaseSync` constructor from `node:sqlite`, or `null`
 * when the module is unavailable (Node < 22.5, or the experimental flag
 * is required and absent).
 *
 * Uses `createRequire` so the dynamic `require` works in an ESM context
 * (`package.json` has `"type": "module"`). A static `import` would throw
 * un-catchably on unsupported runtimes; a bare `require` is `undefined`
 * in ESM. The try/catch ensures callers always get null rather than a
 * thrown exception when sqlite is absent.
 */
export function loadSqlite(): DatabaseSyncCtor | null {
  try {
    const mod = _require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
    return mod.DatabaseSync ?? null;
  } catch {
    return null;
  }
}

// ─── Open + initialize ────────────────────────────────────────────────────────

/**
 * Opens the action DB at `<projectRoot>/.rn-agent/state/actions.db`,
 * runs the schema (CREATE TABLE IF NOT EXISTS + indexes), and sets
 * PRAGMA busy_timeout + journal_mode=WAL.
 *
 * Returns `null` when:
 *   - `node:sqlite` is unavailable (graceful degradation)
 *   - `opts.sqliteCtor` is explicitly `null` (test seam)
 *   - The DB open or schema exec fails for any reason
 *
 * @param projectRoot  Absolute path to the RN project root.
 * @param opts.sqliteCtor  Override the DatabaseSync ctor (pass `null`
 *                         to force the null-degradation path in tests).
 */
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
