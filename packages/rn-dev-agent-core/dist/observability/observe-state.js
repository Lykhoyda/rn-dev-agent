import { join } from 'node:path';
import { getStateDir, writeJsonStateFileAtomic, readJsonStateFile, deleteStateFile, } from '../util/secure-state-file.js';
import { findProjectRoot } from '../nav-graph/storage.js';
export function observeStatePath(projectRoot) {
    const safe = projectRoot.replace(/[^A-Za-z0-9._-]/g, '_');
    return join(getStateDir(), 'observe', `${safe}.json`);
}
export function writeObserveState(url, port, projectRoot = findProjectRoot(), now = () => new Date()) {
    try {
        if (!projectRoot)
            return;
        const state = {
            url,
            port,
            pid: process.pid,
            projectRoot,
            startedAt: now().toISOString(),
        };
        writeJsonStateFileAtomic(observeStatePath(projectRoot), state);
    }
    catch {
        /* best-effort — never fail the caller */
    }
}
export function removeObserveState(projectRoot = findProjectRoot()) {
    try {
        if (!projectRoot)
            return;
        const p = observeStatePath(projectRoot);
        const existing = readJsonStateFile(p);
        // A different pid means another live session overwrote the file after we
        // started (port-collision fallback scenario) — their record, not ours.
        if (existing && existing.pid !== process.pid)
            return;
        deleteStateFile(p);
    }
    catch {
        /* best-effort */
    }
}
