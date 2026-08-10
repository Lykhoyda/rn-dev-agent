import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { join, resolve } from 'node:path';
import { getStateDir } from '../util/secure-state-file.js';
function fail(code, detail) {
    throw new Error(`${code}: ${detail}`);
}
function ensurePrivateDirectory(path) {
    try {
        mkdirSync(path, { recursive: true, mode: 0o700 });
        const link = lstatSync(path);
        const stat = statSync(path);
        if (link.isSymbolicLink() ||
            !link.isDirectory() ||
            (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
            fail('AUTHORITY_STATE_ROOT_UNSAFE', 'state directory is not private and user-owned');
        }
        chmodSync(path, 0o700);
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('AUTHORITY_STATE_ROOT_UNSAFE')) {
            throw error;
        }
        fail('AUTHORITY_STATE_ROOT_UNSAFE', error instanceof Error ? error.message : 'state directory could not be secured');
    }
}
function sessionDirectory(layout, sessionId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
        fail('INVALID_SESSION_ID', 'session identifier is not path-safe');
    }
    const path = join(layout.sessions, sessionId);
    ensurePrivateDirectory(path);
    return path;
}
function authorityStateLayout(stateDir) {
    const resolvedStateDir = resolve(stateDir);
    const root = join(resolvedStateDir, 'v2');
    return {
        root,
        registry: join(root, 'registry.sqlite3'),
        sessions: join(root, 'sessions'),
        runners: join(root, 'runner'),
        observe: join(root, 'observe'),
        migrations: join(root, 'migrations'),
    };
}
export function createAuthorityStateLayout(stateDir = getStateDir()) {
    const layout = authorityStateLayout(stateDir);
    ensurePrivateDirectory(resolve(stateDir));
    const root = layout.root;
    ensurePrivateDirectory(root);
    for (const path of [layout.sessions, layout.runners, layout.observe, layout.migrations]) {
        ensurePrivateDirectory(path);
    }
    return layout;
}
export function openAuthorityStateLayout(stateDir) {
    const layout = authorityStateLayout(stateDir);
    try {
        const registry = lstatSync(layout.registry);
        if (registry.isSymbolicLink() || !registry.isFile()) {
            fail('AUTHORITY_STATE_HOME_UNKNOWN', 'requested state home has no regular authority registry');
        }
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('AUTHORITY_STATE_HOME_UNKNOWN')) {
            throw error;
        }
        if (error.code === 'ENOENT') {
            fail('AUTHORITY_STATE_HOME_UNKNOWN', 'requested state home has no authority registry; refusing to initialize an empty registry');
        }
        fail('AUTHORITY_STATE_HOME_UNKNOWN', error instanceof Error ? error.message : 'requested authority registry is unavailable');
    }
    ensurePrivateDirectory(resolve(stateDir));
    ensurePrivateDirectory(layout.root);
    for (const path of [layout.sessions, layout.runners, layout.observe, layout.migrations]) {
        ensurePrivateDirectory(path);
    }
    return layout;
}
export function getBoundDirectoryJournalKey(layout = createAuthorityStateLayout()) {
    const path = join(layout.root, 'bound-directory.key');
    const temporary = join(layout.root, `.bound-directory.${randomUUID()}.key`);
    try {
        try {
            writeFileSync(temporary, randomBytes(32), { flag: 'wx', mode: 0o600, flush: true });
            try {
                linkSync(temporary, path);
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
            }
        }
        finally {
            rmSync(temporary, { force: true });
        }
        const link = lstatSync(path);
        const stat = statSync(path);
        const key = readFileSync(path);
        if (link.isSymbolicLink() ||
            !link.isFile() ||
            key.length !== 32 ||
            (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
            fail('AUTHORITY_STATE_ROOT_UNSAFE', 'bound-directory journal key is invalid');
        }
        chmodSync(path, 0o600);
        return key.toString('base64url');
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('AUTHORITY_STATE_ROOT_UNSAFE')) {
            throw error;
        }
        fail('AUTHORITY_STATE_ROOT_UNSAFE', error instanceof Error ? error.message : 'bound-directory journal key is unavailable');
    }
}
function writeSessionJson(layout, sessionId, filename, value) {
    const directory = sessionDirectory(layout, sessionId);
    const path = join(directory, filename);
    try {
        const existing = lstatSync(path);
        if (existing.isSymbolicLink() || !existing.isFile()) {
            fail('AUTHORITY_STATE_ROOT_UNSAFE', `${filename} is not a regular file`);
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const temporary = join(directory, `.${filename}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    return path;
}
export function writeSessionSecret(layout, sessionId, value) {
    return writeSessionJson(layout, sessionId, 'secret.json', value);
}
export function writeSessionPublicReceipt(layout, sessionId, value) {
    return writeSessionJson(layout, sessionId, 'public-receipt.json', value);
}
export function sessionRuntimeDirectory(layout, sessionId) {
    const path = join(sessionDirectory(layout, sessionId), 'runtime');
    ensurePrivateDirectory(path);
    return path;
}
