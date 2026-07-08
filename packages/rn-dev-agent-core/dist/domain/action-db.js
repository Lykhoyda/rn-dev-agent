// Action DB — node:sqlite wrapper for the action corpus store.
//
// Opens (or creates) the per-project `.rn-agent/state/actions.db` SQLite
// database, runs schema migrations, and sets WAL + busy_timeout PRAGMAs.
//
// Gracefully degrades: when `node:sqlite` is unavailable (Node < 22.5 or
// missing flag) `openActionDb` returns null without throwing so callers
// can fall back to JSON sidecars.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const _require = createRequire(import.meta.url);
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
  duration_ms     INTEGER,
  device_id       TEXT,
  blind_probe_json TEXT
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
export function loadSqlite() {
    try {
        const mod = _require('node:sqlite');
        return mod.DatabaseSync ?? null;
    }
    catch {
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
export function openActionDb(projectRoot, opts = {}) {
    const Ctor = opts.sqliteCtor === undefined ? loadSqlite() : opts.sqliteCtor;
    if (!Ctor)
        return null;
    try {
        const dbPath = join(projectRoot, '.rn-agent', 'state', 'actions.db');
        mkdirSync(dirname(dbPath), { recursive: true });
        const db = new Ctor(dbPath);
        db.exec(SCHEMA);
        // GH #397: additive columns for DBs created before the blind-probe fields.
        // CREATE TABLE IF NOT EXISTS never alters an existing table, so each new
        // column needs an idempotent ALTER — "duplicate column name" is the only
        // expected error and means the column already exists.
        for (const alter of [
            'ALTER TABLE run_records ADD COLUMN device_id TEXT',
            'ALTER TABLE run_records ADD COLUMN blind_probe_json TEXT',
        ]) {
            try {
                db.exec(alter);
            }
            catch (e) {
                if (!String(e).includes('duplicate column name'))
                    throw e;
            }
        }
        const handle = {
            db,
            close: () => db.close(),
            insertRunRecord(actionId, record) {
                db.exec('BEGIN IMMEDIATE');
                try {
                    // Idempotent guard: a just-migrated sidecar already holds this record,
                    // so skip the append when a row for (action_id, ts) is already present.
                    const dup = db
                        .prepare('SELECT 1 FROM run_records WHERE action_id = ? AND ts = ? LIMIT 1')
                        .get(actionId, record.timestamp);
                    if (dup) {
                        db.exec('COMMIT');
                        return;
                    }
                    db.prepare(`INSERT INTO run_records
               (action_id, ts, trigger, status, failure_code, failure_detail,
                transport, auto_repair_json, duration_ms, device_id, blind_probe_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(actionId, record.timestamp, record.trigger, record.status, record.failureCode ?? null, record.failureDetail ?? null, record.transport ?? null, record.autoRepair ? JSON.stringify(record.autoRepair) : null, record.durationMs, record.deviceId ?? null, record.blindProbe ? JSON.stringify(record.blindProbe) : null);
                    // Trim oldest rows beyond cap
                    db.prepare(`DELETE FROM run_records
             WHERE action_id = ?
               AND id NOT IN (
                 SELECT id FROM run_records
                 WHERE action_id = ?
                 ORDER BY id DESC
                 LIMIT ${RUN_HISTORY_MAX}
               )`).run(actionId, actionId);
                    db.exec('COMMIT');
                }
                catch (e) {
                    db.exec('ROLLBACK');
                    throw e;
                }
            },
            insertRepairRecord(actionId, record) {
                db.exec('BEGIN IMMEDIATE');
                try {
                    // Idempotent guard (see insertRunRecord): skip when a row for
                    // (action_id, ts) already exists — the migration-boundary overlap.
                    const dup = db
                        .prepare('SELECT 1 FROM repair_records WHERE action_id = ? AND ts = ? LIMIT 1')
                        .get(actionId, record.timestamp);
                    if (dup) {
                        db.exec('COMMIT');
                        return;
                    }
                    db.prepare(`INSERT INTO repair_records
               (action_id, ts, failure_code, diff_json, duration_ms, agent_reasoning)
             VALUES (?,?,?,?,?,?)`).run(actionId, record.timestamp, record.failureCode, JSON.stringify(record.diff ?? {}), record.durationMs, record.agentReasoning ?? null);
                    // Trim oldest rows beyond cap
                    db.prepare(`DELETE FROM repair_records
             WHERE action_id = ?
               AND id NOT IN (
                 SELECT id FROM repair_records
                 WHERE action_id = ?
                 ORDER BY id DESC
                 LIMIT ${REPAIR_HISTORY_MAX}
               )`).run(actionId, actionId);
                    db.exec('COMMIT');
                }
                catch (e) {
                    db.exec('ROLLBACK');
                    throw e;
                }
            },
            upsertIndex(actionId, fields) {
                db.prepare(`INSERT INTO actions_index
             (id, app_id, path, content_hash, status, revision,
              created_at, updated_at, mtime_baseline, stats_json)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             app_id         = COALESCE(excluded.app_id,         actions_index.app_id),
             path           = COALESCE(excluded.path,           actions_index.path),
             content_hash   = COALESCE(excluded.content_hash,   actions_index.content_hash),
             status         = COALESCE(excluded.status,         actions_index.status),
             revision       = COALESCE(excluded.revision,       actions_index.revision),
             updated_at     = COALESCE(excluded.updated_at,     actions_index.updated_at),
             mtime_baseline = COALESCE(excluded.mtime_baseline, actions_index.mtime_baseline),
             stats_json     = COALESCE(excluded.stats_json,     actions_index.stats_json)`).run(actionId, fields.appId ?? null, fields.path ?? null, fields.contentHash ?? null, fields.status ?? null, fields.revision ?? null, fields.updatedAt ?? null, fields.updatedAt ?? null, fields.mtimeBaseline ?? null, fields.statsJson ?? null);
            },
            loadState(actionId) {
                const idx = db.prepare('SELECT * FROM actions_index WHERE id = ?').get(actionId);
                if (!idx)
                    return null;
                const runRows = db
                    .prepare('SELECT * FROM run_records WHERE action_id = ? ORDER BY id ASC')
                    .all(actionId);
                const repairRows = db
                    .prepare('SELECT * FROM repair_records WHERE action_id = ? ORDER BY id ASC')
                    .all(actionId);
                const runHistory = runRows.map((r) => {
                    const rec = {
                        timestamp: String(r.ts),
                        durationMs: Number(r.duration_ms),
                        status: r.status,
                        trigger: r.trigger,
                    };
                    if (r.failure_code)
                        rec.failureCode = r.failure_code;
                    if (r.failure_detail)
                        rec.failureDetail = String(r.failure_detail);
                    if (r.transport === 'cdp-js')
                        rec.transport = 'cdp-js';
                    if (r.auto_repair_json)
                        rec.autoRepair = JSON.parse(String(r.auto_repair_json));
                    if (r.device_id)
                        rec.deviceId = String(r.device_id);
                    if (r.blind_probe_json) {
                        try {
                            rec.blindProbe = JSON.parse(String(r.blind_probe_json));
                        }
                        catch {
                            /* malformed mirror row — omit the field rather than fail the load */
                        }
                    }
                    return rec;
                });
                const repairHistory = repairRows.map((r) => {
                    const rec = {
                        timestamp: String(r.ts),
                        failureCode: r.failure_code,
                        diff: r.diff_json ? JSON.parse(String(r.diff_json)) : {},
                        durationMs: Number(r.duration_ms),
                    };
                    if (r.agent_reasoning)
                        rec.agentReasoning = String(r.agent_reasoning);
                    return rec;
                });
                // Stats come from the stored stats_json — NOT recomputed from capped history.
                const stats = idx.stats_json
                    ? JSON.parse(String(idx.stats_json))
                    : { totalRuns: 0, successCount: 0, failureCount: 0, avgDurationMs: 0 };
                return {
                    schemaVersion: 1,
                    revision: Number(idx.revision) || 1,
                    updatedAt: String(idx.updated_at ?? new Date(0).toISOString()),
                    lastSeenMtimeMs: Number(idx.mtime_baseline) || 0,
                    runHistory,
                    repairHistory,
                    stats,
                };
            },
            recentRepairCount(actionId, sinceIso) {
                const row = db
                    .prepare(`SELECT COUNT(*) as cnt FROM repair_records
           WHERE action_id = ? AND ts >= ?`)
                    .get(actionId, sinceIso);
                return row.cnt;
            },
            migrateSidecars() {
                const stateDir = join(projectRoot, '.rn-agent', 'state');
                if (!existsSync(stateDir))
                    return { migrated: 0 };
                let migrated = 0;
                for (const f of readdirSync(stateDir)) {
                    if (!f.endsWith('.state.json'))
                        continue;
                    const id = f.replace(/\.state\.json$/, '');
                    const exists = db.prepare('SELECT 1 FROM actions_index WHERE id = ?').get(id);
                    if (exists)
                        continue;
                    try {
                        const parsed = JSON.parse(readFileSync(join(stateDir, f), 'utf8'));
                        if (parsed?.schemaVersion !== 1)
                            continue;
                        // Validate shape before importing: malformed arrays must not leave
                        // a partial mirror (index row without history rows).
                        if (!Array.isArray(parsed.runHistory) || !Array.isArray(parsed.repairHistory)) {
                            continue;
                        }
                        // Insert history rows FIRST so that "index row exists" reliably
                        // means "fully migrated". Any throw mid-import leaves no index row
                        // and the next open retries cleanly.
                        for (const r of parsed.runHistory) {
                            handle.insertRunRecord(id, r);
                        }
                        for (const r of parsed.repairHistory) {
                            handle.insertRepairRecord(id, r);
                        }
                        handle.upsertIndex(id, {
                            revision: parsed.revision,
                            statsJson: JSON.stringify(parsed.stats),
                            mtimeBaseline: parsed.lastSeenMtimeMs,
                            updatedAt: parsed.updatedAt,
                        });
                        migrated++;
                    }
                    catch {
                        // skip corrupt sidecar — never throw
                    }
                }
                return { migrated };
            },
        };
        return handle;
    }
    catch {
        return null;
    }
}
// ─── History cap constants (mirrors HISTORY_LIMITS from reusable-action.ts) ──
// Inlined here to avoid a runtime import cycle; kept in sync via the type
// import at the top which will error at compile time if the shapes diverge.
const RUN_HISTORY_MAX = 50;
const REPAIR_HISTORY_MAX = 25;
