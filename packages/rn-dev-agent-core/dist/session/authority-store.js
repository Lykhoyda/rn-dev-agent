import { chmodSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const INITIALIZATION_WAIT = new Int32Array(new SharedArrayBuffer(4));
const INITIALIZATION_TIMEOUT_MS = 1_000;
const DATABASE_OPERATION_TIMEOUT_MS = 100;
export class AuthorityStoreUnavailableError extends Error {
    code = 'AUTHORITY_STORE_UNAVAILABLE';
    constructor(reason, options) {
        super(reason, options);
        this.name = 'AuthorityStoreUnavailableError';
    }
}
function loadAuthoritySqlite() {
    try {
        const sqlite = require('node:sqlite');
        return sqlite.DatabaseSync ?? null;
    }
    catch {
        return null;
    }
}
function assertPrivateDirectory(path) {
    mkdirSync(path, { mode: 0o700, recursive: true });
    const link = lstatSync(path);
    if (link.isSymbolicLink() || !link.isDirectory()) {
        throw new Error('authority state root must be a real directory');
    }
    const stat = statSync(path);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error('authority state root is not owned by the current user');
    }
    chmodSync(path, 0o700);
}
function secureDatabaseFiles(path) {
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
        try {
            const link = lstatSync(candidate);
            if (link.isSymbolicLink() || !link.isFile()) {
                throw new Error('authority database path is not a regular file');
            }
            const stat = statSync(candidate);
            if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
                throw new Error('authority database is not owned by the current user');
            }
            chmodSync(candidate, 0o600);
        }
        catch (error) {
            const code = error.code;
            if (code !== 'ENOENT')
                throw error;
        }
    }
}
function runInitialization(operation) {
    runWithBusyRetry(operation, INITIALIZATION_TIMEOUT_MS);
}
function runWithBusyRetry(operation, timeoutMs = DATABASE_OPERATION_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            return operation();
        }
        catch (error) {
            const code = error.code;
            const message = error instanceof Error ? error.message : '';
            if (code !== 'SQLITE_BUSY' && !/database is (?:locked|busy)/i.test(message))
                throw error;
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                throw error;
            Atomics.wait(INITIALIZATION_WAIT, 0, 0, Math.min(25, remaining));
        }
    }
}
function retryingDatabase(database) {
    return {
        close: () => database.close(),
        exec: (sql) => runWithBusyRetry(() => database.exec(sql)),
        prepare: (sql) => {
            const statement = database.prepare(sql);
            return {
                get: (...params) => runWithBusyRetry(() => statement.get(...params)),
                run: (...params) => runWithBusyRetry(() => statement.run(...params)),
                all: (...params) => runWithBusyRetry(() => statement.all(...params)),
            };
        },
    };
}
export function probeAuthorityStore(options = {}) {
    const ctor = options.sqliteCtor === undefined ? loadAuthoritySqlite() : options.sqliteCtor;
    return ctor
        ? { available: true }
        : {
            available: false,
            code: 'AUTHORITY_STORE_UNAVAILABLE',
            reason: 'node:sqlite could not be loaded by this Node runtime',
        };
}
export function openAuthorityStore(path, options = {}) {
    const ctor = options.sqliteCtor === undefined ? loadAuthoritySqlite() : options.sqliteCtor;
    if (!ctor) {
        throw new AuthorityStoreUnavailableError('node:sqlite could not be loaded by this Node runtime');
    }
    let database = null;
    try {
        assertPrivateDirectory(dirname(path));
        try {
            const existing = lstatSync(path);
            if (existing.isSymbolicLink() || !existing.isFile()) {
                throw new Error('authority database path is not a regular file');
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        const rawDatabase = new ctor(path);
        const openedDatabase = retryingDatabase(rawDatabase);
        database = openedDatabase;
        secureDatabaseFiles(path);
        runInitialization(() => openedDatabase.exec(`
        PRAGMA busy_timeout=50;
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS authority_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO authority_meta(key, value)
        VALUES ('schema_version', '1')
        ON CONFLICT(key) DO NOTHING;
      `));
        secureDatabaseFiles(path);
        return {
            database: openedDatabase,
            secureFiles: () => secureDatabaseFiles(path),
            close: () => {
                let failure;
                try {
                    secureDatabaseFiles(path);
                }
                catch (error) {
                    failure = error;
                }
                try {
                    openedDatabase.close();
                }
                catch (error) {
                    failure ??= error;
                }
                try {
                    secureDatabaseFiles(path);
                }
                catch (error) {
                    failure ??= error;
                }
                if (failure)
                    throw failure;
            },
        };
    }
    catch (cause) {
        try {
            database?.close();
        }
        catch { }
        throw new AuthorityStoreUnavailableError('authority registry could not be opened', { cause });
    }
}
