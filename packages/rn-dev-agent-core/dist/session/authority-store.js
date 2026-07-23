import { chmodSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
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
        const database = new ctor(path);
        secureDatabaseFiles(path);
        database.exec(`
      PRAGMA busy_timeout=5;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS authority_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO authority_meta(key, value)
      VALUES ('schema_version', '1')
      ON CONFLICT(key) DO NOTHING;
    `);
        secureDatabaseFiles(path);
        return {
            database,
            secureFiles: () => secureDatabaseFiles(path),
            close: () => {
                secureDatabaseFiles(path);
                database.close();
                secureDatabaseFiles(path);
            },
        };
    }
    catch (cause) {
        throw new AuthorityStoreUnavailableError('authority registry could not be opened', { cause });
    }
}
