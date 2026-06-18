import { join } from 'node:path';
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { assertValidActionId } from './path-safety.js';
import { e2eRunsDirFor } from './e2e-run.js';
export const TERMINAL_STATUSES = new Set([
    'done',
    'failed',
    'cancelled',
    'interrupted',
]);
function requestsDir(projectRoot) {
    return join(e2eRunsDirFor(projectRoot), 'requests');
}
function requestPath(projectRoot, runId) {
    assertValidActionId(runId, 'e2e-run-request');
    return join(requestsDir(projectRoot), `${runId}.json`);
}
export function writeRequest(projectRoot, req) {
    const file = requestPath(projectRoot, req.runId);
    mkdirSync(requestsDir(projectRoot), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(req, null, 2), 'utf8');
    renameSync(tmp, file);
}
export function loadRequest(projectRoot, runId) {
    const file = requestPath(projectRoot, runId);
    if (!existsSync(file))
        return null;
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}
export function updateRequest(projectRoot, runId, patch) {
    const cur = loadRequest(projectRoot, runId);
    if (!cur)
        return null;
    const next = { ...cur, ...patch, runId };
    writeRequest(projectRoot, next);
    return next;
}
export function listRequests(projectRoot) {
    const dir = requestsDir(projectRoot);
    if (!existsSync(dir))
        return [];
    const out = [];
    for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json'))
            continue;
        const r = loadRequest(projectRoot, f.replace(/\.json$/, ''));
        if (r)
            out.push(r);
    }
    return out;
}
export function recoverInterruptedRequests(projectRoot, isPidAlive, now) {
    const affected = [];
    for (const r of listRequests(projectRoot)) {
        if (TERMINAL_STATUSES.has(r.status))
            continue;
        if (isPidAlive(r.pid))
            continue;
        writeRequest(projectRoot, { ...r, status: 'interrupted', updatedAt: now().toISOString() });
        affected.push(r.runId);
    }
    return affected.sort();
}
