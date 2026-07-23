import { chmodSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

interface PreparedStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface AuthorityDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
}

export type AuthorityDatabaseCtor = new (path: string) => AuthorityDatabase;

export interface AuthorityStore {
  database: AuthorityDatabase;
  secureFiles(): void;
  close(): void;
}

export interface AuthorityStoreUnavailableDiagnostic {
  available: false;
  code: 'AUTHORITY_STORE_UNAVAILABLE';
  reason: string;
}

export type AuthorityStoreDiagnostic = { available: true } | AuthorityStoreUnavailableDiagnostic;

export class AuthorityStoreUnavailableError extends Error {
  readonly code = 'AUTHORITY_STORE_UNAVAILABLE';

  constructor(reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'AuthorityStoreUnavailableError';
  }
}

function loadAuthoritySqlite(): AuthorityDatabaseCtor | null {
  try {
    const sqlite = require('node:sqlite') as { DatabaseSync?: AuthorityDatabaseCtor };
    return sqlite.DatabaseSync ?? null;
  } catch {
    return null;
  }
}

function assertPrivateDirectory(path: string): void {
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

function secureDatabaseFiles(path: string): void {
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
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  }
}

export function probeAuthorityStore(
  options: { sqliteCtor?: AuthorityDatabaseCtor | null } = {},
): AuthorityStoreDiagnostic {
  const ctor = options.sqliteCtor === undefined ? loadAuthoritySqlite() : options.sqliteCtor;
  return ctor
    ? { available: true }
    : {
        available: false,
        code: 'AUTHORITY_STORE_UNAVAILABLE',
        reason: 'node:sqlite could not be loaded by this Node runtime',
      };
}

export function openAuthorityStore(
  path: string,
  options: { sqliteCtor?: AuthorityDatabaseCtor | null } = {},
): AuthorityStore {
  const ctor = options.sqliteCtor === undefined ? loadAuthoritySqlite() : options.sqliteCtor;
  if (!ctor) {
    throw new AuthorityStoreUnavailableError(
      'node:sqlite could not be loaded by this Node runtime',
    );
  }

  try {
    assertPrivateDirectory(dirname(path));
    try {
      const existing = lstatSync(path);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error('authority database path is not a regular file');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
  } catch (cause) {
    throw new AuthorityStoreUnavailableError('authority registry could not be opened', { cause });
  }
}
