// Task 4 — backend-selecting dual-write facade between the action-store/tool
// layer and `action-db.ts`.
//
// Phase 1 is ADDITIVE dual-write:
//   - The JSON sidecar stays AUTHORITATIVE (the read source) — `loadOrInitState`
//     reads only the sidecar here. The DB read path flips on in Phase 2.
//   - The SQLite DB is a populated MIRROR + read-only reporting surface.
//   - The DB mirror is BEST-EFFORT: a mirror failure NEVER throws and never
//     affects the authoritative sidecar write (preserves the #101 pair-write
//     guarantee). Mirror errors are logged at debug/info and swallowed.
//
// One DB handle is opened per `projectRoot` and cached. The handle is opened
// lazily (and `migrateSidecars()` runs exactly once) on first WRITE use, so
// `storeMode()` can report the backend WITHOUT creating/migrating the DB.
import { basename, dirname, sep } from 'node:path';
import { logger } from '../logger.js';
import { openActionDb, loadSqlite } from './action-db.js';
import { loadOrInitSidecar, saveSidecar } from './sidecar-io.js';
const TAG = 'action-state-store';
// ─── Test seam ──────────────────────────────────────────────────────────────
// `undefined` ⇒ use the real `loadSqlite()`; `null` ⇒ force degradation;
// any value ⇒ pass through to openActionDb as the DatabaseSync ctor override.
let sqliteCtorOverride;
/**
 * Test seam. Sets the override passed through to `openActionDb`, and clears
 * the per-root handle cache so the next call re-resolves against the override.
 */
export function __setSqliteCtorForTest(ctor) {
    // `null` is a meaningful override (force degraded); only `undefined` means
    // "no override" (fall through to the real loadSqlite()).
    sqliteCtorOverride = ctor;
    closeActionStoresForTest();
}
// ─── Per-root handle cache ────────────────────────────────────────────────────
// A present entry of `null` means "we attempted to open and it failed" (a
// failed-open marker) — distinct from "never attempted" (no entry). This lets
// `storeMode` distinguish degraded:open-failed from not-yet-opened, and lets
// `resetActionStore` clear the marker so a later retry can recover.
const dbCache = new Map();
/** Whether the sqlite ctor is available at all (honors the test override). */
function sqliteAvailable() {
    if (sqliteCtorOverride === undefined)
        return loadSqlite() !== null;
    return sqliteCtorOverride !== null;
}
/**
 * Lazily open (and migrate sidecars exactly once on) the DB for `projectRoot`,
 * caching the handle. Caches `null` on open failure (a failed-open marker) so
 * we don't retry the open on every call — `resetActionStore` clears it.
 *
 * Returns `null` when sqlite is unavailable or the open failed.
 */
function dbFor(projectRoot) {
    if (dbCache.has(projectRoot))
        return dbCache.get(projectRoot) ?? null;
    const handle = sqliteCtorOverride === undefined
        ? openActionDb(projectRoot)
        : openActionDb(projectRoot, { sqliteCtor: sqliteCtorOverride });
    if (handle) {
        try {
            handle.migrateSidecars();
        }
        catch (err) {
            // A migration failure must not wedge the mirror — log + carry on with
            // the open handle (sidecars remain authoritative regardless).
            logger.debug(TAG, `migrateSidecars failed for ${projectRoot}: ${String(err)}`);
        }
    }
    dbCache.set(projectRoot, handle);
    return handle;
}
const idOf = (yamlFilePath) => basename(yamlFilePath).replace(/\.ya?ml$/i, '');
/**
 * READ-ONLY 3-way backend detector. MUST NOT open or migrate the DB.
 *
 *   - sqlite ctor unavailable           → 'degraded:sqlite-unavailable'
 *   - a cached failed-open marker exists → 'degraded:open-failed'
 *   - sqlite available (cached healthy
 *     handle OR not-yet-opened)          → 'sqlite'
 */
export function storeMode(projectRoot) {
    if (!sqliteAvailable())
        return 'degraded:sqlite-unavailable';
    if (dbCache.has(projectRoot) && dbCache.get(projectRoot) == null) {
        return 'degraded:open-failed';
    }
    return 'sqlite';
}
/**
 * Phase 1: reads from the AUTHORITATIVE sidecar. The DB is not read here — that
 * flips in Phase 2. Returns a fresh state (seeded from the YAML mtime) when no
 * sidecar exists yet, so the first auto-repair won't false-alarm on a human edit.
 */
export function loadOrInitState(yamlFilePath, _projectRoot) {
    return loadOrInitSidecar(yamlFilePath);
}
/**
 * Dual-write. The sidecar is written FIRST (authoritative, never swallowed),
 * then the DB mirror is updated BEST-EFFORT (swallowed on any error).
 *
 * The DB mirror APPENDS only the new run/repair record(s) supplied — it does
 * NOT re-sync whole history (that would duplicate rows). The index row is
 * upserted with COALESCE semantics so omitted meta fields preserve priors.
 */
