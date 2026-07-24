import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '../nav-graph/storage.js';
import { isValidBundleId } from '../domain/maestro-validator.js';
import { sessionStateDirectory } from '../session/runtime-paths.js';
/**
 * GH #523 sub-2: last-connected bundleId, persisted per project + platform.
 *
 * The module-scope cache in restart.ts dies with the bridge worker, so the
 * first `cdp_restart hardReset:true` after a bridge restart used to degrade
 * to a soft reset ("skip-simctl:no-bundleId-on-connectedTarget-or-cache")
 * even though the bridge knew the bundleId earlier in the session. This
 * store survives worker restarts at
 * `<projectRoot>/.rn-agent/state/last-bundle-ids.json`.
 *
 * Both directions are hardened: writes refuse invalid bundleIds, reads
 * re-validate (the file is user-editable, untrusted state that would reach
 * `xcrun simctl` argv).
 */
const STATE_FILE_NAME = 'last-bundle-ids.json';
function stateFilePath(projectRoot) {
    return join(sessionStateDirectory(projectRoot), STATE_FILE_NAME);
}
function readStore(projectRoot) {
    try {
        const raw = readFileSync(stateFilePath(projectRoot), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        /* missing or corrupt file → empty store */
    }
    return {};
}
/**
 * Best-effort write of the last-connected bundleId. Never throws — a failed
 * persist only costs the disk fallback tier, it must not fail the restart
 * that triggered it.
 */
export function persistLastBundleId(platform, bundleId, projectRoot = findProjectRoot()) {
    if (!projectRoot || !isValidBundleId(bundleId))
        return;
    try {
        const store = readStore(projectRoot);
        store[platform.toLowerCase()] = { bundleId, updatedAt: new Date().toISOString() };
        mkdirSync(sessionStateDirectory(projectRoot), { recursive: true });
        writeFileSync(stateFilePath(projectRoot), JSON.stringify(store, null, 2));
    }
    catch {
        /* best-effort */
    }
}
/**
 * Read the persisted bundleId for a platform, or null. Invalid entries are
 * rejected here (defense-in-depth — restart.ts re-validates anything that
 * reaches the simctl path).
 */
export function loadPersistedBundleId(platform, projectRoot = findProjectRoot()) {
    if (!projectRoot)
        return null;
    const entry = readStore(projectRoot)[platform.toLowerCase()];
    if (!entry || typeof entry.bundleId !== 'string')
        return null;
    return isValidBundleId(entry.bundleId) ? entry.bundleId : null;
}