export function persist(args) {
    const { yamlFilePath, projectRoot, state, newRunRecord, newRepairRecord, meta } = args;
    // 1. Authoritative — preserves the #101 pair-write guarantee. NOT swallowed.
    saveSidecar(yamlFilePath, state);
    // 2. Best-effort DB mirror — NEVER throws. The `path` defaults to the YAML
    //    path so the index row points at the action file even when the caller
    //    omits meta.path (matches the legacy persist() behaviour).
    mirrorToDb({
        yamlFilePath,
        state,
        newRunRecord,
        newRepairRecord,
        meta: { path: yamlFilePath, ...meta },
        projectRoot,
    });
}
/**
 * Task 5 (A2/A3/A5): SIDECAR-LESS DB mirror. The DB is a best-effort mirror —
 * this writes ONLY to the DB and NEVER throws. It deliberately does NOT call
 * `saveSidecar`, so it is safe to call from authoritative write paths that
 * already wrote the sidecar (e.g. `saveAction`'s #101 atomic pair-write).
 * Calling `saveSidecar` there would double-write the sidecar and break the
 * #101 atomicity guarantee.
 *
 * `projectRoot` is derived from `yamlFilePath` when not supplied: the
 * `.rn-agent/actions/<id>.yaml` convention means the project root is the
 * `.rn-agent` directory's parent. `persist()` passes the already-resolved
 * `projectRoot` through directly.
 *
 * The index row is upserted (COALESCE semantics — omitted meta preserves
 * priors); a supplied run/repair record is APPENDED idempotently. The append
 * is a no-op when a row for `(action_id, ts)` already exists — this absorbs the
 * migration-boundary overlap: `dbFor()` lazily runs `migrateSidecars()` on the
 * first open, importing the authoritative sidecar history (which, in the
 * saveSidecar-first ordering, already contains the record this mirror is about
 * to append), so a naive append would double-count the newest record.
 */
export function mirrorToDb(opts) {
    const { yamlFilePath, state, newRunRecord, newRepairRecord, meta } = opts;
    try {
        const projectRoot = opts.projectRoot ?? projectRootFromYaml(yamlFilePath);
        if (!projectRoot)
            return;
        const handle = dbFor(projectRoot);
        if (!handle)
            return;
        const actionId = idOf(yamlFilePath);
        handle.upsertIndex(actionId, {
            appId: meta?.appId,
            path: meta?.path,
            contentHash: meta?.contentHash,
            status: meta?.status,
            revision: state.revision,
            statsJson: JSON.stringify(state.stats),
            mtimeBaseline: state.lastSeenMtimeMs,
            updatedAt: state.updatedAt,
        });
        if (newRunRecord)
            handle.insertRunRecord(actionId, newRunRecord);
        if (newRepairRecord)
            handle.insertRepairRecord(actionId, newRepairRecord);
    }
    catch (err) {
        logger.debug(TAG, `DB mirror failed for ${idOf(yamlFilePath)} (authoritative write succeeded): ${String(err)}`);
    }
}
/**
 * Derive the project root from a `.rn-agent/actions/<id>.yaml` path: walk up
 * to the `.rn-agent` directory's parent. Returns null when the path doesn't
 * sit under an `.rn-agent/actions/` segment (synthetic/inline-yaml paths), so
 * the mirror is skipped rather than writing to a wrong root.
 */
function projectRootFromYaml(yamlFilePath) {
    const actionsDir = dirname(yamlFilePath); // .../.rn-agent/actions
    const rnAgentDir = dirname(actionsDir); // .../.rn-agent
    const root = dirname(rnAgentDir); // project root
    if (basename(actionsDir) !== 'actions' || basename(rnAgentDir) !== '.rn-agent') {
        return null;
    }
    // Guard against a degenerate path (e.g. `actions.yaml` at fs root) yielding
    // an empty / separator-only root.
    if (!root || root === sep)
        return null;
    return root;
}
// ─── Lifecycle (A7) ───────────────────────────────────────────────────────────
/**
 * Close + evict the cached handle for `projectRoot` (clearing any failed-open
 * marker) so a deleted/recreated `.db` can be recovered on the next use.
 */
export function resetActionStore(projectRoot) {
    const handle = dbCache.get(projectRoot);
    if (handle) {
        try {
            handle.close();
        }
        catch (err) {
            logger.debug(TAG, `close failed for ${projectRoot}: ${String(err)}`);
        }
    }
    dbCache.delete(projectRoot);
}
/** Close ALL cached handles and clear the cache. Test-only convenience. */
export function closeActionStoresForTest() {
    for (const handle of dbCache.values()) {
        if (!handle)
            continue;
        try {
            handle.close();
        }
        catch {
            /* best-effort */
        }
    }
    dbCache.clear();
}
